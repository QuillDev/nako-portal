"""Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291).

Notifications carry only a title, a short line and the chat to open; the
browser vendor's push service sees ciphertext, never the conversation.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import struct
import time
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

log = logging.getLogger("hermes.portal")
RECORD_SIZE = 4096


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _raw_public(key) -> bytes:
    return key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def _hkdf(salt, ikm, info, length):
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def encrypt(payload: bytes, p256dh: str, auth: str, *, sender=None, salt=None) -> bytes:
    """The aes128gcm body for one subscription."""
    receiver = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), _unb64(p256dh))
    sender = sender or ec.generate_private_key(ec.SECP256R1())
    salt = salt or os.urandom(16)
    shared = sender.exchange(ec.ECDH(), receiver)
    ua_public, as_public = _raw_public(receiver), _raw_public(sender.public_key())
    ikm = _hkdf(_unb64(auth), shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    record = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    header = salt + struct.pack(">I", RECORD_SIZE) + bytes([len(as_public)]) + as_public
    return header + record


class Vapid:
    """The server's push identity: one P-256 key kept beside the portal database."""

    def __init__(self, path: Path, subject: str):
        self.subject = subject
        path = Path(path)
        if path.exists():
            key = serialization.load_pem_private_key(path.read_bytes(), password=None)
            if not isinstance(key, ec.EllipticCurvePrivateKey):
                raise ValueError(f"{path} is not a P-256 key")
            self.key = key
        else:
            self.key = ec.generate_private_key(ec.SECP256R1())
            pem = self.key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
            )
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as out:
                out.write(pem)

    @property
    def public_key(self) -> str:
        return _b64(_raw_public(self.key.public_key()))

    def header(self, endpoint: str) -> str:
        audience = "{0.scheme}://{0.netloc}".format(urlparse(endpoint))
        head = _b64(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
        claims = _b64(json.dumps({"aud": audience, "exp": int(time.time()) + 12 * 3600, "sub": self.subject}).encode())
        der = self.key.sign(f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der)
        token = f"{head}.{claims}.{_b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
        return f"vapid t={token}, k={self.public_key}"


class Pusher:
    def __init__(self, http, store, vapid):
        self.http = http
        self.store = store
        self.vapid = vapid

    async def notify(self, title: str, body: str, session: str | None = None) -> int:
        payload = json.dumps({"title": title, "body": body, "session": session}).encode()
        delivered = 0
        for subscription in self.store.pushes():
            endpoint = subscription["endpoint"]
            keys = subscription["keys"]
            try:
                body_bytes = encrypt(payload, keys["p256dh"], keys["auth"])
                async with self.http.post(
                    endpoint,
                    data=body_bytes,
                    headers={
                        "Authorization": self.vapid.header(endpoint),
                        "Content-Encoding": "aes128gcm",
                        "Content-Type": "application/octet-stream",
                        "TTL": "86400",
                        "Urgency": "high",
                    },
                ) as response:
                    if response.status in (404, 410):
                        # The browser dropped this subscription.
                        self.store.remove_push(endpoint)
                    elif response.status < 300:
                        delivered += 1
                    else:
                        log.warning("Nako portal push got %s from %s", response.status, urlparse(endpoint).netloc)
            except Exception as error:
                log.warning("Nako portal push failed: %s", type(error).__name__)
        return delivered
