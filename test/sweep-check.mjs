
/**
 * The history sweep: rows the projection bound dropped, and rows from Sessions
 * the live feed never saw, must both reach the ledger exactly once.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../index.js')
const { Ledger, sweepHistory, makeFolder, LEDGER_FILE } = mod

let pass = 0
const fails = []
const check = (name, ok, detail) => { if (ok) pass += 1; else fails.push(name + (detail === undefined ? '' : ' -- ' + JSON.stringify(detail))) }

const dir = await mkdtemp(join(tmpdir(), 'tu-sweep-'))
const logger = { warn: () => {} }

// A log with more attempts than the projection keeps, so the sweep has to see
// rows the fold would have thrown away.
const T0 = Date.now() - 3600000
function buildLog(sessionId, count) {
  const events = []
  let seq = 0
  for (let i = 0; i < count; i += 1) {
    const at = T0 + i * 1000
    events.push({ type: 'step/start', seq: seq++, time: at, data: { turn: 1, step: i } })
    events.push({
      type: 'assistant/message',
      seq: seq++,
      time: at + 500,
      data: {
        turn: 1,
        step: i,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 0 },
        message: { source: { provider: 'relay-a', model: 'm' } },
      },
    })
  }
  return events
}

const logs = new Map([
  ['session-a', buildLog('session-a', 900)],
  ['session-b', buildLog('session-b', 50)],
])
const persistence = {
  list: async () => [...logs.keys()].map((id) => ({ id })),
  open: async (id) => ({
    id,
    read: async () => ({ events: logs.get(id) ?? [] }),
    close: async () => undefined,
  }),
}

const ledger = new Ledger({ logger, dir })
await ledger.load()
const result = await sweepHistory(ledger, persistence)
await ledger.flush()
check('the sweep reads every stored session', result.sessions === 2, result)
check('it records every attempt, not just the newest 600', result.rows === 950, result)
check('the ledger agrees on the row count', ledger.totals.requests === 950, ledger.totals.requests)
check('the projection bound is no longer the ceiling', 950 > mod.MAX_REQUESTS)

// A second sweep must be free of double counting.
const again = await sweepHistory(ledger, persistence)
await ledger.flush()
check('a second sweep records nothing new', again.rows === 0, again)
check('and does not double the totals', ledger.totals.requests === 950, ledger.totals.requests)
const lines = (await readFile(join(dir, LEDGER_FILE), 'utf8')).trim().split('\n')
check('the file holds one line per attempt', lines.length === 950, lines.length)

// A live row for an attempt the sweep already read supersedes rather than adds.
const folder = makeFolder()
const id = 'session-a'
const tail = logs.get(id)
let hit
for (const event of tail) hit = folder.push(event, undefined, id) ?? hit
const before = ledger.totals.requests
const tokensBefore = ledger.totals.outputTokens
// A genuinely newer sample: the settlement after the attempt, as the live feed sees it.
const written = ledger.record(hit.key, id, { ...hit.row, time: hit.row.time + 1000, outputTokens: 99 }, 'live')
check('a newer sample for a swept attempt supersedes it', written !== undefined && ledger.totals.requests === before, { written: written !== undefined, before, after: ledger.totals.requests })
check('the superseding value replaces the old one', ledger.totals.outputTokens === tokensBefore - 5 + 99, { tokensBefore, after: ledger.totals.outputTokens })

// An older sample arriving after the newer one is dropped, so totals cannot drift.
const older = ledger.record(hit.key, id, { ...hit.row, time: hit.row.time - 60000, outputTokens: 1 }, 'sweep')
check('an older sample for the same key is ignored', older === undefined)

// A missing persistence service is not a failure.
check('no persistence service is handled', (await sweepHistory(ledger, undefined)).rows === 0)

await rm(dir, { recursive: true, force: true })
console.log(pass + ' passed, ' + fails.length + ' failed')
for (const failure of fails) console.log('  FAIL ' + failure)
process.exit(fails.length > 0 ? 1 : 0)
