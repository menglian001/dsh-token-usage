/**
 * Interaction check for the overview's drill-down.
 *
 * Renders the real panel with a working hook shim, then clicks the marks the panel
 * draws — a trend bar, a heat cell, a channel row, a card, a group row — and reads
 * the tree it renders next. A handler that is wired to nothing, or one that sets
 * the wrong filter, cannot pass: the assertions are on the row counts and the view
 * the click actually produced.
 *
 *   node test/drill-check.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const DAY = 86400000;

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; return; }
  fails.push(detail === undefined ? name : name + ' — ' + detail);
};

const pad = (n) => String(n).padStart(2, '0');
const dayKeyOf = (t) => {
  const d = new Date(t);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const labelOf = (t) => dayKeyOf(t).slice(5);
// Noon, so a run that crosses local midnight cannot change which day a row is in.
const noonBack = (back) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime() - back * DAY;
};

/** Rows for the given number of days, three per day, two channels and two models. */
function makeRows(days) {
  const rows = [];
  for (let back = 0; back < days; back += 1) {
    for (let i = 0; i < 3; i += 1) {
      rows.push({
        time: noonBack(back) + i * 60000,
        turn: 1,
        step: i,
        provider: i === 1 ? 'relay-b' : 'relay-a',
        model: i === 2 ? 'model-small' : 'model-large',
        uncachedInputTokens: 100000,
        cacheReadTokens: 800000 + back * 1000 + i * 100,
        cacheWriteTokens: 0,
        outputTokens: 20000 + i * 100,
        reasoningTokens: 0,
        streamed: true,
        latencyMs: 9000 + i * 1000,
        firstTokenMs: 2000 + i * 100,
        generationMs: 6000 + i * 500,
      });
    }
  }
  return rows;
}

/**
 * Load the shipped client half in its own VM and return a renderer for the panel.
 *
 * Without a ledger the panel stays on the retained rows, which is the state a
 * fresh install is in; with one, the charts read the durable days instead.
 */
function loadPanel(options) {
  const rows = options.rows;
  const ledger = options.ledger;
  let moduleObj = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (m) => { moduleObj = m; } } },
    console,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
    clearInterval: (id) => clearInterval(id),
    fetch: () => (ledger === undefined
      ? Promise.resolve({ ok: false })
      : Promise.resolve({ ok: true, json: async () => ledger })),
    AbortController,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'client.js' });

  // Two hook scopes: one for the panel, one for expanding the components it
  // returns. Sharing one would let a Dropdown's refs consume the panel's slots.
  const scopes = { render: [], expand: [] };
  let scope = 'render';
  let cursor = 0;
  let pending = [];
  const slots = () => scopes[scope];
  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && typeof c !== 'boolean'),
    }),
    useState(init) {
      const i = cursor++;
      const store = slots();
      if (store[i] === undefined) store[i] = { value: typeof init === 'function' ? init() : init };
      return [store[i].value, (next) => {
        store[i].value = typeof next === 'function' ? next(store[i].value) : next;
      }];
    },
    useMemo(fn, deps) {
      const i = cursor++;
      const store = slots();
      const slot = store[i];
      if (slot === undefined || deps === undefined || slot.deps === undefined
        || deps.length !== slot.deps.length || deps.some((d, k) => d !== slot.deps[k])) {
        store[i] = { value: fn(), deps };
      }
      return store[i].value;
    },
    useRef(init) {
      const i = cursor++;
      const store = slots();
      if (store[i] === undefined) store[i] = { value: { current: init } };
      return store[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const store = slots();
      const slot = store[i];
      if (slot === undefined || deps === undefined || slot.deps === undefined
        || deps.length !== slot.deps.length || deps.some((d, k) => d !== slot.deps[k])) {
        store[i] = { deps };
        pending.push(fn);
      }
    },
    useCallback: (fn) => fn,
  };
  const plugin = moduleObj.factory((name) => {
    if (name === 'react') return react;
    throw new Error('unexpected require: ' + name);
  });
  let Panel = null;
  plugin.apply({
    slots: {
      inject: (slot, factory) => { factory(); return () => {}; },
      register: (opts, component) => { if (opts.name === 'main') Panel = component; return () => {}; },
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
  });

  const state = {
    ids: ['s1'],
    byId: { s1: { id: 's1', title: '示例会话', updatedAt: Date.now(), running: false, agentAvailable: true } },
    projectionsBySession: { s1: { values: { requestLog: rows }, state: 'ready' } },
  };

  /** Expand every function component the panel returned. */
  const expand = (node) => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === 'function') return expand(node.type(node.props ?? {}));
    return { type: node.type, props: node.props, children: node.children.map(expand) };
  };

  return {
    /** Render once and return the expanded tree. */
    render() {
      scope = 'render';
      cursor = 0;
      pending = [];
      const tree = Panel({ useSessions: (select) => select(state) });
      const effects = pending;
      pending = [];
      for (const effect of effects) { const cleanup = effect(); void cleanup; }
      scope = 'expand';
      cursor = 0;
      return expand(tree);
    },
  };
}

/** Every element in the tree, depth first. */
function all(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) all(child, out); return out; }
  out.push(node);
  for (const child of node.children) all(child, out);
  return out;
}

/** The text a subtree renders. */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  return node.children.map(textOf).join('');
}

const byClass = (tree, name) => all(tree).filter((node) => String(node.props.className ?? '').split(' ').includes(name));
const texts = (tree) => all(tree).map((node) => textOf(node));
const hasText = (tree, wanted) => texts(tree).some((text) => text.trim() === wanted);
const countLine = (tree) => texts(tree).map((text) => text.trim()).find((text) => /^共 [\d,]+ 条$/.test(text));
const tabSelected = (tree, label) => all(tree).some((node) => node.type === 'button'
  && node.props.role === 'tab' && node.props['aria-selected'] === true && textOf(node).trim() === label);
const cardValue = (tree, label) => {
  const card = byClass(tree, 'dsh-tu-card').find((node) => textOf(node.children[0]).trim().startsWith(label));
  return card === undefined ? undefined : textOf(card.children[1]).trim();
};
const groupRows = (tree) => all(tree).filter((node) => node.type === 'tr'
  && String(node.props.className ?? '').includes('dsh-tu-row'));
const clickTab = (tree, label) => all(tree).find((node) => node.props.role === 'tab' && textOf(node).trim() === label);
// The ledger arrives through fetch, so one macrotask has to pass before it is in
// state; a synchronous render loop would otherwise never see it.
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

// ---------------------------------------------------------------------------
// A. Retained rows only: the state a fresh install is in.
// ---------------------------------------------------------------------------
{
  const rows = makeRows(5);
  const panel = loadPanel({ rows });
  let tree = panel.render();
  const today = labelOf(noonBack(0));
  const threeBack = labelOf(noonBack(3));

  const bars = byClass(tree, 'dsh-tu-bar');
  check('概览画出有量的柱子', bars.length === 5, String(bars.length));
  check('柱子可以点', bars.every((bar) => typeof bar.props.onClick === 'function'));
  check('柱子可以按回车', bars.every((bar) => typeof bar.props.onKeyDown === 'function'));
  const emptyBars = all(tree).filter((node) => /无请求$/.test(String(node.props.title ?? '')));
  check('没有量的柱子没有点击', emptyBars.length > 0 && emptyBars.every((bar) => bar.props.onClick === undefined),
    String(emptyBars.length));

  // --- click today's bar ---
  bars[bars.length - 1].props.onClick();
  tree = panel.render();
  check('柱子点击切到请求日志', tabSelected(tree, '请求日志'));
  check('柱子点击只留那一天的 3 条', countLine(tree) === '共 3 条', String(countLine(tree)));
  check('没有账本时不做覆盖披露', texts(tree).every((text) => !text.includes('账本这一天')));
  // A drilled slice is a window, so the trend must narrow with it instead of
  // restating the whole history beside a card that says one day.
  clickTab(tree, '概览').props.onClick();
  tree = panel.render();
  check('下钻后柱子只剩那一段', byClass(tree, 'dsh-tu-bar').length === 1,
    String(byClass(tree, 'dsh-tu-bar').length));
  clickTab(tree, '请求日志').props.onClick();
  tree = panel.render();
  check('下钻后「请求」卡片同步为 3', cardValue(tree, '请求') === '3', String(cardValue(tree, '请求')));
  check('出现带日期与叉的下钻按钮', hasText(tree, today + ' 全天 ×'));

  const chip = all(tree).find((node) => textOf(node).trim() === today + ' 全天 ×');
  check('下钻按钮是按钮', chip !== undefined && chip.type === 'button');
  chip.props.onClick();
  tree = panel.render();
  check('清除下钻回到全部', cardValue(tree, '请求') === '15', String(cardValue(tree, '请求')));
  // The chip clears the slice, not the view: the reader stays where the click put them.
  check('清除下钻停在原视图', tabSelected(tree, '请求日志'));

  clickTab(tree, '概览').props.onClick();
  tree = panel.render();
  const bar = byClass(tree, 'dsh-tu-bar')[0];
  bar.props.onKeyDown({ key: 'Enter', preventDefault() {} });
  tree = panel.render();
  check('回车等于点击', tabSelected(tree, '请求日志') && countLine(tree) === '共 3 条', String(countLine(tree)));
  all(tree).find((node) => textOf(node).trim().endsWith('×')).props.onClick();
  tree = panel.render();
  clickTab(tree, '概览').props.onClick();
  tree = panel.render();

  // --- heat map ---
  const cells = byClass(tree, 'dsh-tu-cell');
  check('有记录的日子才可点', cells.length === 5, String(cells.length));
  const target = cells.find((cell) => String(cell.props.title).startsWith(dayKeyOf(noonBack(3))));
  check('热力图格子带日期', target !== undefined);
  target.props.onClick();
  tree = panel.render();
  check('点格子只留那一天的 3 条', countLine(tree) === '共 3 条', String(countLine(tree)));
  check('点格子写上那一天', hasText(tree, threeBack + ' 全天 ×'));
  all(tree).find((node) => textOf(node).trim() === threeBack + ' 全天 ×').props.onClick();
  tree = panel.render();
  clickTab(tree, '概览').props.onClick();
  tree = panel.render();
  check('未来格子不可点', all(tree).every((node) => node.props.style?.opacity !== 0
    || node.props.onClick === undefined));
  check('回到概览后仍是 15 条', cardValue(tree, '请求') === '15', String(cardValue(tree, '请求')));

  // --- channel rows ---
  const channelRow = byClass(tree, 'dsh-tu-channel')[0];
  check('渠道行可以点', channelRow !== undefined && typeof channelRow.props.onClick === 'function');
  channelRow.props.onClick();
  tree = panel.render();
  check('点渠道行只看这个渠道', countLine(tree) === '共 10 条', String(countLine(tree)));
  check('渠道下拉跟着变', texts(tree).some((text) => text.trim() === 'relay-a'));
  check('出现清除筛选', hasText(tree, '清除筛选'));

  // --- drill composes with a picker filter ---
  clickTab(tree, '概览').props.onClick();
  tree = panel.render();
  byClass(tree, 'dsh-tu-bar')[0].props.onClick();
  tree = panel.render();
  // relay-a is two of the three rows a day, so one day under that filter is two.
  check('渠道 + 下钻叠加为 2 条', countLine(tree) === '共 2 条', String(countLine(tree)));
  all(tree).find((node) => textOf(node).trim() === '清除筛选').props.onClick();
  tree = panel.render();
  check('清除筛选同时清掉下钻', countLine(tree) === '共 15 条', String(countLine(tree)));

  // --- cards ---
  clickTab(tree, '概览').props.onClick();
  tree = panel.render();
  check('四张主卡片都可点', byClass(tree, 'dsh-tu-card').length >= 4, String(byClass(tree, 'dsh-tu-card').length));
  const totalCard = byClass(tree, 'dsh-tu-card').find((node) => textOf(node.children[0]).includes('合计 tokens'));
  totalCard.props.onClick();
  tree = panel.render();
  check('合计卡片到日期视图', tabSelected(tree, '日期'));
  check('日期视图按天分组为 5 组', groupRows(tree).length === 5, String(groupRows(tree).length));

  // --- group rows ---
  groupRows(tree)[0].props.onClick();
  tree = panel.render();
  check('日期分组行下钻到那一天', countLine(tree) === '共 3 条', String(countLine(tree)));
  clickTab(tree, '概览').props.onClick();
  tree = panel.render();

  // --- metric cards carry a sort ---
  all(tree).find((node) => textOf(node).trim().startsWith('更多指标')).props.onClick();
  tree = panel.render();
  const latencyCard = byClass(tree, 'dsh-tu-card').find((node) => textOf(node.children[0]).includes('平均耗时'));
  check('更多指标里有平均耗时卡片', latencyCard !== undefined);
  latencyCard.props.onClick();
  tree = panel.render();
  const latencyHeader = all(tree).find((node) => node.type === 'th' && textOf(node).includes('耗时'));
  check('平均耗时卡片把表按耗时降序', latencyHeader !== undefined
    && latencyHeader.props['aria-sort'] === 'descending', String(latencyHeader?.props['aria-sort']));

  // --- the request log's own day rule ---
  // Day rules only exist under a chronological order, which the header sets.
  all(tree).find((node) => node.type === 'th' && textOf(node).includes('时间')).props.onClick();
  tree = panel.render();
  const dayRow = all(tree).find((node) => node.props.role === 'button'
    && String(node.props.title ?? '') === '只看这一天的请求');
  check('日期分隔行可点', dayRow !== undefined);
  dayRow.props.onClick();
  tree = panel.render();
  check('日期分隔行下钻到那一天', countLine(tree) === '共 3 条', String(countLine(tree)));
  check('日期分隔行有下钻按钮', texts(tree).some((text) => text.trim().endsWith('全天 ×')));
}

// ---------------------------------------------------------------------------
// B. With the ledger: the charts read the durable days, so a bar can name a day
//    the retained rows no longer hold. The panel must say so, not pretend.
// ---------------------------------------------------------------------------
{
  const rows = makeRows(5);
  const days = [];
  for (let back = 29; back >= 0; back -= 1) {
    const tokens = back === 12 ? 9000000 : 1000000 + back * 1000;
    days.push({
      day: dayKeyOf(noonBack(back)),
      requests: 3,
      uncachedInputTokens: Math.round(tokens / 10),
      cacheReadTokens: Math.round(tokens / 2),
      cacheWriteTokens: 0,
      outputTokens: Math.round(tokens / 4),
      reasoningTokens: 0,
      promptTokens: Math.round(tokens / 10 + tokens / 2),
      completionTokens: Math.round(tokens / 4),
      totalTokens: tokens,
      cacheHitRate: 0.83,
      avgLatencyMs: 11000,
      avgFirstTokenMs: 2500,
      avgGenerationMs: 8500,
      timedRequests: 3,
      speed: 140,
    });
  }
  const sum = (key) => days.reduce((acc, entry) => acc + entry[key], 0);
  const channel = (name, share) => ({
    provider: name,
    requests: Math.round(sum('requests') * share),
    uncachedInputTokens: Math.round(sum('uncachedInputTokens') * share),
    cacheReadTokens: Math.round(sum('cacheReadTokens') * share),
    cacheWriteTokens: 0,
    outputTokens: Math.round(sum('outputTokens') * share),
    reasoningTokens: 0,
    promptTokens: Math.round(sum('promptTokens') * share),
    completionTokens: Math.round(sum('outputTokens') * share),
    totalTokens: Math.round(sum('totalTokens') * share),
    cacheHitRate: 0.83,
    avgLatencyMs: 11000,
    timedRequests: 10,
    speed: 140,
  });
  const ledger = {
    version: 1,
    file: '~/.dsh/token-usage/requests.jsonl',
    lines: 90,
    rows: 90,
    appended: 0,
    failures: 0,
    firstTime: noonBack(29),
    lastTime: noonBack(0),
    totals: {
      requests: 90,
      uncachedInputTokens: sum('uncachedInputTokens'),
      cacheReadTokens: sum('cacheReadTokens'),
      cacheWriteTokens: 0,
      outputTokens: sum('outputTokens'),
      reasoningTokens: 0,
      promptTokens: sum('promptTokens'),
      completionTokens: sum('outputTokens'),
      totalTokens: sum('totalTokens'),
      cacheHitRate: 0.83,
      avgLatencyMs: 11000,
      avgFirstTokenMs: 2500,
      avgGenerationMs: 8500,
      timedRequests: 90,
      speed: 140,
    },
    days,
    models: [{ ...channel('relay-a', 0.6), model: 'model-large' }],
    channels: [channel('relay-a', 0.6), channel('relay-b', 0.4)],
    sessions: [{ session: 's1' }],
    recent: [],
    sweep: { at: Date.now(), sessions: 1, rows: 90 },
    live: { steps: 0, sessions: 0, at: Date.now() },
    limits: {},
  };

  const panel = loadPanel({ rows, ledger });
  let tree = panel.render();
  await settle();
  tree = panel.render();

  // The durable series reaches 30 days, so the chart must not stop at the rows.
  const bars = byClass(tree, 'dsh-tu-bar');
  check('账本在时柱子铺满 30 天', bars.length >= 28, String(bars.length));

  const lonely = labelOf(noonBack(12));
  const lonelyBar = bars.find((bar) => String(bar.props.title).includes(lonely));
  check('账本里的老日子也有柱子', lonelyBar !== undefined);
  lonelyBar.props.onClick();
  tree = panel.render();
  const emptyText = texts(tree).find((text) => text.includes('没有记录'));
  check('老日子没有保留记录时说清楚', emptyText !== undefined, String(emptyText));
  check('老日子下钻写着日期', String(emptyText ?? '').includes(lonely + ' 全天'), String(emptyText));
  // The ledger knows the whole day; the table only knows the retained rows. Both
  // numbers have to appear, or the smaller one reads as the day's real total.
  const gapNote = texts(tree).find((text) => text.includes('账本这一天'));
  check('账本与保留记录不一致时说清楚', gapNote !== undefined, String(gapNote));
  check('披露里带账本次数', String(gapNote ?? '').includes('3 次'), String(gapNote));
  check('披露里带列表条数', String(gapNote ?? '').includes('列表里只有 0 条'), String(gapNote));

  // Back to the whole history before switching views, or the ledger aggregates
  // stay off and there is nothing to read.
  all(tree).find((node) => textOf(node).trim().endsWith('全天 ×')).props.onClick();
  tree = panel.render();

  // The channel view reads the ledger; its rows must still be usable as filters.
  clickTab(tree, '渠道').props.onClick();
  tree = panel.render();
  const channelRows = groupRows(tree);
  check('渠道视图读账本的两组', channelRows.length === 2, String(channelRows.length));
  channelRows[0].props.onClick();
  tree = panel.render();
  check('点账本的渠道行按渠道筛选', texts(tree).some((text) => text.trim() === 'relay-a'));
  check('按渠道筛选后读保留记录', countLine(tree) === '共 10 条', String(countLine(tree)));
}

if (fails.length > 0) {
  console.error('drill-check: ' + fails.length + ' failed, ' + pass + ' passed');
  for (const fail of fails) console.error('  FAIL ' + fail);
  process.exit(1);
}
console.log('drill-check: ' + pass + ' passed');
