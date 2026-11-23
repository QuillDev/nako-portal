"""CBOR binary decoding and WebAuthn registration/assertion payload verification."""

from __future__ import annotations

import hashlib
import json
import struct

import pytest
from conftest import ORIGIN
from conftest import cbor as cbor_encode
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from portal import cbor, webauthn
from portal.cbor import CborError
from portal.webauthn import WebAuthnError

RP_ID = "portal.test"
CHALLENGE = b"0123456789abcdef0123456789abcdef"


def _client_data(ceremony: str, *, challenge=CHALLENGE, origin=ORIGIN, cross_origin=False) -> bytes:
    payload = {"type": ceremony, "challenge": webauthn.b64url(challenge), "origin": origin}
    if cross_origin:
        payload["crossOrigin"] = True
    return json.dumps(payload).encode()


def _auth_data(rp_id=RP_ID, flags=0x05, count=1, attested=b"") -> bytes:
    return hashlib.sha256(rp_id.encode()).digest() + bytes([flags]) + count.to_bytes(4, "big") + attested


def _rsa_cose(key) -> bytes:
    pub = key.public_key().public_numbers()
    n_bytes = pub.n.to_bytes((pub.n.bit_length() + 7) // 8, "big")
    e_bytes = pub.e.to_bytes((pub.e.bit_length() + 7) // 8, "big")
    return cbor_encode({1: 3, 3: webauthn.RS256, -1: n_bytes, -2: e_bytes})


# --- CBOR ---


def test_cbor_decodes_supported_types_and_widths():
    payload = {
        "u0": 0,
        "u8": 250,
        "u16": 60_000,
        "u32": 100_000,
        "u64": (1 << 40) + 7,
        "neg": -257,
        "bytes": b"\x00\xff",
        "text": "héllo",
        "list": [True, False, 1, -1],
    }
    assert cbor.loads(cbor_encode(payload)) == payload

    # Null (simple 22), undefined (simple 23), float16, float32, float64.
    assert cbor.loads(bytes([0xF6])) is None
    assert cbor.loads(bytes([0xF7])) is None
    assert cbor.loads(bytes([0xF9]) + struct.pack(">e", 1.5)) == pytest.approx(1.5)
    assert cbor.loads(bytes([0xFA]) + struct.pack(">f", 3.25)) == pytest.approx(3.25)
    assert cbor.loads(bytes([0xFB]) + struct.pack(">d", -42.125)) == pytest.approx(-42.125)

    # Streaming decode returns exact offset past the item.
    two = cbor_encode(42) + cbor_encode("next")
    first, pos = cbor.decode(two, 0)
    second, end = cbor.decode(two, pos)
    assert (first, second, end) == (42, "next", len(two))


@pytest.mark.parametrize("raw", [
    b"",
    bytes([0x18]),  # truncated 1-byte uint
    bytes([0x19, 0x01]),  # truncated 2-byte uint
    bytes([0x45, 0x01, 0x02]),  # truncated byte string
    bytes([0x63, 0x61]),  # truncated text string
    bytes([0x62, 0xFF, 0xFE]),  # invalid UTF-8 text string
    bytes([0xA1, 0x80, 0x01]),  # unhashable array map key
    bytes([0xA1, 0xA0, 0x01]),  # unhashable map key
    bytes([0x5F, 0xFF]),  # indefinite-length byte string
    bytes([0xC0, 0x00]),  # unsupported major type 6 (tag)
    bytes([0xF8, 0x20]),  # unsupported simple value
    bytes([0xF9, 0x3C]),  # truncated float16
    bytes([0xFA, 0x40, 0x00]),  # truncated float32
    bytes([0xFB, 0x40, 0x00, 0x00, 0x00]),  # truncated float64
    cbor_encode(1) + b"\x00",  # trailing bytes
    bytes([0x81]) * 40 + bytes([0x00]),  # excessive nesting
])
def test_cbor_rejects_malformed_inputs_with_cbor_error(raw):
    with pytest.raises(CborError):
        cbor.loads(raw)


# --- WebAuthn ---


def test_rs256_registration_and_assertion_lifecycle():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cid = b"rsa-cred-12345678"
    cose = _rsa_cose(key)
    attested = b"\x00" * 16 + len(cid).to_bytes(2, "big") + cid + cose
    auth_data = _auth_data(flags=0x45, count=0, attested=attested)
    att_obj = cbor_encode({"fmt": "none", "attStmt": {}, "authData": auth_data})

    reg = webauthn.verify_registration(
        client_data_json=_client_data("webauthn.create"),
        attestation_object=att_obj,
        challenge=CHALLENGE,
        origin=ORIGIN,
        rp_id=RP_ID,
    )
    assert reg.credential_id == cid
    assert reg.cose_key == cose
    assert reg.sign_count == 0

    # Both zero sign counts are allowed (authenticators that don't increment counters).
    def assert_with(count, *, bad_sig=False):
        cd = _client_data("webauthn.get")
        ad = _auth_data(flags=0x05, count=count)
        sig = key.sign(ad + hashlib.sha256(cd).digest(), padding.PKCS1v15(), hashes.SHA256())
        if bad_sig:
            sig = bytes([sig[0] ^ 0xFF]) + sig[1:]
        return webauthn.verify_assertion(
            client_data_json=cd,
            authenticator_data=ad,
            signature=sig,
            challenge=CHALLENGE,
            origin=ORIGIN,
            rp_id=RP_ID,
            cose_key=reg.cose_key,
            stored_sign_count=0 if count == 0 else count - 1,
        )

    assert assert_with(0) == 0
    assert assert_with(2) == 2
    with pytest.raises(WebAuthnError, match="bad signature"):
        assert_with(3, bad_sig=True)


def test_webauthn_rejects_malformed_payloads_and_flags():
    with pytest.raises(WebAuthnError, match="too short"):
        webauthn.parse_auth_data(b"\x00" * 36)

    with pytest.raises(WebAuthnError, match="attested credential data too short"):
        webauthn.parse_auth_data(_auth_data(flags=0x45, attested=b"\x00" * 10))

    # Truncated credential id.
    short_cid = b"\x00" * 16 + (20).to_bytes(2, "big") + b"short"
    with pytest.raises(WebAuthnError, match="truncated"):
        webauthn.parse_auth_data(_auth_data(flags=0x45, attested=short_cid))

    # Malformed CBOR in credential public key raises WebAuthnError (not raw CborError/struct.error).
    bad_cose = b"\x00" * 16 + (4).to_bytes(2, "big") + b"1234" + bytes([0xF9, 0x3C])
    with pytest.raises(WebAuthnError, match="malformed credential public key"):
        webauthn.parse_auth_data(_auth_data(flags=0x45, attested=bad_cose))

    # Non-map COSE key.
    list_cose = b"\x00" * 16 + (4).to_bytes(2, "big") + b"1234" + cbor_encode([1, 2])
    with pytest.raises(WebAuthnError, match="not a COSE map"):
        webauthn.parse_auth_data(_auth_data(flags=0x45, attested=list_cose))

    # Bad key shapes.
    with pytest.raises(WebAuthnError, match="bad EC2"):
        webauthn.public_key_from_cose({1: 2, 3: webauthn.ES256, -1: 1, -2: b"short", -3: b"short"})
    with pytest.raises(WebAuthnError, match="bad RSA"):
        webauthn.public_key_from_cose({1: 3, 3: webauthn.RS256, -1: "not-bytes", -2: b"\x01"})
    with pytest.raises(WebAuthnError, match="unsupported key type"):
        webauthn.public_key_from_cose({1: 1, 3: -8})

    # Bad clientDataJSON checks.
    att = cbor_encode({"fmt": "none", "attStmt": {}, "authData": _auth_data(flags=0x05)})
    with pytest.raises(WebAuthnError, match="not JSON"):
        webauthn.verify_registration(client_data_json=b"{bad", attestation_object=att, challenge=CHALLENGE, origin=ORIGIN, rp_id=RP_ID)
    with pytest.raises(WebAuthnError, match="wrong ceremony"):
        webauthn.verify_registration(client_data_json=_client_data("webauthn.get"), attestation_object=att, challenge=CHALLENGE, origin=ORIGIN, rp_id=RP_ID)
    with pytest.raises(WebAuthnError, match="cross-origin"):
        webauthn.verify_registration(client_data_json=_client_data("webauthn.create", cross_origin=True), attestation_object=att, challenge=CHALLENGE, origin=ORIGIN, rp_id=RP_ID)

    # Missing UP / UV flags and wrong RP ID.
    for flags, msg in ((0x04, "user not present"), (0x01, "user not verified")):
        bad_att = cbor_encode({"fmt": "none", "attStmt": {}, "authData": _auth_data(flags=flags)})
        with pytest.raises(WebAuthnError, match=msg):
            webauthn.verify_registration(client_data_json=_client_data("webauthn.create"), attestation_object=bad_att, challenge=CHALLENGE, origin=ORIGIN, rp_id=RP_ID)

    wrong_rp = cbor_encode({"fmt": "none", "attStmt": {}, "authData": _auth_data(rp_id="other.test", flags=0x05)})
    with pytest.raises(WebAuthnError, match="RP ID mismatch"):
        webauthn.verify_registration(client_data_json=_client_data("webauthn.create"), attestation_object=wrong_rp, challenge=CHALLENGE, origin=ORIGIN, rp_id=RP_ID)

    # Malformed stored COSE key in assertion raises WebAuthnError.
    with pytest.raises(WebAuthnError, match="malformed stored key"):
        webauthn.verify_assertion(
            client_data_json=_client_data("webauthn.get"),
            authenticator_data=_auth_data(flags=0x05),
            signature=b"sig",
            challenge=CHALLENGE,
            origin=ORIGIN,
            rp_id=RP_ID,
            cose_key=bytes([0xFA, 0x00]),
            stored_sign_count=0,
        )


@pytest.mark.asyncio
async def test_register_finish_returns_400_on_malformed_cbor_attestation(world):
    setup = world.store.new_setup_link()
    bad_attestations = [
        bytes([0xF9, 0x3C]),  # truncated float16
        bytes([0x62, 0xFF, 0xFE]),  # invalid UTF-8
        bytes([0xA1, 0x80, 0x01]),  # unhashable map key
        cbor_encode({"fmt": "none", "authData": _auth_data(flags=0x45, attested=b"\x00" * 16 + b"\x00\x041234" + bytes([0xF9, 0x3C]))}),
    ]
    for raw in bad_attestations:
        # Fresh challenge for each attempt since take_challenge consumes it.
        options = await (await world.post("/api/register/options", {"setup": setup})).json()
        response = await world.post(
            "/api/register/finish",
            {
                "challenge_id": options["challenge_id"],
                "credential": {
                    "id": webauthn.b64url(b"bad"),
                    "clientDataJSON": webauthn.b64url(_client_data("webauthn.create", challenge=webauthn.unb64url(options["publicKey"]["challenge"]))),
                    "attestationObject": webauthn.b64url(raw),
                },
            },
        )
        assert response.status == 400
    assert world.store.credentials() == []
