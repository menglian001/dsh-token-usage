
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../index.js')
const {
  Ledger, requestLogProjectionDefinition, serveLedger,
  LEDGER_FILE, dayKey, MAX_REQUESTS, RECONCILE_INTERVAL_MS,
} = mod

let pass = 0, fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))) }
}

const dir = await mkdtemp(join(tmpdir(), 'tu-ledger-'))
/** Fixture clock: recent, so the 730-day retention window never expires the fixture. */
const T0 = Date.now() - 3600000
const row = (over) => ({
  turn: 1, step: 1, time: T0, provider: 'relay-a', model: 'model-x',
  uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 5,
  reasoningTokens: 2, streamed: true, ...over,
})

console.log('== 1. projection definition ==')
const projection = requestLogProjectionDefinition
check('projection key', projection.key === 'requestLog')
check('stateVersion is 2', projection.stateVersion === 2)
const st0 = projection.init()
check('init shape', st0.requests.length === 0 && st0.step === null && st0.open === null)

console.log('== 2. fold semantics ==')
let st = projection.init()
st = projection.apply(st, { type: 'step/start', time: 500, data: { turn: 1, step: 1 } })
check('step boundary recorded', st.step.startTime === 500)
st = projection.apply(st, { type: 'assistant/attempt', time: 1000, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 1 } } })
check('attempt row appended', st.requests.length === 1)
st = projection.apply(st, { type: 'assistant/message', time: 2000, data: { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 6, cacheWriteTokens: 7, reasoningTokens: 2 }, message: { source: { provider: 'relay-a', model: 'model-x' } } } })
check('settlement replaces rather than appends', st.requests.length === 1, st.requests.length)
check('settlement wins for usage', st.requests[0].uncachedInputTokens === 20, st.requests[0])
check('route carried in', st.requests[0].provider === 'relay-a')
check('timing measured from step/start', st.requests[0].latencyMs === 1500, st.requests[0].latencyMs)
st = projection.apply(st, { type: 'llm/retry-started', data: { turn: 1, step: 1 } })
check('retry closes the slot', st.open === null)
st = projection.apply(st, { type: 'assistant/message', time: 3000, data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } })
check('retried attempt appends its own row', st.requests.length === 2, st.requests.length)
check('ignored events keep identity', projection.apply(st, { type: 'turn/end', data: {} }) === st)

console.log('== 3. ledger records, supersedes, and reloads ==')
const logger = { warn: (m) => console.log('     [warn] ' + m) }
const a = new Ledger({ logger, dir })
a.load()
a.record('s1|1|1|0', 's1', row({}), 'live')
// A settlement follows its attempt: same attempt key, strictly later commit time.
a.record('s1|1|1|0', 's1', row({ time: T0 + 1, outputTokens: 40 }), 'live')
a.record('s1|1|2|0', 's1', row({ step: 2, time: T0 + 1000, outputTokens: 7 }), 'live')
a.record('s2|1|1|0', 's2', row({ time: T0 + 2000, provider: 'relay-b', model: 'model-y' }), 'live')
await a.flush()
const text = await readFile(join(dir, LEDGER_FILE), 'utf8')
check('one line per recorded attempt', text.trim().split('\n').length === 4, text.trim().split('\n').length)
check('superseded attempt is retracted in memory', a.totals.outputTokens === 57, a.totals.outputTokens)

const b = new Ledger({ logger, dir })
const loaded = await b.load()
check('reload reads the file', loaded.lines === 4, loaded)
check('reload dedupes by key', b.unique === 3, b.unique)
check('reload last-wins for a superseded key', b.totals.outputTokens === 57, b.totals.outputTokens)
check('per-session aggregates', b.sessions.get('s1').outputTokens === 47, b.sessions.get('s1').outputTokens)
check('per-channel aggregates', b.channels.get('relay-b').requests === 1, [...b.channels.keys()])
check('per-model aggregates', [...b.models.keys()].sort().join(',') === 'relay-a/model-x,relay-b/model-y', [...b.models.keys()])
const snap = b.snapshot(10)
check('snapshot totals', snap.totals.requests === 3 && snap.totals.totalTokens === snap.totals.promptTokens + snap.totals.completionTokens)
check('snapshot carries days/models/channels', snap.days.length >= 1 && snap.models.length === 2 && snap.channels.length === 2)
check('snapshot carries recent rows on demand', snap.recent.length === 3, snap.recent.length)
check('snapshot honours the recent cap', b.snapshot(1).recent.length === 1)
check('snapshot with no rows returns none', b.snapshot(0).recent.length === 0)

console.log('== 4. compaction ==')
const c = new Ledger({ logger, dir })
await c.load()
await c.flush()
const small = (await readFile(join(dir, LEDGER_FILE), 'utf8')).trim().split('\n').length
check('a small fresh ledger is left alone', small === 4, small)
check('a small fresh ledger still holds every record', c.totals.outputTokens === 57, c.totals.outputTokens)

// A ledger past the compaction floor collapses to one line per key, which is what
// bounds the file when a stream keeps superseding the same attempt.
const bigDir = await mkdtemp(join(tmpdir(), 'tu-ledger-big-'))
const bigLines = []
for (let i = 0; i < 2400; i += 1) {
  bigLines.push(JSON.stringify({ key: 's1|1|1|0', session: 's1', ...row({ outputTokens: i + 1, time: T0 + i }) }))
}
await writeFile(join(bigDir, LEDGER_FILE), bigLines.join('\n') + '\n', 'utf8')
const big = new Ledger({ logger, dir: bigDir })
const bigLoaded = await big.load()
await big.flush()
const collapsed = (await readFile(join(bigDir, LEDGER_FILE), 'utf8')).trim().split('\n')
check('a large ledger is collapsed to one line per key', collapsed.length === 1, collapsed.length)
check('collapsing keeps the newest record for the key', big.totals.outputTokens === 2400, big.totals.outputTokens)
check('the pre-compaction line count is reported', bigLoaded.lines === 2400, bigLoaded)
await rm(bigDir, { recursive: true, force: true })

console.log('== 5. read route ==')
const makeRes = () => {
  const out = { status: undefined, headers: undefined, body: undefined }
  return { out, writeHead(s, hd) { out.status = s; out.headers = hd }, end(body) { out.body = body } }
}
const deny = { authorizeIndex: () => false }
const res1 = makeRes()
await serveLedger(deny, b, { method: 'GET', url: '/token-usage/ledger' }, res1)
check('unauthenticated read writes nothing (auth owned it)', res1.out.status === undefined)
const allow = { authorizeIndex: () => true }
const res2 = makeRes()
await serveLedger(allow, b, { method: 'GET', url: '/token-usage/ledger?rows=2' }, res2)
check('authenticated read is 200 json', res2.out.status === 200 && String(res2.out.headers['content-type']).startsWith('application/json'))
const body = JSON.parse(res2.out.body)
check('route body carries totals and rows', body.totals.requests === 3 && body.recent.length === 2, body.recent.length)
check('route reports the file it reads', body.file === join(dir, LEDGER_FILE))
const res3 = makeRes()
await serveLedger(allow, b, { method: 'POST', url: '/token-usage/ledger' }, res3)
check('write method is 405', res3.out.status === 405)
const res4 = makeRes()
await serveLedger(undefined, b, { method: 'GET', url: '/token-usage/ledger' }, res4)
check('missing connection fails closed', res4.out.status === 404)
const res5 = makeRes()
await serveLedger(allow, b, { method: 'HEAD', url: '/token-usage/ledger' }, res5)
check('HEAD answers without a body', res5.out.status === 200 && res5.out.body === undefined)

console.log('== 6. reconciliation ==')
const d = new Ledger({ logger, dir: await mkdtemp(join(tmpdir(), 'tu-ledger2-')) })
await d.load()
const session = { id: 'restored-1' }
const old = T0 - 600000
check('a fold row is recorded', d.reconcile([session], () => ({ requests: [row({ time: old, turn: 3, step: 4 })] })) === 1 && d.totals.requests === 1, d.totals.requests)
check('reconciliation is idempotent by watermark', d.reconcile([session], () => ({ requests: [row({ time: old, turn: 3, step: 4 })] })) === 0 && d.totals.requests === 1)
check('a newer fold row is picked up', d.reconcile([session], () => ({ requests: [row({ time: old, turn: 3, step: 4 }), row({ time: old + 600000, turn: 3, step: 5 })] })) === 1 && d.totals.requests === 2)
check('a throwing fold read is contained', d.reconcile([{ id: 'broken' }], () => { throw new Error('boom') }) === 0)

console.log('== 7. panel constants ==')
check('retention bound is 600', MAX_REQUESTS === 600)
check('reconcile interval is 60s', RECONCILE_INTERVAL_MS === 60000)
check('day key is local YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(dayKey(Date.now())))

await rm(dir, { recursive: true, force: true })
console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
