// Snapshot comparison under the additive policy: add and upgrade, never delete.
import { isDeepStrictEqual } from 'node:util'

function byName(a, b) {
  return a.name.localeCompare(b.name)
}

/**
 * Compare the local profile view against a peer snapshot.
 * `mode: 'additive'` keeps everything the local profile already has;
 * unknown or differing values are reported instead of applied.
 */
export function computeDiff(local, remote, { mode = 'additive' } = {}) {
  const packages = { install: [], update: [], same: [], keptLocal: [], skipped: [] }
  const localPackages = new Map(local.packages.map((entry) => [entry.name, entry]))
  const remoteNames = new Set()

  for (const item of remote.packages ?? []) {
    remoteNames.add(item.name)
    if (!item.portable) {
      packages.skipped.push({ name: item.name, spec: item.spec, reason: 'not-portable' })
      continue
    }
    const found = localPackages.get(item.name)
    if (found === undefined) {
      packages.install.push({ name: item.name, spec: item.spec, version: item.version })
      continue
    }
    if (found.spec === item.spec && (!found.version || !item.version || found.version === item.version) && found.enabled === item.enabled) {
      packages.same.push({ name: item.name, spec: item.spec })
      continue
    }
    packages.update.push({ name: item.name, from: found.spec, to: item.spec, version: item.version })
  }

  if (mode === 'additive') {
    for (const entry of local.packages) {
      if (!remoteNames.has(entry.name)) packages.keptLocal.push({ name: entry.name, spec: entry.spec })
    }
  }
  packages.install.sort(byName)
  packages.update.sort(byName)
  packages.same.sort(byName)
  packages.keptLocal.sort(byName)
  packages.skipped.sort(byName)

  const patch = { insert: [], update: [], same: [], keptLocalEntries: [] }
  const localPatch = new Map(local.patch.map((entry) => [entry.id, entry]))
  const remoteIds = new Set()

  for (const item of remote.patch ?? []) {
    remoteIds.add(item.id)
    const found = localPatch.get(item.id)
    const remoteKeys = Object.keys(item.config)
    if (found === undefined) {
      patch.insert.push({ id: item.id, name: item.name, config: item.config })
      continue
    }
    const fill = []
    const conflict = []
    const same = []
    const localKeys = Object.keys(found.config ?? {})
    for (const key of remoteKeys) {
      const remoteValue = item.config[key]
      if (localKeys.includes(key)) {
        if (isDeepStrictEqual(found.config[key], remoteValue)) same.push(key)
        else conflict.push({ key, local: found.config[key], remote: remoteValue })
        continue
      }
      const inherited = found.inherited ?? {}
      if (Object.hasOwn(inherited, key) && isDeepStrictEqual(inherited[key], remoteValue)) {
        same.push(key)
        continue
      }
      fill.push({ key, value: remoteValue })
    }
    const keptLocalKeys = localKeys.filter((key) => !remoteKeys.includes(key))
    if (fill.length === 0 && conflict.length === 0) {
      patch.same.push({ id: item.id, keys: remoteKeys.length })
      continue
    }
    patch.update.push({ id: item.id, name: item.name, fill, conflict, keptLocalKeys })
  }

  if (mode === 'additive') {
    for (const entry of local.patch) {
      if (!remoteIds.has(entry.id)) patch.keptLocalEntries.push({ id: entry.id })
    }
  }

  const totals = {
    install: packages.install.length,
    update: packages.update.length,
    skipped: packages.skipped.length,
    insert: patch.insert.length,
    fill: patch.update.reduce((sum, entry) => sum + entry.fill.length, 0),
    conflict: patch.update.reduce((sum, entry) => sum + entry.conflict.length, 0),
    keptLocalPackages: packages.keptLocal.length,
    keptLocalEntries: patch.keptLocalEntries.length,
  }

  return {
    mode,
    snapshotId: remote.snapshotId,
    createdAt: remote.createdAt,
    origin: remote.origin,
    packages,
    patch,
    totals,
  }
}

/** One-line summary for logs and command output. */
export function describeDiff(diff) {
  const totals = diff?.totals ?? {}
  return [
    `${totals.install ?? 0} to install`,
    `${totals.update ?? 0} to update`,
    `${totals.fill ?? 0} config keys to fill`,
    `${totals.conflict ?? 0} conflicts kept local`,
    `${totals.skipped ?? 0} skipped`,
  ].join(', ')
}
