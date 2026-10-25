import { api, b64url, unb64url } from "./api"

type Options = { challenge_id: string; publicKey: Record<string, any> }

export async function register(setup: string | null) {
  const options = await api<Options>("/api/register/options", { method: "POST", body: { setup } })
  const pk = options.publicKey
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...pk,
      challenge: unb64url(pk.challenge),
      user: { ...pk.user, id: unb64url(pk.user.id) },
      excludeCredentials: (pk.excludeCredentials || []).map((c: any) => ({ ...c, id: unb64url(c.id) })),
    } as unknown as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential
  const response = credential.response as AuthenticatorAttestationResponse
  await api("/api/register/finish", {
    method: "POST",
    body: {
      challenge_id: options.challenge_id,
      label: deviceLabel(),
      credential: {
        id: b64url(credential.rawId),
        clientDataJSON: b64url(response.clientDataJSON),
        attestationObject: b64url(response.attestationObject),
      },
    },
  })
}

export async function signIn() {
  const options = await api<Options>("/api/login/options", { method: "POST" })
  const pk = options.publicKey
  const credential = (await navigator.credentials.get({
    publicKey: { ...pk, challenge: unb64url(pk.challenge) } as unknown as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential
  const response = credential.response as AuthenticatorAssertionResponse
  await api("/api/login/finish", {
    method: "POST",
    body: {
      challenge_id: options.challenge_id,
      credential: {
        id: b64url(credential.rawId),
        clientDataJSON: b64url(response.clientDataJSON),
        authenticatorData: b64url(response.authenticatorData),
        signature: b64url(response.signature),
      },
    },
  })
}

export function cancelled(error: unknown) {
  return error instanceof DOMException && error.name === "NotAllowedError"
}

function deviceLabel() {
  const ua = navigator.userAgent
  if (/iPhone|iPad/.test(ua)) return "iphone"
  if (/Android/.test(ua)) return "android"
  if (/Mac/.test(ua)) return "mac"
  if (/Windows/.test(ua)) return "windows"
  if (/Linux/.test(ua)) return "linux"
  return "passkey"
}
