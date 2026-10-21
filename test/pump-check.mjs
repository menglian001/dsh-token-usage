
/**
 * Pump coverage: every listed Session must be fetched, however old it is, and a
 * busy list must be refreshed round-robin rather than head-first.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let moduleObj = null
const timers = []
const sandbox = {
  window: { __ModuleLoader__: { load: (m) => { moduleObj = m } } },
  console,
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
  clearTimeout: () => {},
  setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
  clearInterval: () => {},
  fetch: async () => { throw new Error('offline') },
  AbortController,
}
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })

const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useEffect: () => {},
  useCallback: (fn) => fn,
}
const plugin = moduleObj.factory((name) => {
  if (name === 'react') return react
  throw new Error('unexpected require: ' + name)
})

const REFRESH_PER_PASS = 12
const fails = []
const check = (name, ok, detail) => { if (!ok) fails.push(name + (detail === undefined ? '' : ' -- ' + JSON.stringify(detail))) }


// Drive one composition; ages are minutes since each Session was last active.
function run(ages) {
  timers.length = 0
  const now = Date.now()
  const ids = []
  const byId = {}
  ages.forEach((age, index) => {
    const id = 'session-' + String(index).padStart(2, '0')
    ids.push(id)
    byId[id] = { id, updatedAt: now - age * 60000 }
  })
  const state = { ids, byId, projectionsBySession: {} }
  const asked = []
  const sessions = {
    list: { getSnapshot: () => state, subscribe: () => () => {} },
    refreshProjections: (id) => {
      asked.push(id)
      state.projectionsBySession[id] = { values: { requestLog: [] }, state: 'ready' }
      return Promise.resolve()
    },
  }
  const ctx = {
    slots: { inject: (_slot, factory) => { factory(); return () => {} }, register: () => () => {} },
    get: (name) => (name === 'sessions' ? sessions : undefined),
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
  }
  plugin.apply(ctx)
  return { asked, pump: timers[0].fn }
}


// --- 1. old Sessions with no baseline are never starved ---------------------
{
  const ages = Array.from({ length: 30 }, (_v, i) => i + 30) // 30..59 min: all idle
  const { asked, pump } = run(ages)
  for (let i = 0; i < Math.ceil(30 / REFRESH_PER_PASS); i += 1) pump()
  const covered = new Set(asked)
  check('every stale Session is fetched', covered.size === 30, covered.size)
  check('the oldest is not starved', covered.has('session-29'))
  check('each stale Session is asked exactly once', asked.length === 30, asked.length)
  pump()
  check('an idle list costs nothing once covered', asked.length === 30, asked.length)
  console.log('  stale list: ' + covered.size + '/30 covered, ' + asked.length + ' asks total')
}

// --- 2. a busy list rotates instead of re-reading its head -----------------
{
  const ages = Array.from({ length: 20 }, () => 1) // all active
  const { asked, pump } = run(ages)
  check('a busy pass spends its whole budget', asked.length === REFRESH_PER_PASS, asked.length)
  for (let i = 0; i < 3; i += 1) pump()
  const distinct = new Set(asked.slice(0, REFRESH_PER_PASS * 4))
  check('later passes reach Sessions the first pass never touched', distinct.size === 20, distinct.size)
  console.log('  busy list: ' + distinct.size + '/20 reached within 4 passes')
}

console.log((fails.length === 0 ? 'PASS' : 'FAIL') + ' — pump coverage and rotation')
for (const failure of fails) console.log('  ' + failure)
process.exit(fails.length > 0 ? 1 : 0)
