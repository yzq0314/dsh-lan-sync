// Ed25519 identities, pairing proofs, and signed-request verification.
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto'

export const SIGNATURE_WINDOW_MS = 60_000
export const NONCE_TTL_MS = 120_000

export function createIdentity() {
  const pair = generateKeyPairSync('ed25519')
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

export function randomNonce() {
  return randomBytes(16).toString('hex')
}

/** Six-digit pairing code; leading zeros are preserved. */
export function randomPairingCode() {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

export function pairingProof(code, nonce, publicKey) {
  return createHmac('sha256', code).update(`${nonce}|${publicKey}`).digest('hex')
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

export function signText(privateKeyB64, text) {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' })
  return sign(null, Buffer.from(text, 'utf8'), key).toString('base64')
}

export function verifyText(publicKeyB64, text, signatureB64, signal) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
}

/** The exact bytes a peer signs for one request. */
export function canonicalRequest(method, path, bodyHash, nonce, ts) {
  return `${String(method).toUpperCase()}\n${path}\n${bodyHash}\n${nonce}\n${String(ts)}`
}

export function signatureHeaders(privateKeyB64, method, path, bodyText) {
  const nonce = randomNonce()
  const ts = Math.floor(Date.now() / 1000)
  const bodyHash = sha256Hex(bodyText ?? '')
  const text = canonicalRequest(method, path, bodyHash, nonce, ts)
  return {
    'x-lansync-nonce': nonce,
    'x-lansync-ts': String(ts),
    'x-lansync-sig': signText(privateKeyB64, text),
  }
}

/**
 * Verify one signed request. Returns a short refusal code, or undefined on success.
 * `seen` de-duplicates nonces for the lifetime of the process.
 */
export function checkSignedRequest({ method, path, bodyText, headers, peer, seen }) {
  const nonce = headers['x-lansync-nonce']
  const ts = Number(headers['x-lansync-ts'])
  const signature = headers['x-lansync-sig']
  const peerId = headers['x-lansync-peer']
  if (typeof nonce !== 'string' || typeof signature !== 'string' || !Number.isFinite(ts)) return 'unsigned'
  if (peerId !== undefined && peerId !== peer.instanceId) return 'wrong-peer'
  const skew = Math.abs(Date.now() - ts * 1000)
  if (skew > SIGNATURE_WINDOW_MS) return 'stale-timestamp'
  if (seen.has(nonce)) return 'replayed-nonce'
  const text = canonicalRequest(method, path, sha256Hex(bodyText ?? ''), nonce, ts)
  if (!verifyText(peer.publicKey, text, signature)) return 'bad-signature'
  seen.set(nonce, Date.now() + NONCE_TTL_MS)
  return undefined
}
