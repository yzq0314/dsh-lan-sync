// Pure-logic checks for dsh-lan-sync.
// Run: ELECTRON_RUN_AS_NODE=1 <node> test/smoke-pure.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { computeDiff, describeDiff } from '../lib/diff.js'
import {
  canonicalRequest,
  checkSignedRequest,
  createIdentity,
  pairingProof,
  safeEqual,
  sha256Hex,
  signText,
  signatureHeaders,
  verifyText,
} from '../lib/protocol.js'
import { buildSnapshot, normalizeBundleSpec, stripMachineLocal, validateSnapshot } from '../lib/snapshot.js'
import { Store } from '../lib/state.js'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.error(`FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

function equal(label, actual, expected) {
  check(label, isDeepStrictEqual(actual, expected), { actual, expected })
}

function throws(label, body) {
  try {
    body()
    check(label, false, 'expected a throw')
  } catch {
    check(label, true)
  }
}

// --- identities and signatures -----------------------------------------

const alice = createIdentity()
const bob = createIdentity()
const peer = { instanceId: 'peer-a', publicKey: alice.publicKey }

{
  const body = '{"hello":1}'
  const seen = new Map()
  const headers = signatureHeaders(alice.privateKey, 'POST', '/lan-sync/stage', body)
  check('valid signature accepted',
    checkSignedRequest({ method: 'POST', path: '/lan-sync/stage', bodyText: body, headers, peer, seen }) === undefined)
  check('replayed nonce refused',
    checkSignedRequest({ method: 'POST', path: '/lan-sync/stage', bodyText: body, headers, peer, seen }) === 'replayed-nonce')
  check('tampered body refused',
    checkSignedRequest({ method: 'POST', path: '/lan-sync/stage', bodyText: '{"hello":2}', headers, peer, seen: new Map() }) === 'bad-signature')

  const staleTs = Math.floor(Date.now() / 1000) - 3600
  const staleHeaders = {
    'x-lansync-nonce': 'n-stale',
    'x-lansync-ts': String(staleTs),
    'x-lansync-sig': signText(alice.privateKey,
      canonicalRequest('GET', '/lan-sync/snapshot', sha256Hex(''), 'n-stale', staleTs)),
  }
  check('stale timestamp refused',
    checkSignedRequest({ method: 'GET', path: '/lan-sync/snapshot', bodyText: '', headers: staleHeaders, peer, seen: new Map() }) === 'stale-timestamp')

  const wrongPeer = { ...headers, 'x-lansync-peer': 'peer-b' }
  check('wrong peer header refused',
    checkSignedRequest({ method: 'POST', path: '/lan-sync/stage', bodyText: body, headers: wrongPeer, peer, seen: new Map() }) === 'wrong-peer')

  check('signature from another key refused',
    verifyText(bob.publicKey, 'abc', signText(alice.privateKey, 'abc')) === false)
}

{
  const proof = pairingProof('123456', 'n1', alice.publicKey)
  check('pairing proof is deterministic', proof === pairingProof('123456', 'n1', alice.publicKey))
  check('pairing proof depends on the code', proof !== pairingProof('654321', 'n1', alice.publicKey))
  check('safeEqual matches identical strings', safeEqual(proof, proof))
  check('safeEqual rejects different strings', safeEqual(proof, `${proof}x`) === false)
}

// --- spec normalisation ------------------------------------------------

{
  equal('registry range becomes name@range', normalizeBundleSpec('dsh-better-sidebar', '0.28.0'),
    { spec: 'dsh-better-sidebar@0.28.0', portable: true, kind: 'registry' })
  equal('tarball url stays portable', normalizeBundleSpec('screen', 'https://example.com/a.tgz'),
    { spec: 'https://example.com/a.tgz', portable: true, kind: 'https' })
  equal('git commit spec stays portable', normalizeBundleSpec('x', 'git+https://example.com/r.git#abc'),
    { spec: 'git+https://example.com/r.git#abc', portable: true, kind: 'git+' })
  equal('linked directory is not portable', normalizeBundleSpec('mine', 'link:D:\\work\\mine'),
    { spec: 'link:D:\\work\\mine', portable: false, kind: 'link' })
  equal('file path is not portable', normalizeBundleSpec('mine', 'file:../mine'),
    { spec: 'file:../mine', portable: false, kind: 'file' })
  equal('missing source has no spec', normalizeBundleSpec('x', undefined),
    { spec: undefined, portable: false, kind: 'none' })
}

// --- machine-local stripping ------------------------------------------

{
  const stripped = []
  const value = stripMachineLocal({
    win: 'C:\\profiles\\a',
    posix: '/home/a',
    keep: 'standard',
    nested: { deep: 'D:/x/y', ok: 3 },
    list: ['E:\\z', 'keep-me'],
    flag: true,
  }, '', stripped)
  equal('absolute paths are dropped', value, { keep: 'standard', nested: { ok: 3 }, list: ['keep-me'], flag: true })
  equal('dropped paths are reported', stripped, ['win', 'posix', 'nested.deep', 'list[0]'])
}

// --- snapshot construction --------------------------------------------

const bundles = [
    { name: 'keep-bundle', installed: true, enabled: true, source: '1.2.3', version: '1.2.3' },
    { name: 'off-bundle', installed: true, enabled: false, source: '1.0.0', version: '1.0.0' },
    { name: 'absent-bundle', installed: false, enabled: false },
    { name: 'inbox-bundle', installed: true, enabled: true, version: '0.2.2' },
    { name: 'linked-bundle', installed: true, enabled: true, source: 'link:D:\\work\\linked' },
]

const configuration = [
    { id: 'lan-sync', name: 'dsh-lan-sync', inherited: {}, override: { port: 7411 } },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', inherited: {}, override: { providers: {} } },
    { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', inherited: {}, override: { transcriptView: 'standard', cache: 'C:\\cache' } },
    { id: 'no-override', name: 'x', inherited: { a: 1 }, override: {} },
]

const snapshot = buildSnapshot({
  origin: { instanceId: 'ls-a', hostname: 'a-box', platform: 'win32', dshVersion: '0.2.2-rc.3' },
  bundles,
  configuration,
  ownEntryId: 'lan-sync',
  excludeIds: ['lan-sync', 'ui-settings-account'],
  excludePrefixes: ['llm-'],
  stripLocalPaths: true,
  now: Date.UTC(2026, 10, 25, 1, 0, 0),
})

{
  equal('only portable shipped rows become packages', snapshot.packages.map((item) => item.name),
    ['keep-bundle', 'linked-bundle'])
  check('linked bundle is marked not portable', snapshot.packages[1].portable === false)
  equal('skipped reasons are recorded',
    snapshot.skipped.map((item) => [item.name, item.reason]).sort(),
    [['absent-bundle', 'not-installed'], ['inbox-bundle', 'installation-provided'], ['off-bundle', 'disabled']])
  equal('excluded ids are recorded',
    snapshot.excluded.filter((item) => item.reason !== 'machine-local-path').map((item) => item.id).sort(),
    ['lan-sync', 'llm-pi-ai'])
  equal('machine-local path is stripped from the patch', snapshot.patch,
    [{ id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', config: { transcriptView: 'standard' } }])
  check('stripped path appears in the excluded list',
    snapshot.excluded.some((item) => item.reason === 'machine-local-path' && item.id === 'ui-chat.cache'))
  check('snapshot id is stable for a fixed clock', /^20261125T010000Z-[0-9a-f]{6}$/.test(snapshot.snapshotId))

  const roundTripped = JSON.parse(JSON.stringify(snapshot))
  check('built snapshot passes validation', validateSnapshot(roundTripped) === roundTripped)
  throws('wrong format is rejected', () => validateSnapshot({ ...roundTripped, format: 2 }))
  throws('unsafe snapshot id is rejected', () => validateSnapshot({ ...roundTripped, snapshotId: '../escape' }))
  throws('non-portable flag must be boolean',
    () => validateSnapshot({ ...roundTripped, packages: [{ name: 'x', spec: 'x@1', portable: 'yes' }] }))
}

// --- diffs -------------------------------------------------------------

{
  const remote = {
    format: 1,
    snapshotId: 'snap-remote',
    createdAt: new Date().toISOString(),
    origin: { instanceId: 'ls-b', hostname: 'b-box' },
    packages: [
      { name: 'keep-bundle', spec: 'keep-bundle@1.2.3', portable: true },
      { name: 'new-bundle', spec: 'new-bundle@2.0.0', portable: true },
      { name: 'linked-bundle', spec: 'link:D:\\work\\linked', portable: false },
    ],
    patch: [
      { id: 'ui-chat', config: { transcriptView: 'detailed', performanceUsage: 'detailed' } },
      { id: 'brand-new-row', config: { a: 1 } },
    ],
  }
  const local = {
    packages: [
      { name: 'keep-bundle', spec: 'keep-bundle@1.2.3' },
      { name: 'mine-bundle', spec: 'mine-bundle@0.1.0' },
      { name: 'linked-bundle', spec: 'linked-bundle@0.0.1' },
    ],
    patch: [
      { id: 'ui-chat', config: { transcriptView: 'standard', localOnly: 1 }, inherited: { transcriptView: 'standard' } },
      { id: 'local-only-row', config: { b: 2 }, inherited: {} },
    ],
  }
  const diff = computeDiff(local, remote)

  equal('unchanged package is counted as same', diff.packages.same.map((item) => item.name), ['keep-bundle'])
  equal('unknown package is installed', diff.packages.install.map((item) => item.name), ['new-bundle'])
  equal('local-only package is kept', diff.packages.keptLocal.map((item) => item.name), ['mine-bundle'])
  equal('non-portable package is skipped', diff.packages.skipped.map((item) => item.name), ['linked-bundle'])
  equal('missing row becomes an insert', diff.patch.insert.map((item) => item.id), ['brand-new-row'])
  equal('differing value is reported as a conflict, not applied',
    diff.patch.update[0].conflict.map((item) => item.key), ['transcriptView'])
  equal('missing key is filled', diff.patch.update[0].fill.map((item) => item.key), ['performanceUsage'])
  equal('local-only key is kept', diff.patch.update[0].keptLocalKeys, ['localOnly'])
  equal('local-only row is kept', diff.patch.keptLocalEntries.map((item) => item.id), ['local-only-row'])
  equal('totals agree', diff.totals,
    { install: 1, update: 0, skipped: 1, insert: 1, fill: 1, conflict: 1, keptLocalPackages: 1, keptLocalEntries: 1 })
  check('summary line is readable', describeDiff(diff).startsWith('1 to install'))
}

// --- local state -------------------------------------------------------

{
  const dir = mkdtempSync(join(tmpdir(), 'lan-sync-'))
  try {
    const store = new Store({ dir })
    await store.load()
    check('identity is created on first load', store.identity.instanceId.startsWith('ls-'))
    check('state file is written', (await import('node:fs')).existsSync(join(dir, 'state.json')))

    const pairing = await store.issuePairing()
    check('pairing code is six digits', /^\d{6}$/.test(pairing.code))
    check('pairing code is reused while valid', (await store.issuePairing()).code === pairing.code)

    const key = createIdentity()
    const nonce = 'nonce-1'
    check('wrong proof refused',
      await store.checkPairingProof({ nonce, publicKey: key.publicKey, proof: 'deadbeef' }) === 'bad-proof')
    check('correct proof accepted',
      await store.checkPairingProof({ nonce, publicKey: key.publicKey, proof: pairingProof(pairing.code, nonce, key.publicKey) }) === undefined)

    store.state.pairing.expiresAt = new Date(Date.now() - 1000).toISOString()
    check('expired code refused',
      await store.checkPairingProof({ nonce, publicKey: key.publicKey, proof: 'x' }) === 'expired')

    await store.addPeer({ instanceId: 'ls-peer', publicKey: key.publicKey, hostname: 'peer' })
    check('peer is stored', store.peers().length === 1 && store.peer('ls-peer')?.hostname === 'peer')
    await store.addPeer({ instanceId: 'ls-peer2', publicKey: key.publicKey, hostname: 'peer2' })

    const fakeDiff = computeDiff({ packages: [], patch: [] }, {
      format: 1, snapshotId: 'snap-1', createdAt: new Date().toISOString(),
      origin: { instanceId: 'ls-peer' }, packages: [], patch: [],
    })
    await store.saveIncoming({ snapshotId: 'snap-1', origin: { instanceId: 'ls-peer' } }, fakeDiff)
    await store.saveIncoming({ snapshotId: 'snap-2', origin: { instanceId: 'ls-peer2' } }, fakeDiff)
    const list = await store.listIncoming()
    check('staged snapshots are listed', list.length === 2, list)
    check('staged snapshot reads back', (await store.readIncoming('snap-1')).snapshot.snapshotId === 'snap-1')

    for (let index = 0; index < 8; index += 1) {
      await store.saveIncoming({ snapshotId: `snap-x${index}`, origin: {} }, fakeDiff)
    }
    check('staged snapshots are pruned to the newest five', (await store.listIncoming()).length === 5)

    await store.removePeer('ls-peer')
    check('peer removal sticks', store.peers().length === 1)

    const reloaded = new Store({ dir })
    await reloaded.load()
    check('state survives a reload', reloaded.identity.instanceId === store.identity.instanceId
      && reloaded.peers().length === 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
