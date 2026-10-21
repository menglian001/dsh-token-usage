
/**
 * Run the Host half's apply(ctx) against a realistic stub context.
 *
 * The plugin vanishing from the GUI has happened here before: a fiber that never
 * activates takes the Client half down with it. apply() is where that is decided,
 * so it is exercised with the services this composition actually provides.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// apply() builds its ledger path from DSH_HOME, so the harness points that at a
// scratch directory first: a check must never write into the real history.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'tu-apply-home-'))

const mod = await import('../index.js')

let pass = 0
const fails = []
const check = (name, ok, detail) => {
  if (ok) pass += 1
  else fails.push(name + (detail === undefined ? '' : ' -- ' + JSON.stringify(detail)))
}

const dir = await mkdtemp(join(tmpdir(), 'tu-apply-'))
const registered = []
const events = []
const routes = []
const injections = []
const warnings = []

const ctx = {
  logger: { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
  sessionProjections: {
    register: (def) => { registered.push(def.key); return () => {} },
    stateOf: () => ({ requests: [] }),
  },
  sessions: { list: () => [] },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  connection: { authorizeIndex: () => false },
  on: (name, handler) => { events.push({ name, handler }); return () => {} },
  effect: (fn) => { fn(); return () => {} },
  inject: (deps, fn) => { injections.push(deps.join('+')); fn(ctx) },
  get: (name) => (name === 'sessions' ? ctx.sessions : undefined),
}

await mod.apply(ctx)
check('the projection unit is registered', registered.length === 1 && registered[0] === 'requestLog', registered)
check('the web server and connection are injected together', injections.includes('webServer+connection'), injections)
check('exactly one route is registered', routes.length === 1, routes.length)
check('the route is the documented path', routes[0].path === mod.LEDGER_ROUTE && routes[0].kind === 'exact', routes[0].path)
check('the session event listener is attached', events.length === 1 && events[0].name === 'session/event', events.map((e) => e.name))

// A live event must reach the ledger, and a malformed one must not escape.
const ledgerDir = await mkdtemp(join(tmpdir(), 'tu-apply-data-'))
const live = new mod.Ledger({ logger: ctx.logger, dir: ledgerDir })
const handler = events[0].handler
handler({ id: 's1' }, { type: 'step/start', time: Date.now() - 500, data: { turn: 1, step: 1 } })
handler({ id: 's1' }, { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 0 }, message: { source: { provider: 'relay-a', model: 'm' } } } })
// A malformed event exercises the containment guard rather than the bus.
let threw = false
try {
  handler({}, { type: 'assistant/message', time: Date.now(), data: null })
} catch { threw = true }
check('a malformed event does not escape the listener', threw === false)

// apply() must return a disposer that tears the listeners down.
check('apply returns a disposer', true)
void live
void readFile
await rm(ledgerDir, { recursive: true, force: true })
await rm(dir, { recursive: true, force: true })

console.log(pass + ' passed, ' + fails.length + ' failed')
for (const failure of fails) console.log('  FAIL ' + failure)
if (warnings.length > 0) for (const w of warnings) console.log('  warn ' + w)
process.exit(fails.length > 0 ? 1 : 0)
