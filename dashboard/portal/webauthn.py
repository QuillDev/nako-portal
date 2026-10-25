"""Passkey registration and sign-in checks (WebAuthn level 2, attestation "none").

Only what a single-owner portal needs: ES256 and RS256 keys, user verification
required, no attestation trust chain. Every check the spec makes the relying
party responsible for is here: ceremony type, challenge, origin, RP ID hash,
user presence and verification flags, signature and signature counter.
"""

from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

from . import cbor

ES256 = -7
RS256 = -257
FLAG_UP = 0x01
FLAG_UV = 0x04
FLAG_AT = 0x40


class WebAuthnError(ValueError):
    pass


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64url(text: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (ValueError, TypeError) as error:
        raise WebAuthnError("malformed base64url") from error


@dataclass
class AuthData:
    rp_id_hash: bytes
    flags: int
    sign_count: int
    credential_id: bytes | None = None
    public_key: dict | None = None


def parse_auth_data(raw: bytes) -> AuthData:
    if len(raw) < 37:
        raise WebAuthnError("authenticator data too short")
    data = AuthData(raw[:32], raw[32], int.from_bytes(raw[33:37], "big"))
    if data.flags & FLAG_AT:
        if len(raw) < 55:
            raise WebAuthnError("attested credential data too short")
        length = int.from_bytes(raw[53:55], "big")
        data.credential_id = raw[55 : 55 + length]
        if len(data.credential_id) != length:
            raise WebAuthnError("credential id truncated")
        key, _ = cbor.decode(raw, 55 + length)
        if not isinstance(key, dict):
            raise WebAuthnError("credential public key is not a COSE map")
        data.public_key = key
    return data


def _client_data(raw: bytes, ceremony: str, challenge: bytes, origin: str) -> None:
    try:
        client = json.loads(raw)
    except ValueError as error:
        raise WebAuthnError("client data is not JSON") from error
    if client.get("type") != ceremony:
        raise WebAuthnError("wrong ceremony type")
    if unb64url(str(client.get("challenge", ""))) != challenge:
        raise WebAuthnError("challenge mismatch")
    if client.get("origin") != origin:
        raise WebAuthnError("origin mismatch")
    if client.get("crossOrigin"):
        raise WebAuthnError("cross-origin ceremony")


def _check_flags_and_rp(data: AuthData, rp_id: str) -> None:
    if data.rp_id_hash != hashlib.sha256(rp_id.encode()).digest():
        raise WebAuthnError("RP ID mismatch")
    if not data.flags & FLAG_UP:
        raise WebAuthnError("user not present")
    if not data.flags & FLAG_UV:
        raise WebAuthnError("user not verified")


def public_key_from_cose(cose: dict):
    alg = cose.get(3)
    if alg == ES256 and cose.get(1) == 2 and cose.get(-1) == 1:
        x, y = cose.get(-2), cose.get(-3)
        if not (isinstance(x, bytes) and isinstance(y, bytes) and len(x) == len(y) == 32):
            raise WebAuthnError("bad EC2 key")
        return ec.EllipticCurvePublicNumbers(int.from_bytes(x, "big"), int.from_bytes(y, "big"), ec.SECP256R1()).public_key()
    if alg == RS256 and cose.get(1) == 3:
        n, e = cose.get(-1), cose.get(-2)
        if not (isinstance(n, bytes) and isinstance(e, bytes)):
            raise WebAuthnError("bad RSA key")
        return rsa.RSAPublicNumbers(int.from_bytes(e, "big"), int.from_bytes(n, "big")).public_key()
    raise WebAuthnError("unsupported key type")


@dataclass
class Registered:
    credential_id: bytes
    cose_key: bytes
    sign_count: int


def verify_registration(*, client_data_json: bytes, attestation_object: bytes, challenge: bytes, origin: str, rp_id: str) -> Registered:
    _client_data(client_data_json, "webauthn.create", challenge, origin)
    try:
        attestation = cbor.loads(attestation_object)
    except cbor.CborError as error:
        raise WebAuthnError("attestation object is not CBOR") from error
    if not isinstance(attestation, dict) or not isinstance(attestation.get("authData"), bytes):
        raise WebAuthnError("attestation object has no authenticator data")
    data = parse_auth_data(attestation["authData"])
    _check_flags_and_rp(data, rp_id)
    if data.credential_id is None or data.public_key is None:
        raise WebAuthnError("no attested credential")
    public_key_from_cose(data.public_key)  # rejects keys we can't verify with later
    raw = attestation["authData"]
    key_start = 55 + len(data.credential_id)
    _, key_end = cbor.decode(raw, key_start)
    return Registered(data.credential_id, raw[key_start:key_end], data.sign_count)


def verify_assertion(
    *,
    client_data_json: bytes,
    authenticator_data: bytes,
    signature: bytes,
    challenge: bytes,
    origin: str,
    rp_id: str,
    cose_key: bytes,
    stored_sign_count: int,
) -> int:
    """Returns the new signature counter."""
    _client_data(client_data_json, "webauthn.get", challenge, origin)
    data = parse_auth_data(authenticator_data)
    _check_flags_and_rp(data, rp_id)
    cose = cbor.loads(cose_key)
    if not isinstance(cose, dict):
        raise WebAuthnError("stored key is not a COSE map")
    key = public_key_from_cose(cose)
    signed = authenticator_data + hashlib.sha256(client_data_json).digest()
    try:
        if isinstance(key, ec.EllipticCurvePublicKey):
            key.verify(signature, signed, ec.ECDSA(hashes.SHA256()))
        else:
            key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature as error:
        raise WebAuthnError("bad signature") from error
    if (data.sign_count or stored_sign_count) and data.sign_count <= stored_sign_count:
        # A counter that didn't move forward means a cloned authenticator.
        raise WebAuthnError("signature counter went backwards")
    return data.sign_count
