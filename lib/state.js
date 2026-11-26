// Machine-local plugin state: identity, peers, pairing codes, and staged snapshots.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { createIdentity, pairingProof, randomPairingCode, safeEqual } from './protocol.js'

export const STATE_VERSION = 1
export const PAIRING_TTL_MS = 5 * 60_000
export const PAIRING_MAX_ATTEMPTS = 5
export const INCOMING_KEEP = 5

/** Prefer the configured directory, then $DSH_HOME, then ~/.dsh. */
export function resolveDataDir(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit.length > 0) return resolve(explicit)
  const env = (process.env.DSH_HOME ?? '').trim()
  const home = env.length > 0 ? resolve(env) : join(homedir(), '.dsh')
  return join(home, 'lan-sync')
}

function newState() {
  const identity = createIdentity()
  return {
    version: STATE_VERSION,
    instanceId: `ls-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
    ...identity,
    pairing: null,
    peers: {},
  }
}

function safeSnapshotId(value) {
  return String(value).replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

export class Store {
  #dir
  #stateFile
  #incomingDir
  #state
  #writeQueue = Promise.resolve()
  #logger

  constructor({ dir, logger }) {
    this.#dir = dir
    this.#stateFile = join(dir, 'state.json')
    this.#incomingDir = join(dir, 'incoming')
    this.#logger = logger
  }

  get dir() {
    return this.#dir
  }

  get incomingDir() {
    return this.#incomingDir
  }

  get state() {
    if (this.#state === undefined) throw new Error('lan-sync state is not loaded')
    return this.#state
  }

  get identity() {
    const state = this.state
    return { instanceId: state.instanceId, publicKey: state.publicKey, privateKey: state.privateKey }
  }

  async load() {
    await mkdir(this.#incomingDir, { recursive: true })
    let text
    try {
      text = await readFile(this.#stateFile, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (text === undefined) {
      this.#state = newState()
      await this.save()
      this.#logger?.info?.(`lan-sync created ${this.#stateFile}`)
      return
    }
    const parsed = JSON.parse(text)
    if (typeof parsed?.instanceId !== 'string' || typeof parsed.publicKey !== 'string'
      || typeof parsed.privateKey !== 'string') {
      throw new Error(`lan-sync state file is not usable: ${this.#stateFile}`)
    }
    parsed.peers ??= {}
    parsed.pairing ??= null
    this.#state = parsed
  }

  save() {
    const text = `${JSON.stringify(this.#state, null, 2)}\n`
    this.#writeQueue = this.#writeQueue.then(async () => {
      const temporary = `${this.#stateFile}.tmp`
      await writeFile(temporary, text, { mode: 0o600 })
      await rename(temporary, this.#stateFile)
    })
    return this.#writeQueue
  }

  // --- pairing ---------------------------------------------------------

  /** Start or return the current pairing code. */
  async issuePairing() {
    const now = Date.now()
    const current = this.#state.pairing
    if (current && now < Date.parse(current.expiresAt) && current.attempts < PAIRING_MAX_ATTEMPTS) {
      return current
    }
    this.#state.pairing = {
      code: randomPairingCode(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
      attempts: 0,
    }
    await this.save()
    return this.#state.pairing
  }

  /** Clear the active pairing code, e.g. after a successful pairing. */
  async clearPairing() {
    this.#state.pairing = null
    await this.save()
  }

  /**
   * Check a pairing proof against the active code.
   * Returns undefined when the proof matches, otherwise a refusal reason.
   * The caller clears the code and records the peer after a match.
   */
  async checkPairingProof({ nonce, publicKey, proof }) {
    const pairing = this.#state.pairing
    if (!pairing) return 'no-active-code'
    if (Date.now() >= Date.parse(pairing.expiresAt)) {
      this.#state.pairing = null
      await this.save()
      return 'expired'
    }
    if (pairing.attempts >= PAIRING_MAX_ATTEMPTS) return 'attempts-exhausted'
    pairing.attempts += 1
    await this.save()
    if (typeof nonce !== 'string' || typeof publicKey !== 'string' || typeof proof !== 'string') return 'malformed'
    if (!safeEqual(proof, pairingProof(pairing.code, nonce, publicKey))) return 'bad-proof'
    return undefined
  }

  // --- peers -----------------------------------------------------------

  peers() {
    return Object.values(this.#state.peers)
  }

  peer(instanceId) {
    return this.#state.peers[instanceId]
  }

  async addPeer(peer) {
    this.#state.peers[peer.instanceId] = peer
    await this.save()
    return peer
  }

  async removePeer(instanceId) {
    delete this.#state.peers[instanceId]
    await this.save()
  }

  // --- staged snapshots ------------------------------------------------

  async saveIncoming(snapshot, diff) {
    const id = safeSnapshotId(snapshot.snapshotId)
    const record = { receivedAt: new Date().toISOString(), snapshot, diff }
    const file = join(this.#incomingDir, `${id}.json`)
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
    await this.#pruneIncoming()
    return { file, record }
  }

  async listIncoming() {
    const names = await readdir(this.#incomingDir).catch(() => [])
    const entries = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = join(this.#incomingDir, name)
      try {
        const record = JSON.parse(await readFile(file, 'utf8'))
        entries.push({
          snapshotId: record.snapshot?.snapshotId ?? name.replace(/\.json$/, ''),
          receivedAt: record.receivedAt,
          origin: record.snapshot?.origin ?? {},
          totals: record.diff?.totals ?? {},
        })
      } catch {
        entries.push({ snapshotId: name.replace(/\.json$/, ''), receivedAt: null, unreadable: true })
      }
    }
    return entries.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
  }

  async readIncoming(snapshotId) {
    const file = join(this.#incomingDir, `${safeSnapshotId(snapshotId)}.json`)
    return JSON.parse(await readFile(file, 'utf8'))
  }

  async deleteIncoming(snapshotId) {
    await rm(join(this.#incomingDir, `${safeSnapshotId(snapshotId)}.json`), { force: true })
  }

  async #pruneIncoming() {
    const names = await readdir(this.#incomingDir).catch(() => [])
    const entries = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = join(this.#incomingDir, name)
      try {
        const info = await stat(file)
        entries.push({ file, mtime: info.mtimeMs })
      } catch {
        continue
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime)
    for (const extra of entries.slice(INCOMING_KEEP)) await rm(extra.file, { force: true })
  }
}
