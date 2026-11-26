// Snapshot construction and validation: what one machine offers to its peers.
import { randomBytes } from 'node:crypto'

export const SNAPSHOT_FORMAT = 1

const REMOTE_SPEC_PREFIXES = ['file:', 'link:', 'https:', 'http:', 'git+', 'github:', 'gitlab:', 'bitbucket:', 'workspace:']

/** Turn a saved profile dependency into a spec that other machines can install. */
export function normalizeBundleSpec(name, source) {
  const raw = typeof source === 'string' ? source.trim() : ''
  if (raw.length === 0) return { spec: undefined, portable: false, kind: 'none' }
  const remote = REMOTE_SPEC_PREFIXES.find((prefix) => raw.startsWith(prefix))
  if (remote) {
    const portable = !['file:', 'link:', 'workspace:'].includes(remote)
    return { spec: raw, portable, kind: remote.replace(/:.*/, '') }
  }
  return { spec: `${name}@${raw}`, portable: true, kind: 'registry' }
}

function isAbsolutePathValue(value) {
  return typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/'))
}

/** Drop values that only describe the machine they came from. */
export function stripMachineLocal(value, at = '', stripped = []) {
  if (Array.isArray(value)) {
    const items = value.map((item, index) => stripMachineLocal(item, `${at}[${index}]`, stripped))
    return items.filter((item) => item !== undefined)
  }
  if (value !== null && typeof value === 'object') {
    const next = {}
    for (const [key, inner] of Object.entries(value)) {
      const path = at.length === 0 ? key : `${at}.${key}`
      const cleaned = stripMachineLocal(inner, path, stripped)
      if (cleaned !== undefined) next[key] = cleaned
    }
    return next
  }
  if (isAbsolutePathValue(value)) {
    stripped.push(at)
    return undefined
  }
  return value
}

export function newSnapshotId(now = Date.now()) {
  const stamp = new Date(now).toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

export function isExcludedId(id, { excludeIds = [], excludePrefixes = [] } = {}) {
  return excludeIds.includes(id) || excludePrefixes.some((prefix) => prefix.length > 0 && id.startsWith(prefix))
}

/**
 * Build one snapshot from already-gathered plugin manager and config editor facts.
 * Pure: no context access, so the same input always produces the same shape.
 */
export function buildSnapshot({
  origin,
  bundles = [],
  configuration = [],
  ownEntryId,
  excludeIds = [],
  excludePrefixes = [],
  stripLocalPaths = true,
  now = Date.now(),
}) {
  const packages = []
  const skipped = []
  for (const bundle of bundles) {
    if (bundle.name === undefined) continue
    if (!bundle.installed) {
      skipped.push({ name: bundle.name, reason: 'not-installed' })
      continue
    }
    if (!bundle.enabled) {
      skipped.push({ name: bundle.name, reason: 'disabled' })
      continue
    }
    if (bundle.source === undefined) {
      skipped.push({ name: bundle.name, reason: 'installation-provided' })
      continue
    }
    const normalized = normalizeBundleSpec(bundle.name, bundle.source)
    if (normalized.spec === undefined) {
      skipped.push({ name: bundle.name, reason: 'no-spec' })
      continue
    }
    packages.push({
      name: bundle.name,
      spec: normalized.spec,
      version: bundle.version,
      portable: normalized.portable,
      kind: normalized.kind,
    })
  }
  packages.sort((a, b) => a.name.localeCompare(b.name))

  const patch = []
  const excluded = []
  const strippedKeys = []
  for (const record of configuration) {
    const id = record?.id
    if (typeof id !== 'string' || id.length === 0) continue
    if (id === ownEntryId || isExcludedId(id, { excludeIds, excludePrefixes })) {
      excluded.push({ id, reason: id === ownEntryId ? 'self' : 'excluded' })
      continue
    }
    const override = record.override
    if (override === null || typeof override !== 'object' || Array.isArray(override)) continue
    if (Object.keys(override).length === 0) continue
    const localStripped = []
    const config = stripLocalPaths ? stripMachineLocal(override, id, localStripped) : override
    strippedKeys.push(...localStripped)
    if (Object.keys(config).length === 0) continue
    patch.push({ id, name: record.name, config })
  }
  patch.sort((a, b) => a.id.localeCompare(b.id))

  return {
    format: SNAPSHOT_FORMAT,
    snapshotId: newSnapshotId(now),
    createdAt: new Date(now).toISOString(),
    origin,
    packages,
    patch,
    skipped,
    excluded: strippedKeys.length === 0 ? excluded : [...excluded, ...strippedKeys.map((path) => ({ id: path, reason: 'machine-local-path' }))],
  }
}

const SAFE_ID = /^[A-Za-z0-9._:-]+$/

/** Reject anything a peer could use to confuse the receiver's files or report. */
export function validateSnapshot(value) {
  const fail = (reason) => {
    throw new TypeError(`snapshot rejected: ${reason}`)
  }
  if (value === null || typeof value !== 'object') fail('not an object')
  if (value.format !== SNAPSHOT_FORMAT) fail(`unsupported format ${String(value.format)}`)
  if (typeof value.snapshotId !== 'string' || !SAFE_ID.test(value.snapshotId)) fail('bad snapshotId')
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) fail('bad createdAt')
  const origin = value.origin
  if (origin === null || typeof origin !== 'object') fail('bad origin')
  if (typeof origin.instanceId !== 'string' || !SAFE_ID.test(origin.instanceId)) fail('bad origin.instanceId')
  if (!Array.isArray(value.packages)) fail('packages must be an array')
  if (!Array.isArray(value.patch)) fail('patch must be an array')
  if (value.packages.length > 500 || value.patch.length > 2000) fail('snapshot too large')
  for (const item of value.packages) {
    if (item === null || typeof item !== 'object') fail('bad package entry')
    if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 214) fail('bad package name')
    if (typeof item.spec !== 'string' || item.spec.length === 0 || item.spec.length > 4096) fail('bad package spec')
    if (typeof item.portable !== 'boolean') fail('bad portable flag')
  }
  for (const item of value.patch) {
    if (item === null || typeof item !== 'object') fail('bad patch entry')
    if (typeof item.id !== 'string' || !SAFE_ID.test(item.id)) fail('bad patch id')
    if (item.config === null || typeof item.config !== 'object' || Array.isArray(item.config)) fail('bad patch config')
  }
  return value
}
