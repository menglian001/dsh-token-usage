/**
 * Regenerate the storefront screenshots in docs/.
 *
 * Renders the panel's real component tree with invented data and captures it, so
 * the pictures cannot drift from the code they describe and cannot carry anyone's
 * usage figures — every session title, provider, model and token count below is
 * made up.
 *
 *   node scripts/screenshots.mjs --harness ../deepseek-harness
 *
 * Needs Playwright with a Chromium build. The theme sheets are read from the
 * Harness checkout so the render matches the live GUI rather than approximating
 * it; without them the panel's own tokens still work but the cards lose their
 * fills and strokes.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const harnessArg = process.argv.indexOf('--harness')
const HARNESS = harnessArg === -1 ? resolve(REPO, '..', 'deepseek-harness') : resolve(process.argv[harnessArg + 1])
const THEME_DIR = join(HARNESS, 'packages/client/ui-theme/src/styles')
if (!existsSync(join(THEME_DIR, 'design-platform.css'))) {
  console.error('no theme sheets under ' + THEME_DIR + ' — pass --harness /path/to/deepseek-harness')
  process.exit(2)
}
const src = readFileSync(REPO + '/client.js', 'utf8')
let moduleObj = null
const sandbox = {
  window: { __ModuleLoader__: { load: (m) => { moduleObj = m } } },
  console,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  // The panel calls fetch(...).then(...), so this has to be a real promise.
  fetch: (url) => {
    if (String(url).includes('token-usage/ledger')) {
      return Promise.resolve({ ok: true, json: async () => globalThis.__LEDGER__ })
    }
    return Promise.reject(new Error('offline'))
  },
  AbortController,
}
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })

let hooks = []
let cursor = 0
let pending = []
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

// ---- synthetic data -------------------------------------------------------
const now = Date.now()
const day = 86400000
const pad = (n) => String(n).padStart(2, '0')
const dayKeyOf = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
const PROVIDERS = ['relay-a', 'relay-b', 'relay-c']
const MODELS = ['model-large', 'model-small', 'model-fast']
const TITLES = ['示例会话 · 重构接口层', '示例会话 · 数据迁移脚本', '示例会话 · 单元测试补齐', '示例会话 · 文档整理', '示例会话 · 性能排查']

// 120 days of invented usage. The shape matters for a storefront picture: a
// weekday rhythm, quieter weekends, a couple of heavy days, and a cache hit rate
// that drifts instead of sitting on one number — a flat line reads as fake.
const durableDays = []
for (let i = 119; i >= 0; i -= 1) {
  const weekday = new Date(now - i * day).getDay()
  const weekend = weekday === 0 || weekday === 6
  const rhythm = 0.55 + 0.45 * Math.abs(Math.sin(i / 9.5))
  const spike = i === 34 || i === 61 ? 1.9 : 1
  const total = Math.round((14_000_000 + 62_000_000 * rhythm) * (weekend ? 0.45 : 1) * spike)
  const requests = Math.round((22 + 130 * rhythm) * (weekend ? 0.5 : 1))
  // Hit rate drifts with a slow wave and dips where the prompt mix changed.
  const hit = 0.58 + 0.34 * Math.abs(Math.cos(i / 17)) + (i % 7 === 0 ? -0.06 : 0)
  const cacheRead = Math.round(total * Math.min(0.93, hit))
  const uncached = Math.round(total * (1 - Math.min(0.93, hit)) * 0.82)
  const write = Math.round(total * 0.004)
  const output = total - cacheRead - uncached - write
  durableDays.push({
    day: dayKeyOf(now - i * day),
    requests,
    uncachedInputTokens: uncached,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: write,
    reasoningTokens: Math.round(output * 0.3),
    promptTokens: uncached + cacheRead + write,
    completionTokens: output,
    totalTokens: total,
    cacheHitRate: cacheRead / (uncached + cacheRead + write),
    avgLatencyMs: 14_000 + (i % 9) * 1_100,
    avgFirstTokenMs: 4_200 + (i % 7) * 640,
    avgGenerationMs: 9_800 + (i % 5) * 900,
    timedRequests: requests,
    speed: 120 + (i % 13) * 6,
  })
}

const sum = (key) => durableDays.reduce((acc, d) => acc + d[key], 0)
const totals = {
  requests: sum('requests'),
  uncachedInputTokens: sum('uncachedInputTokens'),
  outputTokens: sum('outputTokens'),
  cacheReadTokens: sum('cacheReadTokens'),
  cacheWriteTokens: sum('cacheWriteTokens'),
  reasoningTokens: sum('reasoningTokens'),
  promptTokens: sum('promptTokens'),
  completionTokens: sum('completionTokens'),
  totalTokens: sum('totalTokens'),
  cacheHitRate: sum('cacheReadTokens') / sum('promptTokens'),
  avgLatencyMs: sum('avgLatencyMs') / durableDays.length,
  avgFirstTokenMs: sum('avgFirstTokenMs') / durableDays.length,
  avgGenerationMs: sum('avgGenerationMs') / durableDays.length,
  timedRequests: sum('timedRequests'),
  speed: 168.4,
}

const group = (name, share) => ({
  provider: name,
  requests: Math.round(totals.requests * share),
  uncachedInputTokens: Math.round(totals.uncachedInputTokens * share),
  outputTokens: Math.round(totals.outputTokens * share),
  cacheReadTokens: Math.round(totals.cacheReadTokens * share),
  cacheWriteTokens: Math.round(totals.cacheWriteTokens * share),
  reasoningTokens: Math.round(totals.reasoningTokens * share),
  promptTokens: Math.round(totals.promptTokens * share),
  completionTokens: Math.round(totals.outputTokens * share),
  totalTokens: Math.round(totals.totalTokens * share),
  cacheHitRate: 0.9,
  avgLatencyMs: 16_000,
  timedRequests: Math.round(totals.requests * share),
  speed: 150,
})

const ledgerPayload = {
  version: 1,
  file: '~/.dsh/token-usage/requests.jsonl',
  lines: 8421,
  rows: 8390,
  appended: 37,
  failures: 0,
  firstTime: now - 119 * day,
  lastTime: now,
  totals,
  days: durableDays,
  models: [
    { provider: 'relay-a', model: 'model-large', ...group('relay-a', 0.55) },
    { provider: 'relay-a', model: 'model-small', ...group('relay-a', 0.21) },
    { provider: 'relay-b', model: 'model-fast', ...group('relay-b', 0.16) },
    { provider: 'relay-c', model: 'model-large', ...group('relay-c', 0.08) },
  ],
  channels: [group('relay-a', 0.76), group('relay-b', 0.16), group('relay-c', 0.08)],
  sessions: Array.from({ length: 14 }, (_v, i) => ({ session: 'demo-' + i })),
  recent: [],
  sweep: { at: now, sessions: 128, rows: 4102 },
  live: { steps: 2, sessions: 2, at: now },
  limits: {},
}

// rows for the request table
const rows = []
for (let i = 0; i < 60; i += 1) {
  const total = 480_000 + (i % 17) * 26_000
  const cacheRead = Math.round(total * (0.82 + (i % 5) * 0.02))
  const uncached = Math.round(total * 0.14)
  const output = total - cacheRead - uncached
  rows.push({
    turn: 1 + Math.floor(i / 6),
    step: i,
    time: now - i * 97_000,
    provider: PROVIDERS[i % 3],
    model: MODELS[i % 3],
    uncachedInputTokens: uncached,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    reasoningTokens: Math.round(output * 0.25),
    streamed: true,
    latencyMs: 9_000 + (i % 11) * 900,
    firstTokenMs: 2_400 + (i % 7) * 400,
    generationMs: 6_000 + (i % 5) * 700,
  })
}

const state = {
  ids: ['demo-1', 'demo-2'],
  byId: {
    'demo-1': { id: 'demo-1', title: TITLES[0], updatedAt: now, running: true, agentAvailable: true },
    'demo-2': { id: 'demo-2', title: TITLES[1], updatedAt: now - 60_000, running: true, agentAvailable: true },
  },
  // Two sessions with their own rows: sharing one array made the table look like
  // every attempt had been recorded twice.
  projectionsBySession: {
    'demo-1': {
      values: {
        requestLog: rows.filter((_row, index) => index % 2 === 0).map((row, index) => ({
          ...row, time: row.time - index * 1_100, turn: 1 + index,
        })),
      },
      state: 'ready',
    },
    'demo-2': {
      values: {
        requestLog: rows.filter((_row, index) => index % 2 === 1).map((row, index) => ({
          ...row, time: row.time - index * 3_700, turn: 1 + index,
        })),
      },
      state: 'ready',
    },
  },
}

// The panel reads the ledger through fetch; hand it the synthetic payload.
globalThis.__LEDGER__ = ledgerPayload

// ---- render ---------------------------------------------------------------
function render() {
  cursor = 0
  pending = []
  const tree = Panel({ useSessions: (select) => select(state) })
  const effects = pending
  pending = []
  for (const effect of effects) { const c = effect(); void c }
  return tree
}

const expand = (node) => {
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props ?? {}))
  return node
}

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])

// React appends px to numbers for dimensional properties; CSS does not. Without
// this, gap:12 and height:132 are invalid and the whole layout collapses.
const UNITLESS = new Set([
  'opacity', 'flexGrow', 'flexShrink', 'flex', 'zIndex', 'order', 'zoom',
  'aspectRatio', 'lineHeight', 'fontWeight', 'gridRow', 'gridColumn',
  'gridRowStart', 'gridRowEnd', 'gridColumnStart', 'gridColumnEnd', 'columnCount',
])

function styleOf(style) {
  if (style === undefined || style === null) return ''
  return Object.entries(style)
    .map(([k, v]) => {
      if (v === undefined || v === null) return ''
      const prop = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
      let value = typeof v === 'number' && v !== 0 && !UNITLESS.has(k) ? String(v) + 'px' : String(v)
      return prop + ':' + value + ';'
    })
    .filter(Boolean)
    .join('')
}

function toHtml(node, depth = 0) {
  if (depth > 200) return ''
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  if (Array.isArray(node)) return node.map((child) => toHtml(child, depth + 1)).join('')
  const el = expand(node)
  if (el !== node) return toHtml(el, depth + 1)
  const { type, props, children } = el
  if (type === undefined) return toHtml(children)
  if (typeof type === 'function') return toHtml(expand({ type, props, children }))
  const tag = String(type)
  const attrs = []
  if (props?.className) attrs.push('class="' + props.className + '"')
  const style = styleOf(props?.style)
  if (style) attrs.push('style="' + style.replace(/"/g, "'") + '"')
  if (props?.title) attrs.push('title="' + String(props.title).replace(/"/g, '&quot;') + '"')
  if (tag === 'input') {
    if (props?.placeholder) attrs.push('placeholder="' + props.placeholder + '"')
    if (props?.value) attrs.push('value="' + props.value + '"')
    attrs.push('readonly')
  }
  if (tag === 'svg') {
    for (const [k, v] of Object.entries(props ?? {})) {
      if (['viewBox', 'preserveAspectRatio', 'width', 'height'].includes(k)) attrs.push(k + '="' + v + '"')
    }
  }
  if (tag === 'polyline' || tag === 'polygon') {
    for (const [k, v] of Object.entries(props ?? {})) {
      if (k === 'points') attrs.push('points="' + v + '"')
      if (['fill', 'fillOpacity', 'stroke', 'strokeWidth', 'strokeLinejoin', 'strokeLinecap', 'vectorEffect'].includes(k)) {
        const name = k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
        attrs.push(name + '="' + v + '"')
      }
    }
  }
  const inner = VOID.has(tag) ? '' : toHtml(children, depth + 1)
  return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + inner + '</' + tag + '>'
}

// The real theme sheets: base.css carries the alias layer the panel's card
// styles reference, design-platform.css carries the palette those aliases point
// at. Loading both is what makes the render match the GUI.
const theme = ['base.css', 'design-platform.css', 'scrollbar.css']
  .map((name) => readFileSync(join(THEME_DIR, name), 'utf8'))
  .join('\n')

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Render one tab and return the HTML a browser can open. */
async function renderView(view) {
  hooks = []
  let tree = render()
  // The panel fetches the ledger asynchronously, so one pass is not enough:
  // render, let the promise settle, render again. Hook state survives between
  // passes, which is what lets the fetched payload reach the second render.
  for (let pass = 0; pass < 6; pass += 1) {
    await settle()
    await settle()
    tree = render()
  }
  if (view !== 'overview') {
    const slot = hooks.find((entry) => entry !== undefined && entry.value === 'overview')
    if (slot === undefined) throw new Error('view slot not found')
    slot.value = view
    for (let pass = 0; pass < 3; pass += 1) {
      await settle()
      tree = render()
    }
  }
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>',
    theme,
    'html, body { margin: 0; padding: 0; background: var(--dsw-alias-bg-base); }',
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }',
    '* { box-sizing: border-box; }',
    'table { border-collapse: collapse; }',
    '</style></head><body data-ds-dark-theme>',
    toHtml(tree),
    '</body></html>',
  ].join('')
}

// name, tab, crop height
const VIEWS = [
  ['overview', 'overview', 1100],
  ['requests', 'requests', 1080],
  ['channel', 'channel', 900],
  ['day', 'day', 900],
]

mkdirSync(join(REPO, 'docs'), { recursive: true })
const pages = []
for (const [name, view, height] of VIEWS) {
  const file = join(REPO, 'docs', '.preview-' + name + '.html')
  writeFileSync(file, await renderView(view))
  pages.push({ name, file, height })
  console.log('docs/.preview-' + name + '.html')
}

const playwright = await import('playwright').catch(() => null)
if (playwright === null) {
  console.error('playwright is not installed — the HTML previews above are ready to open')
  process.exit(2)
}

const browser = await playwright.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
for (const page of pages) {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1400 }, deviceScaleFactor: 2 })
  await tab.goto('file://' + page.file, { waitUntil: 'load' })
  await tab.waitForTimeout(400)
  const box = await tab.evaluate((limit) => {
    const el = document.querySelector('.dsh-tu-scope')
    if (el === null) return null
    return { x: 0, y: 0, width: 1440, height: Math.min(el.getBoundingClientRect().height, limit) }
  }, page.height)
  await tab.screenshot({ path: join(REPO, 'docs', 'screenshot-' + page.name + '.png'), clip: box })
  await tab.close()
  console.log('docs/screenshot-' + page.name + '.png')
}
await browser.close()
