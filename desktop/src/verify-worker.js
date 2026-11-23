import { parentPort, workerData } from "node:worker_threads"
import { parsePublicKey, verifyFileSignature } from "./minisign.js"

const { path, signature, publicKey } = workerData
parentPort.postMessage(await verifyFileSignature(path, signature, parsePublicKey(publicKey)))
