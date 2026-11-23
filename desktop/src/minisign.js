// Checks a download against the updater key built into the app. Releases are signed with the
// same minisign key the earlier (Tauri) app used, so both read one manifest: the signature is the
// base64 of a minisign .sig file over the BLAKE2b-512 hash of the file ("ED", prehashed).
import { createPublicKey, verify } from "node:crypto"
import { createReadStream } from "node:fs"
import { Worker } from "node:worker_threads"

import blake from "blakejs"

/** BLAKE2b-512 of `data`. Electron's crypto library has no BLAKE2, so this one is plain JS. */
export function blake2b512(data) {
  const state = blake.blake2bInit(64)
  // This synchronous helper is for small inputs. Installer hashing runs in a worker.
  for (let i = 0; i < data.length; i += 1 << 20) blake.blake2bUpdate(state, data.subarray(i, i + (1 << 20)))
  return Buffer.from(blake.blake2bFinal(state))
}

/** The public key `pubkey.txt` holds: the base64 of a minisign public key file. */
export function parsePublicKey(encoded) {
  const lines = Buffer.from(encoded.trim(), "base64").toString("utf8").trim().split("\n")
  const blob = Buffer.from(lines.at(-1).trim(), "base64")
  if (blob.length !== 42 || blob.subarray(0, 2).toString() !== "Ed") throw new Error("not a minisign public key")
  return { keyId: blob.subarray(2, 10), key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: blob.subarray(10).toString("base64url") }, format: "jwk" }) }
}

/** Whether `signature` (base64 of a minisign .sig file) signs `data` with `publicKey`. */
export function verifySignature(data, signature, publicKey) {
  return verifyDigest(blake2b512(data), signature, publicKey)
}

function verifyDigest(digest, signature, publicKey) {
  let lines
  try {
    lines = Buffer.from(signature.trim(), "base64").toString("utf8").trim().split("\n")
  } catch {
    return false
  }
  if (lines.length < 4 || !lines[2].startsWith("trusted comment: ")) return false
  const blob = Buffer.from(lines[1].trim(), "base64")
  if (blob.length !== 74 || blob.subarray(0, 2).toString() !== "ED" || !blob.subarray(2, 10).equals(publicKey.keyId)) return false
  const sig = blob.subarray(10)
  if (!verify(null, digest, publicKey.key, sig)) return false
  // The trusted comment (file name, timestamp) is signed too, together with the signature.
  const comment = Buffer.from(lines[2].slice("trusted comment: ".length))
  return verify(null, Buffer.concat([sig, comment]), publicKey.key, Buffer.from(lines[3].trim(), "base64"))
}

/** Called in the verifier worker: bounded memory, even for large installers. */
export async function verifyFileSignature(path, signature, publicKey) {
  const state = blake.blake2bInit(64)
  for await (const chunk of createReadStream(path)) blake.blake2bUpdate(state, chunk)
  return verifyDigest(Buffer.from(blake.blake2bFinal(state)), signature, publicKey)
}

/** Keep hashing and signature verification off Electron's main event loop. */
export function verifyStagedSignature(path, signature, publicKey, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./verify-worker.js", import.meta.url), { workerData: { path, signature, publicKey } })
    let settled = false
    const finish = (error, valid) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      // Wait for the file to close before callers remove it (especially on Windows).
      worker.terminate().then(() => error ? reject(error) : resolve(valid), reject)
    }
    const abort = () => finish(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    worker.once("message", valid => finish(null, valid))
    worker.once("error", finish)
    worker.once("exit", code => finish(new Error(`Signature worker exited before returning a result (${code})`)))
  })
}
