"""Passkey ceremonies, login sessions, and desktop browser-to-app handoffs."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import secrets

from aiohttp import web

from . import webauthn

log = logging.getLogger("hermes.portal")

CHALLENGE_TTL = 300
# How long the desktop app has to collect a browser-approved sign-in.
HANDOFF_TTL = 120
PKCE_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")


class AuthRoutes:
    """Authentication routes using the portal's store, clock, and active clients."""

    def _signed_in(self, request):
        return self.store.login(request.cookies.get(self.cookie))


    def _require(self, request):
        credential = self._signed_in(request)
        if credential is None:
            raise web.HTTPUnauthorized(text=json.dumps({"error": "sign in"}), content_type="application/json")
        return credential


    def _set_login(self, response, credential_id):
        token = self.store.start_login(credential_id)
        response.set_cookie(
            self.cookie, token, max_age=30 * 24 * 3600, path="/", secure=self.secure, httponly=True, samesite="Strict"
        )


    def _challenge(self, kind, **extra):
        now = self.clock()
        for key in [k for k, v in self.challenges.items() if v["expires"] < now]:
            self.challenges.pop(key, None)
        cid = secrets.token_urlsafe(16)
        challenge = secrets.token_bytes(32)
        self.challenges[cid] = {"kind": kind, "challenge": challenge, "expires": now + CHALLENGE_TTL, **extra}
        return cid, challenge


    def _take_challenge(self, cid, kind):
        entry = self.challenges.pop(str(cid or ""), None)
        if entry is None or entry["kind"] != kind or entry["expires"] < self.clock():
            raise ValueError("That sign-in attempt expired. Try again.")
        return entry


    async def me(self, request):
        signed_in = self._signed_in(request) is not None
        me = {"signed_in": signed_in, "has_passkeys": self.store.has_credentials(), "connected": self.hub.connected}
        if signed_in:
            me["name"] = self.store.meta("name", "")
            me["environments"] = self.environments is not None
            me["machine_load"] = self.machine_load is not None
        return web.json_response(me)


    async def register_options(self, request):
        body = await request.json()
        setup = body.get("setup")
        signed_in = self._signed_in(request)
        if signed_in is None and not self.store.setup_link_valid(setup):
            raise web.HTTPForbidden(text=json.dumps({"error": "This setup link is invalid or used up."}), content_type="application/json")
        user_id = self.store.meta("user_id")
        if user_id is None:
            user_id = webauthn.b64url(secrets.token_bytes(16))
            self.store.set_meta("user_id", user_id)
        cid, challenge = self._challenge("register", setup=None if signed_in else setup)
        existing = [{"type": "public-key", "id": webauthn.b64url(c["id"])} for c in self.store.credentials()]
        return web.json_response(
            {
                "challenge_id": cid,
                "publicKey": {
                    "challenge": webauthn.b64url(challenge),
                    "rp": {"id": self.rp_id, "name": self.rp_name},
                    "user": {"id": user_id, "name": "owner", "displayName": "Nako"},
                    "pubKeyCredParams": [{"type": "public-key", "alg": webauthn.ES256}, {"type": "public-key", "alg": webauthn.RS256}],
                    "authenticatorSelection": {"residentKey": "required", "userVerification": "required"},
                    "attestation": "none",
                    "excludeCredentials": existing,
                    "timeout": CHALLENGE_TTL * 1000,
                },
            }
        )


    async def register_finish(self, request):
        body = await request.json()
        entry = self._take_challenge(body.get("challenge_id"), "register")
        if entry["setup"] is None and self._signed_in(request) is None:
            raise web.HTTPForbidden()
        credential = body.get("credential") or {}
        registered = webauthn.verify_registration(
            client_data_json=webauthn.unb64url(credential.get("clientDataJSON", "")),
            attestation_object=webauthn.unb64url(credential.get("attestationObject", "")),
            challenge=entry["challenge"],
            origin=self.origins,
            rp_id=self.rp_id,
        )
        if entry["setup"] is not None and not self.store.use_setup_link(entry["setup"]):
            raise web.HTTPForbidden(text=json.dumps({"error": "This setup link was already used."}), content_type="application/json")
        label = str(body.get("label") or "passkey")[:60]
        self.store.add_credential(registered.credential_id, registered.cose_key, registered.sign_count, label)
        log.info("Nako portal registered a passkey (%s)", label)
        response = web.json_response({"ok": True})
        self._set_login(response, registered.credential_id)
        return response


    async def login_options(self, request):
        cid, challenge = self._challenge("login")
        return web.json_response(
            {
                "challenge_id": cid,
                "publicKey": {
                    "challenge": webauthn.b64url(challenge),
                    "rpId": self.rp_id,
                    "userVerification": "required",
                    "allowCredentials": [],
                    "timeout": CHALLENGE_TTL * 1000,
                },
            }
        )


    async def login_finish(self, request):
        body = await request.json()
        entry = self._take_challenge(body.get("challenge_id"), "login")
        credential = body.get("credential") or {}
        credential_id = webauthn.unb64url(credential.get("id", ""))
        stored = self.store.credential(credential_id)
        if stored is None:
            raise web.HTTPForbidden(text=json.dumps({"error": "This passkey isn't registered here."}), content_type="application/json")
        count = webauthn.verify_assertion(
            client_data_json=webauthn.unb64url(credential.get("clientDataJSON", "")),
            authenticator_data=webauthn.unb64url(credential.get("authenticatorData", "")),
            signature=webauthn.unb64url(credential.get("signature", "")),
            challenge=entry["challenge"],
            origin=self.origins,
            rp_id=self.rp_id,
            cose_key=stored["cose_key"],
            stored_sign_count=stored["sign_count"],
        )
        self.store.used_credential(credential_id, count)
        response = web.json_response({"ok": True})
        self._set_login(response, credential_id)
        return response


    async def logout(self, request):
        token = request.cookies.get(self.cookie)
        self.store.end_login(token)
        await self._revoke_clients(lambda client: client.token == token)
        response = web.json_response({"ok": True})
        response.del_cookie(self.cookie, path="/")
        return response


    async def passkeys(self, request):
        current = self._require(request)
        return web.json_response(
            [
                {"id": webauthn.b64url(c["id"]), "label": c["label"], "created_at": c["created_at"], "last_used_at": c["last_used_at"], "current": c["id"] == current}
                for c in self.store.credentials()
            ]
        )


    async def remove_passkey(self, request):
        current = self._require(request)
        target = webauthn.unb64url(request.match_info["id"])
        if target == current:
            raise ValueError("Sign in with another passkey to remove this one")
        self.store.remove_credential(target)
        await self._revoke_clients(lambda client: client.credential == target)
        return web.json_response({"ok": True})


    async def _revoke_clients(self, matches):
        clients = [c for c in self._clients if matches(c)]
        for client in clients:
            client.revoked = True
            self.hub.leave(client)
        await asyncio.gather(*(c.ws.close(code=1008, message=b"Login revoked") for c in clients))


    # The browser approves a PKCE challenge; the desktop app trades the one-time
    # code and its secret verifier for its own login cookie.
    async def desktop_link(self, request):
        credential = self._require(request)
        body = await request.json()
        challenge = str(body.get("challenge") or "")
        if not PKCE_CHALLENGE.match(challenge):
            raise ValueError("That sign-in request is malformed")
        now = self.clock()
        for key in [k for k, v in self.handoffs.items() if v["expires"] < now]:
            self.handoffs.pop(key, None)
        code = secrets.token_urlsafe(32)
        self.handoffs[code] = {"challenge": challenge, "credential": credential, "expires": now + HANDOFF_TTL}
        return web.json_response({"code": code})


    async def desktop_session(self, request):
        entry = self.handoffs.pop(request.query.get("code", ""), None)
        verifier = request.query.get("verifier", "").encode()
        proof = webauthn.b64url(hashlib.sha256(verifier).digest())
        valid = (
            entry is not None
            and entry["expires"] >= self.clock()
            and hmac.compare_digest(proof, entry["challenge"])
            and self.store.credential(entry["credential"]) is not None
        )
        if not valid:
            return web.Response(status=303, headers={"Location": "/#signin=failed"})
        response = web.Response(status=303, headers={"Location": "/"})
        self._set_login(response, entry["credential"])
        return response


    def _auth(self, handler):
        async def signed(request):
            self._require(request)
            return await handler(request)

        return signed
