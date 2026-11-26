// Host half of dsh-lan-sync: one LAN listener, staged snapshots, no remote apply.
import { readFileSync } from 'node:fs'
import { hostname, platform } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { computeDiff, describeDiff } from './lib/diff.js'
import { buildSnapshot } from './lib/snapshot.js'
import { Store, PAIRING_TTL_MS, resolveDataDir } from './lib/state.js'
import { createSyncServer } from './lib/server.js'

export const name = 'lan-sync'
export const inject = ['pluginManager']

export const Config = Schema.object({
  port: Schema.natural().default(7411).description('TCP port of the LAN sync listener.'),
  bindHost: Schema.string().default('0.0.0.0')
    .description('Interface the listener binds to. 127.0.0.1 keeps sync on this machine only.'),
  dataDir: Schema.string()
    .description('Directory for identity, peers and staged snapshots. Defaults to $DSH_HOME/lan-sync.'),
  excludePatchPrefixes: Schema.array(Schema.string()).default(['llm-'])
    .description('Profile entry id prefixes whose configuration is never exported.'),
  excludePatchIds: Schema.array(Schema.string()).default(['lan-sync', 'ui-settings-account', 'deepseek-account', 'credentials'])
    .description('Profile entry ids whose configuration is never exported.'),
  stripMachineLocalPaths: Schema.boolean().default(true)
    .description('Drop configuration values that are absolute paths on this machine.'),
  autoIssuePairingCode: Schema.boolean().default(true)
    .description('Issue a pairing code at startup and log it, so a first peer can pair without a control surface.'),
})

function createLogger(ctx) {
  const write = (level) => (...args) => {
    const sink = typeof ctx.logger === 'function' ? ctx.logger('lan-sync') : undefined
    const target = sink?.[level]
    if (typeof target === 'function') {
      target.call(sink, ...args)
      return
    }
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log']('[lan-sync]', ...args)
  }
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') }
}

/** The running DSH version, read beside the profile's install anchor when available. */
function dshVersionOf(ctx) {
  try {
    const anchor = ctx.get('profileContext')?.installAnchor
    if (typeof anchor === 'string' && anchor.length > 0) {
      return JSON.parse(readFileSync(join(anchor, 'package.json'), 'utf8')).version ?? 'unknown'
    }
  } catch {
    // Version is informational; the peer refuses incompatible packages itself.
  }
  return 'unknown'
}

/** Read the editable configuration facts, tolerating a profile without config-editor. */
function readConfiguration(ctx) {
  const editor = ctx.get('configEditor')
  if (editor === undefined || typeof editor.configuration !== 'function') return []
  return editor.configuration().map(({ entry, inherited, override }) => ({
    id: entry?.options?.id,
    name: entry?.options?.name,
    inherited: inherited ?? {},
    override: override ?? {},
  }))
}

export async function apply(ctx, config) {
  const logger = createLogger(ctx)
  const store = new Store({ dir: resolveDataDir(config.dataDir), logger })
  await store.load()

  const ownEntryId = ctx.fiber?.entry?.options?.id
  const version = dshVersionOf(ctx)

  async function readFacts() {
    const bundles = await ctx.pluginManager.listBundles()
    return { bundles, configuration: readConfiguration(ctx) }
  }

  function origin() {
    return {
      instanceId: store.identity.instanceId,
      hostname: hostname(),
      platform: platform(),
      dshVersion: version,
    }
  }

  async function getSnapshot() {
    const facts = await readFacts()
    const snapshot = buildSnapshot({
      origin: origin(), bundles: facts.bundles, configuration: [], ownEntryId,
      excludeIds: config.excludePatchIds, excludePrefixes: config.excludePatchPrefixes,
    })
    // LAN discovery exports package metadata only. Local profile_sync handles opt-in preferences.
    snapshot.packages = facts.bundles.filter(b => b.installed && b.source !== undefined)
      .map(b => {
        const registry = typeof b.source === 'string' && /^[~^]?\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?$/.test(b.source)
        return { name: b.name, version: b.version, enabled: Boolean(b.enabled),
          spec: registry ? b.name + '@' + b.version : b.name, portable: registry, kind: registry ? 'registry' : 'local' }
      })
    snapshot.skipped = snapshot.skipped.filter(b => b.reason !== 'disabled')
    return snapshot
  }

  async function stageSnapshot(snapshot, peer) {
    const diff = computeDiff(await getSnapshot(), snapshot)
    await store.saveIncoming(snapshot, diff)
    logger.info(`staged ${snapshot.snapshotId} from ${peer.hostname ?? peer.instanceId}: ${describeDiff(diff)}`)
    return diff
  }

  const server = createSyncServer({
    store,
    getSnapshot,
    stageSnapshot,
    deviceInfo: async () => origin(),
    logger,
  })

  ctx.effect(() => {
    server.on('error', (error) => {
      logger.error(`listener failed on ${config.bindHost}:${config.port}: ${String(error?.message ?? error)}`)
    })
    server.listen(config.port, config.bindHost, () => {
      const address = server.address()
      const shown = typeof address === 'object' && address !== null ? `${address.address}:${address.port}` : String(address)
      logger.info(`listening on ${shown}`)
    })

    if (config.autoIssuePairingCode) {
      store.issuePairing().then((pairing) => {
        logger.info(`pairing code ${pairing.code} (expires ${pairing.expiresAt}, ${PAIRING_TTL_MS / 60_000} minutes)`)
      }).catch((error) => logger.warn(`could not issue a pairing code: ${String(error?.message ?? error)}`))
    }

    return async () => {
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
      logger.info('listener stopped')
    }
  }, 'lan-sync listener')
}
