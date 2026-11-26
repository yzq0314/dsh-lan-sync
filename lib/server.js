// The LAN listener: pairing, snapshot export, and staged pushes.
import http from 'node:http'
import { checkSignedRequest, pairingProof, randomNonce } from './protocol.js'
import { validateSnapshot } from './snapshot.js'

export const BASE_PATH = '/lan-sync'
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Only a request from this machine may read the active pairing code. */
function isLoopback(address) {
  return typeof address === 'string' && (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1')
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { code: 'TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Create the LAN sync server. It never applies a snapshot: `stage` only
 * stores the peer's offer and returns the diff, so applying stays a local,
 * human-triggered action.
 */
export function createSyncServer({ store, getSnapshot, stageSnapshot, deviceInfo, logger }) {
  const seenNonces = new Map()

  function pruneNonces() {
    const now = Date.now()
    for (const [nonce, expiresAt] of seenNonces) {
      if (expiresAt <= now) seenNonces.delete(nonce)
    }
  }

  function requirePeer(req, bodyText, path) {
    const peerId = req.headers['x-lansync-peer']
    if (typeof peerId !== 'string' || peerId.length === 0) return { refusal: 'missing-peer-header' }
    const peer = store.peer(peerId)
    if (peer === undefined) return { refusal: 'unknown-peer' }
    const refusal = checkSignedRequest({
      method: req.method,
      path,
      bodyText,
      headers: req.headers,
      peer,
      seen: seenNonces,
    })
    return refusal === undefined ? { peer } : { refusal }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://lan-sync.invalid')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (!path.startsWith(BASE_PATH)) {
      sendJson(res, 404, { error: 'not-found' })
      return
    }
    const route = path.slice(BASE_PATH.length) || '/'
    let bodyText = ''
    try {
      if (req.method === 'POST') bodyText = await readBody(req)
    } catch (error) {
      sendJson(res, error.code === 'TOO_LARGE' ? 413 : 400, { error: 'body-unreadable' })
      return
    }

    try {
      if (route === '/info' && req.method === 'GET') {
        const info = await deviceInfo()
        const pairing = store.state.pairing
        sendJson(res, 200, {
          ...info,
          peers: Object.keys(store.state.peers).length,
          pairingActive: Boolean(pairing && Date.now() < Date.parse(pairing.expiresAt)),
          // The code is shown to the local surface only; a peer never learns it here.
          pairing: isLoopback(req.socket.remoteAddress) ? pairing : undefined,
        })
        return
      }

      if (route === '/pair' && req.method === 'POST') {
        pruneNonces()
        let payload
        try {
          payload = JSON.parse(bodyText)
        } catch {
          sendJson(res, 400, { error: 'malformed-json' })
          return
        }
        const publicKey = payload?.publicKey
        const nonce = payload?.nonce
        const proof = payload?.proof
        const device = payload?.device
        if (typeof publicKey !== 'string' || typeof nonce !== 'string' || typeof proof !== 'string'
          || device === null || typeof device !== 'object' || typeof device.instanceId !== 'string') {
          sendJson(res, 400, { error: 'malformed-pair-request' })
          return
        }
        const refusal = await store.checkPairingProof({ nonce, publicKey, proof })
        if (refusal !== undefined) {
          logger?.warn?.(`lan-sync pairing refused: ${refusal}`)
          sendJson(res, refusal === 'attempts-exhausted' || refusal === 'expired' ? 410 : 401, {
            error: 'pairing-refused',
            reason: refusal,
          })
          return
        }
        const code = store.state.pairing?.code
        const identity = store.identity
        const peer = {
          instanceId: device.instanceId,
          hostname: typeof device.hostname === 'string' ? device.hostname : null,
          dshVersion: typeof device.dshVersion === 'string' ? device.dshVersion : null,
          platform: typeof device.platform === 'string' ? device.platform : null,
          publicKey,
          pairedAt: new Date().toISOString(),
          pairingNonce: nonce,
        }
        await store.clearPairing()
        await store.addPeer(peer)
        const myNonce = randomNonce()
        sendJson(res, 200, {
          peerId: identity.instanceId,
          publicKey: identity.publicKey,
          nonce: myNonce,
          proof: pairingProof(code, myNonce, identity.publicKey),
          device: await deviceInfo(),
        })
        logger?.info?.(`lan-sync paired with ${peer.instanceId}`)
        return
      }

      if (route === '/snapshot' && req.method === 'GET') {
        const auth = requirePeer(req, bodyText, path)
        if (auth.refusal !== undefined) {
          sendJson(res, auth.refusal === 'unknown-peer' ? 403 : 401, { error: auth.refusal })
          return
        }
        sendJson(res, 200, await getSnapshot())
        return
      }

      if (route === '/stage' && req.method === 'POST') {
        const auth = requirePeer(req, bodyText, path)
        if (auth.refusal !== undefined) {
          sendJson(res, auth.refusal === 'unknown-peer' ? 403 : 401, { error: auth.refusal })
          return
        }
        let snapshot
        try {
          snapshot = validateSnapshot(JSON.parse(bodyText))
        } catch (error) {
          sendJson(res, 400, { error: 'invalid-snapshot', reason: String(error.message ?? error) })
          return
        }
        const diff = await stageSnapshot(snapshot, auth.peer)
        sendJson(res, 200, { snapshotId: snapshot.snapshotId, totals: diff.totals })
        logger?.info?.(`lan-sync staged ${snapshot.snapshotId} from ${auth.peer.instanceId}`)
        return
      }

      sendJson(res, 404, { error: 'unknown-route' })
    } catch (error) {
      logger?.error?.(`lan-sync request failed: ${String(error?.stack ?? error)}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal-error', reason: String(error?.message ?? error) })
      else res.end()
    }
  })
  server.on('clientError', (_error, socket) => {
    socket.destroy()
  })
  return server
}
