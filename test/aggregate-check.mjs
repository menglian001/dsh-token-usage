
/**
 * The grouped views read the ledger's aggregates when they can, and fall back to
 * the retained rows when they cannot.
 *
 * The bug this pins down: a past day folded from the browser's rows reports less
 * every time the Session's window slides, so the same day appeared to shrink.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let moduleObj = null
let fetchImpl = async () => { throw new Error('offline') }
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

let hooks = []
let cursor = 0
let pending = []
const cleanups = []
const react = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && typeof c !== 'boolean'),
  }),
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
  useRef(init) { const i = cursor++; if (hooks[i] === undefined) hooks[i] = { value: { current: init } }; return hooks[i].value },
  useEffect(fn, deps) {
    const i = cursor++
    const slot = hooks[i]
    if (slot === undefined || deps === undefined || slot.deps === undefined || deps.some((d, k) => d !== slot.deps[k])) {
      hooks[i] = { deps }
      pending.push(fn)
    }
  },
  useCallback: (fn) => fn,
}
const plugin = moduleObj.factory((name) => {
  if (name === 'react') return react
  throw new Error('unexpected require: ' + name)
})
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

const render = (state, impl) => {
  if (impl !== undefined) fetchImpl = impl
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

// --- fixtures -------------------------------------------------------------
const now = Date.now()
const day = 86400000
const pad = (n) => String(n).padStart(2, '0')
const dayKeyOf = (time) => {
  const d = new Date(time)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
const agg = (tokens, requests) => ({
  requests,
  uncachedInputTokens: Math.round(tokens * 0.01),
  outputTokens: Math.round(tokens * 0.001),
  cacheReadTokens: Math.round(tokens * 0.989),
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  promptTokens: Math.round(tokens * 0.999),
  completionTokens: Math.round(tokens * 0.001),
  totalTokens: tokens,
  cacheHitRate: 0.99,
  avgLatencyMs: 1000,
  avgFirstTokenMs: 200,
  avgGenerationMs: 800,
  timedRequests: requests,
  speed: 150,
})
// Five days in the ledger, 100,100 tokens each; 500 attempts in total.
const durableDays = []
for (let i = 4; i >= 0; i -= 1) durableDays.push({ day: dayKeyOf(now - i * day), ...agg(100100, 10) })
const ledgerPayload = {
  version: 1,
  file: '/data/dsh/token-usage/requests.jsonl',
  lines: 520,
  rows: 500,
  appended: 5,
  failures: 0,
  firstTime: now - 4 * day,
  lastTime: now,
  totals: agg(500500, 500),
  days: durableDays,
  models: [{ provider: 'relay-a', model: 'model-x', ...agg(500500, 500) }],
  channels: [{ provider: 'relay-a', ...agg(500500, 500) }],
  sessions: [{ session: 's1' }, { session: 's2' }],
  recent: [],
  sweep: { at: now, sessions: 9, rows: 400 },
  limits: {},
}

// The browser's retained rows: only today, three of them.
const rows = []
for (let i = 0; i < 3; i += 1) {
  rows.push({
    turn: 1, step: i, time: now - i * 1000, provider: 'relay-a', model: 'model-x',
    uncachedInputTokens: 10, outputTokens: 1, cacheReadTokens: 99, cacheWriteTokens: 0,
    reasoningTokens: 0, streamed: true, latencyMs: 1000, firstTokenMs: 200, generationMs: 800,
  })
}
const state = {
  ids: ['s1'],
  byId: { s1: { id: 's1', title: '会话一', updatedAt: now } },
  projectionsBySession: { s1: { values: { requestLog: rows }, state: 'ready' } },
}

const fails = []
const check = (name, ok, detail) => { if (!ok) fails.push(name + (detail === undefined ? '' : ' -- ' + JSON.stringify(detail))) }
const switchTo = (rerender, id) => {
  const slot = hooks.find((entry) => entry !== undefined && entry.value === 'overview')
  if (slot !== undefined) slot.value = id
  return rerender()
}

// --- 1. the ledger is ahead: the day table and the strip read it -----------
{
  const { rerender } = render(state, async () => ({ ok: true, json: async () => ledgerPayload }))
  await tick(); await tick()
  const tree = switchTo(rerender, 'day')
  const all = texts(tree)
  check('the strip reads the ledger', all.some((t) => t === '500.5K'), all.filter((t) => t.endsWith('K')).slice(0, 6))
  check('the source is named', all.some((t) => String(t).includes('本页数字读账本')), all.filter((t) => String(t).includes('本页')))
  const bodyRows = nodes(tree, (node) => node.type === 'tr' && node.props.className === 'dsh-tu-row')
  check('one table row per recorded day', bodyRows.length === 5, bodyRows.length)
  check('a past day keeps its figure', all.filter((t) => t === '100.1K').length === 5, all.filter((t) => t === '100.1K').length)
}

// --- 2. no ledger: the rows answer, and say so ----------------------------
{
  const { rerender } = render(state, async () => { throw new Error('offline') })
  await tick(); await tick()
  const tree = switchTo(rerender, 'day')
  const all = texts(tree)
  // With no ledger at all the footer says so instead of naming a source.
  check('the fallback is named', all.some((t) => String(t).includes('未连接')), all.filter((t) => String(t).includes('未连接')))
  const bodyRows = nodes(tree, (node) => node.type === 'tr' && node.props.className === 'dsh-tu-row')
  check('the rows answer for themselves', bodyRows.length === 1, bodyRows.length)
}

for (const cleanup of cleanups) cleanup()
console.log((fails.length === 0 ? 'PASS' : 'FAIL') + ' — ledger aggregates for the grouped views')
for (const failure of fails) console.log('  ' + failure)
process.exit(fails.length > 0 ? 1 : 0)
