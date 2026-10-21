
/**
 * Render check for the durable ledger wiring.
 *
 * Runs the real client half against a hook runtime that actually re-renders, with
 * fetch stubbed both ways: a live route and no route at all. The point is that a
 * panel which only works when the ledger answers — or which silently shows an
 * empty page when the projection is gone but the file is not — fails here.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let moduleObj = null
// The client half runs in a browser; give the sandbox the host globals it uses so
// the harness exercises the real module rather than a stubbed-out copy of it.
let fetchImpl = async () => { throw new Error('no fetch stub installed') }
const sandbox = {
  window: { __ModuleLoader__: { load: (m) => { moduleObj = m } } },
  console,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  fetch: (...args) => fetchImpl(...args),
  AbortController,
}
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })

// --- hook runtime ---------------------------------------------------------
let hooks = []
let cursor = 0
let pending = []
const createElement = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && typeof c !== 'boolean'),
})
const react = {
  createElement,
  useState(init) {
    const i = cursor++
    if (hooks[i] === undefined) hooks[i] = { value: typeof init === 'function' ? init() : init }
    return [hooks[i].value, (next) => { hooks[i].value = typeof next === 'function' ? next(hooks[i].value) : next }]
  },
  useMemo(fn, deps) {
    const i = cursor++
    const slot = hooks[i]
    if (slot === undefined || deps === undefined || slot.deps === undefined || deps.some((d, k) => d !== slot.deps[k])) {
      hooks[i] = { value: fn(), deps }
    }
    return hooks[i].value
  },
  useRef(init) {
    const i = cursor++
    if (hooks[i] === undefined) hooks[i] = { value: { current: init } }
    return hooks[i].value
  },
  useEffect(fn, deps) {
    const i = cursor++
    const slot = hooks[i]
    if (slot === undefined || deps === undefined || slot.deps === undefined || deps.some((d, k) => d !== slot.deps[k])) {
      hooks[i] = { deps }
      pending.push(fn)
    }
  },
  // not used by the panel, but a missing export would be a load-time failure
  useCallback: (fn) => fn,
}

const plugin = moduleObj.factory((name) => {
  if (name === 'react') return react
  throw new Error('unexpected require: ' + name)
})

// --- capture the registered components ------------------------------------
const registered = new Map()
const ctx = {
  slots: {
    inject: (_slot, factory) => { factory(); return () => {} },
    register: (options, component) => { registered.set(options.name + ':' + (options.id ?? options.key), component); return () => {} },
  },
  get: () => undefined,
  effect: (fn) => { fn(); return () => {} },
  on: () => () => {},
}
plugin.apply(ctx)
const Panel = registered.get('main:token-usage')
if (typeof Panel !== 'function') throw new Error('the panel component was not registered')

// --- helpers --------------------------------------------------------------
/** Render one element: a function component becomes the element it returns. */
const expand = (node) => {
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props ?? {}))
  return node
}
const texts = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const item of node) texts(item, out); return out }
  if (typeof node !== 'object') return out
  const rendered = expand(node)
  if (rendered !== node) return texts(rendered, out)
  if (node.children !== undefined) texts(node.children, out)
  return out
}
const nodes = (node, pred, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const item of node) nodes(item, pred, out); return out }
  if (typeof node !== 'object') return out
  const rendered = expand(node)
  if (rendered !== node) return nodes(rendered, pred, out)
  if (node.type !== undefined && pred(node)) out.push(node)
  if (node.children !== undefined) nodes(node.children, pred, out)
  return out
}
const styleIs = (pred) => (node) => node.props !== undefined && node.props.style !== undefined && pred(node.props.style)

let pass = 0
const fails = []
const check = (name, ok, detail) => {
  if (ok) pass += 1
  else fails.push(detail === undefined ? name : name + ' -- ' + JSON.stringify(detail))
}

// --- fixtures -------------------------------------------------------------
const now = Date.now()
const day = 86400000
const durableDays = []
for (let i = 219; i >= 0; i -= 1) {
  durableDays.push({
    day: new Date(now - i * day).toISOString().slice(0, 10),
    requests: 3,
    uncachedInputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 8000,
    cacheWriteTokens: 50,
    reasoningTokens: 10,
    promptTokens: 9050,
    completionTokens: 100,
    totalTokens: 9150,
    cacheHitRate: 8000 / 9050,
  })
}
const ledgerPayload = {
  version: 1,
  file: '/data/dsh/token-usage/requests.jsonl',
  lines: 1200,
  rows: 900,
  appended: 12,
  failures: 0,
  firstTime: now - 220 * day,
  lastTime: now - 1000,
  totals: {
    requests: 2700,
    uncachedInputTokens: 220000,
    outputTokens: 22000,
    cacheReadTokens: 1790000,
    cacheWriteTokens: 11000,
    reasoningTokens: 2200,
    promptTokens: 2021000,
    completionTokens: 22000,
    totalTokens: 2043000,
    cacheHitRate: 1790000 / 2021000,
    speed: 180,
  },
  days: durableDays,
  models: [],
  channels: [],
  sessions: [],
  recent: [],
  limits: {},
}

const projectionRow = (over) => ({
  turn: 1, step: 1, time: now - 60000, provider: 'relay-a', model: 'model-x',
  uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 5,
  reasoningTokens: 1, streamed: true, latencyMs: 1500, firstTokenMs: 300, generationMs: 1200, ...over,
})
const sessionState = (rows) => ({
  ids: rows.length === 0 ? [] : ['s1'],
  byId: { s1: { id: 's1', title: '会话一', updatedAt: now } },
  projectionsBySession: rows.length === 0 ? {} : { s1: { values: { requestLog: rows }, state: 'ready' } },
})

const cleanups = []
const render = (state, impl) => {
  fetchImpl = impl
  hooks = []
  cursor = 0
  pending = []
  const tree = Panel({ useSessions: (select) => select(state) })
  const effects = pending
  pending = []
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return { tree, rerender: () => { cursor = 0; return Panel({ useSessions: (select) => select(state) }) } }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// --- 1. route answers: the storage block and a durable year view ----------
{
  const { tree, rerender } = render(sessionState([projectionRow({})]), async () => ({ ok: true, json: async () => ledgerPayload }))
  await tick(); await tick()
  const after = rerender()
  const all = texts(after)
  for (const label of ['请求', '合计 tokens', '缓存命中率', '输出速度']) {
    check('headline shows ' + label, all.includes(label), all.filter((t) => t.length < 12).slice(0, 16))
  }
  check('the year grid reports active days', all.some((t) => t.includes('天有记录')), all.filter((t) => t.includes('记录')))
  // Today's own figure: always present, always today, never the filter.
  check('the header carries today', all.some((t) => t.startsWith('今日 ')), all.filter((t) => t.startsWith('今日')))
  check('today shows a token figure', all.some((t) => t.endsWith(' tokens')), all.filter((t) => t.includes('tokens')).slice(0, 4))
  check('today says where it came from', all.some((t) => t.includes('账本') || t.includes('按保留记录')), all.filter((t) => t.includes('保留') || t.includes('账本')))
  // The live gauge counts the Sessions the Host reports as running; the fixture
  // has none, so it must read zero rather than disappear.
  check('the header carries the live gauge', all.includes('运行中'), all.filter((t) => t.includes('运行')))
  const at = all.indexOf('运行中')
  check('an idle composition reads zero', at >= 0 && all[at + 1] === '0', all.slice(Math.max(0, at - 2), at + 3))
  check('the storage line is live and names the file', all.some((t) => t.includes('已落盘') && t.includes('requests.jsonl')), all.filter((t) => t.includes('落盘')))
  check('the storage line counts the durable requests', all.some((t) => t.includes('2,700 次请求')), all.filter((t) => t.includes('2,700')))
  // The year grid is 53 weeks of 7 days whatever the data covers: a fixed frame is
  // what makes two months of history and two years of history comparable.
  const heatCells = nodes(after, styleIs((s) => s.aspectRatio === '1 / 1'))
  check('the year grid is 53 weeks of cells', heatCells.length === 53 * 7, heatCells.length)
  check('the year grid counts active days', all.some((t) => t.includes('220 天有记录')), all.filter((t) => t.includes('有记录')))
  // 220 durable days x 9,150 tokens = 2.01M.
  check('the year total comes from the durable days', all.some((t) => t.includes('2.01M tokens')), all.filter((t) => t.includes('tokens')))

  // The trend covers the newest 30 days of the durable series. Asserting a fixed
  // total would be time-of-day dependent: the fixture's days are laid out by
  // subtracting 24 h, while the panel windows by calendar day, so a run that
  // crosses midnight legitimately holds 29 days of data in a 30-day window.
  // Read the rendered span and the rendered total instead, and check they agree.
  const trendTitle = all.find((t) => /^近 \d+ 天用量$/.test(t))
  const span = trendTitle === undefined ? 0 : Number(/近 (\d+) 天/.exec(trendTitle)[1])
  check('the trend window is the 30-day cap', span === 30, trendTitle)
  const dayTotal = 9150
  const rendered = all.find((t) => /^合计 .+ · 峰值 /.test(t)) ?? ''
  const match = /合计 ([\d.,]+[KM]?) · 峰值/.exec(rendered)
  const compactOf = (value) => (value < 10000 ? String(value)
    : value < 1000000 ? (value / 1000).toFixed(1) + 'K'
      : (value / 1000000).toFixed(2) + 'M')
  const expected = [compactOf(span * dayTotal), compactOf((span - 1) * dayTotal)]
  check('the trend total matches its own window', match !== null && expected.includes(match[1]), { rendered, expected })
  const bars = nodes(after, styleIs((s) => s.flexBasis === 0 && typeof s.flexGrow === 'number'))
  check('the trend still stacks its buckets', bars.length > 0, bars.length)
  const line = nodes(after, (node) => node.type === 'polyline')
  check('the hit rate is drawn as a line', line.length > 0, line.length)
  const grid = nodes(after, styleIs((s) => typeof s.bottom === 'string' && typeof s.borderTop === 'string'))
  check('the plot carries horizontal gridlines', grid.length >= 4, grid.length)
}

// --- 2. no route: the panel degrades to the projection --------------------
{
  const { tree, rerender } = render(sessionState([projectionRow({})]), async () => { throw new Error('offline') })
  await tick(); await tick()
  const after = rerender()
  const all = texts(after)
  check('the storage line states it is unconnected', all.some((t) => t.startsWith('未连接')), all.filter((t) => t.includes('未连接')))
  check('the projection still renders', all.some((t) => t.includes('relay-a')), all.filter((t) => t.includes('relay-a')).slice(0, 4))
  const heatCells = nodes(after, styleIs((s) => s.aspectRatio === '1 / 1'))
  check('the year grid keeps its frame without a ledger', heatCells.length === 53 * 7, heatCells.length)
}

// --- 3. the projection is gone, the file is not --------------------------
{
  const recent = []
  for (let i = 0; i < 5; i += 1) {
    recent.push({ key: 's9|1|' + i + '|0', session: 's9', ...projectionRow({ step: i, time: now - i * 1000 }) })
  }
  const payload = { ...ledgerPayload, recent, rows: 5, lines: 5 }
  const { rerender } = render(sessionState([]), async () => ({ ok: true, json: async () => payload }))
  await tick(); await tick()
  const after = rerender()
  const all = texts(after)
  check('an empty projection no longer reads as no data', !all.some((t) => t.includes('还没有取到请求日志')))
  check('the storage line still reports the file', all.some((t) => t.includes('已落盘')), all.filter((t) => t.includes('落盘')))
  // Switch the panel to the request table: the view lives in panel state, so the
  // hook slot holding it is where the harness reaches it.
  const viewSlot = hooks.find((slot) => slot !== undefined && slot.value === 'overview')
  check('the view state was found', viewSlot !== undefined)
  if (viewSlot !== undefined) {
    viewSlot.value = 'requests'
    const table = rerender()
    const tableText = texts(table)
    check('durable rows reach the request table', tableText.includes('relay-a'), tableText.filter((t) => t.includes('relay-a')).slice(0, 3))
    check('the table reports its row count', tableText.some((t) => t.includes('共 5 条')), tableText.filter((t) => t.includes('条')).slice(0, 6))
    const bodyRows = nodes(table, (node) => node.type === 'tr' && node.props.className === 'dsh-tu-row')
    check('one table row per durable attempt', bodyRows.length === 5, bodyRows.length)
  }
}

// --- 4. the live gauge follows the Session list's running flag ------------
{
  const busy = {
    ids: ['s1', 's2', 's3'],
    byId: {
      s1: { id: 's1', title: '会话一', updatedAt: now, running: true, agentAvailable: true },
      s2: { id: 's2', title: '会话二', updatedAt: now, running: true, agentAvailable: true },
      s3: { id: 's3', title: '会话三', updatedAt: now, running: false, agentAvailable: true },
    },
    projectionsBySession: { s1: { values: { requestLog: [projectionRow({})] }, state: 'ready' } },
  }
  const { rerender } = render(busy, async () => ({ ok: true, json: async () => ledgerPayload }))
  await tick(); await tick()
  const all = texts(rerender())
  const at = all.indexOf('运行中')
  check('two running Sessions read as two', at >= 0 && all[at + 1] === '2', all.slice(Math.max(0, at - 1), at + 3))
  check('the gauge carries a tooltip naming them', (() => {
    const pills = nodes(rerender(), (node) => node.props !== undefined && typeof node.props.title === 'string' && node.props.title.includes('正在运行'))
    return pills.length === 1 && pills[0].props.title.includes('会话一') && pills[0].props.title.includes('会话二')
  })())
}

for (const cleanup of cleanups) cleanup()
console.log(pass + ' passed, ' + fails.length + ' failed')
for (const failure of fails) console.log('  FAIL ' + failure)
process.exit(fails.length > 0 ? 1 : 0)
