/**
 * Client half of dsh-token-usage: the request log.
 *
 * Shaped like an API-gateway log page (new-api style): one dense table, one row
 * per billed request, with a filter bar and paging above it — not a dashboard.
 *
 * Data comes from two Host projections, both already computed on the Host, so
 * this module folds no session events itself:
 *
 * - `requestLog` (from this bundle's Host half) — one row per billed request
 *   attempt, with its provider and model.
 * - `tokenUsage` (from `@deepseek-ai/dsh-token-meter`) — per-Session cumulative
 *   buckets, reachable through the same baseline read. Not folded yet: the summary
 *   strip adds up the retained rows, so it stops at `MAX_REQUESTS` per Session
 *   while these totals never do.
 *
 * Reading path, and why this module pokes the Session service:
 *
 * The Session list carries only *hint* cells (`list.ts` `hintsOf`: "missing cells
 * and cache rows are never materialized here"), so a key that no list consumer
 * touches — `requestLog` — never reaches the Client through the list surface.
 * The complete baseline comes from the Session Controller's `projections`
 * remote, which the Client reads through `ctx.sessions.refreshProjections()`.
 * That read happens once per Session per connection, so this plugin issues it for
 * the listed Sessions the list never asked about. Without that, the projection is
 * registered and computed on the Host yet never crosses to the browser.
 *
 * Column mapping follows new-api:
 * 提示 = the whole prompt (input + cache read + cache write), 补全 = generated
 * output, 缓存读 shown separately because cache traffic is the billing swing.
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Panel id; the Settings page, the sidebar entry, and the main page share it. */
    const PANEL_ID = 'token-usage';

    /** Stand-in state, used only when the framework seat is unavailable. */
    const EMPTY_STATE = { ids: [], byId: {}, projectionsBySession: {} };
    const selectEmpty = (select) => select(EMPTY_STATE);

    /** Selectable rows per page. */
    const PAGE_SIZES = [20, 50, 100];
    const DEFAULT_PAGE_SIZE = 20;

    /**
     * Column count of the request-log table, used by the detail row's `colSpan`.
     * Keep in step with the header cells in `requestTable`.
     */
    const REQUEST_COLUMNS = 12;

    /**
     * Sessions re-read in one refresh pass: the ones still missing a baseline
     * first, then the most recently active ones, which grow as requests settle.
     */
    const REFRESH_PER_PASS = 12;

    /**
     * How stale a Session may be and still be re-read.
     *
     * A Session's ledger only grows while it is running, so re-reading an idle one
     * spends a remote round-trip to learn nothing. Without this cut a long Session
     * list costs one read per Session per pass however few are actually active. A
     * Session with no baseline is exempt: nothing else would ever fetch it.
     */
    const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

    /** How often that pass repeats, so a settled request reaches the panel. */
    const REFRESH_INTERVAL_MS = 10000;

    /**
     * Speed-pool thresholds, carried over from cc-switch: a request joins the
     * pooled output-speed ratio only when it has a real first-token measurement,
     * at least 100 output tokens, and at least 100ms of generation. Below that the
     * ratio is dominated by noise rather than by decode throughput.
     */
    const SPEED_MIN_OUTPUT_TOKENS = 100;
    const SPEED_MIN_GENERATION_MS = 100;

    /**
     * Selectable windows over the log, oldest-first in the picker. `ms` is the
     * lookback from now; `all` keeps every retained row.
     */
    const RANGES = [
      { id: 'all', label: '全部时间' },
      { id: '24h', label: '近 24 小时', ms: 24 * 60 * 60 * 1000 },
      { id: '7d', label: '近 7 天', ms: 7 * 24 * 60 * 60 * 1000 },
      { id: '30d', label: '近 30 天', ms: 30 * 24 * 60 * 60 * 1000 },
    ];

    /** The ways one filtered row set is presented; all read the same rows. */
    const VIEWS = [
      { id: 'overview', label: '概览' },
      { id: 'requests', label: '请求日志' },
      { id: 'model', label: '模型' },
      { id: 'channel', label: '渠道' },
      { id: 'day', label: '日期' },
    ];

    /** Days the trend chart spans when the window is unbounded. */
    const TREND_DAYS = 30;

    /** Days the heat map spans. */
    const HEATMAP_DAYS = 365;

    /**
     * The Host route serving the durable ledger.
     *
     * The projection is bounded per Session and a version bump discards it; the
     * append-only file behind this route is neither, so the totals, the trend and
     * the heat map read it whenever it answers. Relative on purpose: the page is
     * served under a mount the document's own base already resolves.
     */
    const LEDGER_URL = 'token-usage/ledger';

    /** How often the durable read repeats, ms. */
    const LEDGER_REFRESH_MS = 30000;

    /** Newest durable rows requested per read; the aggregates always cover everything. */
    const LEDGER_ROW_LIMIT = 400;

    /** A durable read that has not answered by now counts as unavailable, ms. */
    const LEDGER_TIMEOUT_MS = 8000;

    /**
     * Bucket definitions in display order.
     *
     * Four buckets, four hues — deliberately not one ramp at four lightness steps.
     * A ramp's neighbouring tones are indistinguishable at swatch size, which is
     * what made this panel read as one flat colour; the hue itself now carries the
     * meaning: blue is the full-price prompt, green the cache read (the discount),
     * amber the cache write (the surcharge), violet the generated output. That split
     * follows the platform's own multi-series display (`ContextMeter`), which also
     * falls back to a violet literal because the design system ships no purple
     * token. The values resolve in LOCAL_CSS per theme.
     */
    const BUCKETS = [
      { key: 'uncachedInputTokens', label: '缓存未命中', color: 'var(--tu-input)' },
      { key: 'cacheReadTokens', label: '缓存读', color: 'var(--tu-cache-read)' },
      { key: 'cacheWriteTokens', label: '缓存写', color: 'var(--tu-cache-write)' },
      { key: 'outputTokens', label: '补全', color: 'var(--tu-output)' },
    ];

    /** One bucket's share of a base count, for the secondary figures' captions. */
    function shareOf(part, base) {
      const total = count(base);
      if (total === 0) return '—';
      return `${((count(part) / total) * 100).toFixed(1)}%`;
    }

    /** The label a request's channel is grouped and filtered under. */
    function channelKeyOf(row) {
      return row.channel === '' ? '未标注' : row.channel;
    }

    /** The label a request's model is grouped and filtered under. */
    function modelKeyOf(row) {
      return row.model === '' ? '未标注' : row.model;
    }

    /**
     * The options one filter picker offers: every value the log holds, largest
     * first, behind an "all" entry whose id is the empty string.
     *
     * @param rows - Rows to inventory.
     * @param keyOf - The label function for that dimension.
     * @param allLabel - Label of the no-filter entry.
     * @returns Option list for the dropdown.
     */
    function pickerOptions(rows, keyOf, allLabel) {
      const weights = new Map();
      for (const row of rows) {
        const key = keyOf(row);
        weights.set(key, (weights.get(key) ?? 0) + row.totalTokens);
      }
      const list = [...weights.entries()].sort((left, right) => right[1] - left[1]);
      return [{ id: '', label: allLabel }, ...list.map(([key]) => ({ id: key, label: key }))];
    }

    /** Coerce a provider-reported count; anything unusable reads as zero. */
    function count(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    }

    /** Group digits for exact display. */
    function exact(value) {
      return count(value).toLocaleString('en-US');
    }

    /** Shorten large counts so a summary stays readable. */
    function compact(value) {
      const total = count(value);
      if (total < 10000) return exact(total);
      if (total < 1000000) return `${(total / 1000).toFixed(1)}K`;
      if (total < 1000000000) return `${(total / 1000000).toFixed(2)}M`;
      return `${(total / 1000000000).toFixed(2)}B`;
    }

    /** `MM-DD HH:MM:SS` in the viewer's zone; a dash when the time is unusable. */
    function stamp(time) {
      const value = count(time);
      if (value === 0) return '—';
      const date = new Date(value);
      const pad = (part) => String(part).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /**
     * The timestamp a log row shows.
     *
     * Today's rows name only the clock and older rows lead with their date, so a
     * page of same-day requests is not 20 repetitions of the same 10 characters.
     * The full stamp stays in the tooltip: nothing is lost, it is just not shouted.
     *
     * @param time - Commit time, ms.
     * @returns The short local stamp, or an em dash for an unmeasured time.
     */
    function logTime(time) {
      const value = count(time);
      if (value === 0) return '—';
      const date = new Date(value);
      const now = new Date();
      const pad = (part) => String(part).padStart(2, '0');
      const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
      return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
    }

    /** Display title for one listed Session, falling back to its id. */
    function titleOf(byId, id) {
      const summary = byId ? byId[id] : undefined;
      const title = summary ? summary.displayTitle || summary.title : undefined;
      return typeof title === 'string' && title.length > 0 ? title : String(id);
    }

    /** A non-negative finite millisecond figure, or undefined when the Host did not measure it. */
    function measured(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    }

    /** Render a millisecond figure; a dash means "not measured", not zero. */
    function duration(value) {
      const ms = measured(value);
      if (ms === undefined) return '—';
      if (ms < 1000) return `${Math.round(ms)}ms`;
      return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
    }

    /** Render an output rate as a bare number; the column header carries the unit. */
    function rateBare(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value.toFixed(1) : '—';
    }

    /**
     * Streaming flag as a coloured dot plus a short label.
     *
     * @param streamed - Whether the attempt carried token deltas.
     * @returns The marked cell content.
     */
    function streamMark(streamed) {
      return h(
        'span',
        { style: styles.streamCell, title: streamed ? '流式响应' : '非流式响应' },
        h('span', {
          style: {
            ...styles.dot,
            background: streamed
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-state-idle-primary)',
            // Every real row streams, so a saturated dot 20 times over is the
            // loudest thing on the page; the mark states the fact without shouting.
            opacity: streamed ? 0.75 : 0.45,
          },
        }),
        streamed ? '流式' : '非流式',
      );
    }

    /**
     * One request-log row plus, when open, its detail row.
     *
     * The detail exists because the table columns are a summary: `提示` is the sum
     * of three buckets, and two recorded facts — the cache-write bucket and the
     * reasoning subset of the output — have no column at all. The panel also
     * un-truncates the model and session labels the columns have to clip.
     *
     * @param row - One log row.
     * @param isOpen - Whether this row's detail is expanded.
     * @param onToggle - Toggles this row's detail.
     * @returns The row, and its detail row when open.
     */
    /**
     * One self-drawn listbox.
     *
     * Focus moves into the list as it opens so Escape and the arrows work without a
     * pointer, and back to the trigger on close because the focused node is the one
     * about to unmount. The options stay ordinary buttons, which is what makes Tab,
     * Enter and Space behave for free. React applies `autoFocus` only to form
     * elements, so the list takes focus from an effect instead.
     *
     * A component rather than a render helper because it owns two refs and an effect,
     * and a hook is only legal inside a component whose type stays stable across
     * renders — this one is created once, with the module.
     */
    function Dropdown(props) {
      const { label, options, value, onPick, open, setOpen } = props;
      const list = React.useRef(null);
      const trigger = React.useRef(null);

      React.useEffect(() => {
        if (open && list.current !== null) list.current.focus();
      }, [open]);

      const close = () => {
        setOpen(false);
        if (trigger.current !== null) trigger.current.focus();
      };

      return h(
        'div',
        { className: 'dsh-tu-drop', style: styles.dropRoot },
        h(
          'button',
          {
            key: 'trigger',
            ref: trigger,
            type: 'button',
            style: styles.dropTrigger,
            'aria-label': label,
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
          },
          h('span', null, (options.find((option) => option.id === value) ?? {}).label ?? ''),
          h('span', { style: styles.dropCaret }, '▾'),
        ),
        open
          ? h('div', { key: 'backdrop', style: styles.dropBackdrop, onClick: close })
          : null,
        open
          ? h(
              'div',
              {
                key: 'list',
                ref: list,
                style: styles.dropMenu,
                role: 'listbox',
                'aria-label': label,
                tabIndex: -1,
                onKeyDown: (event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    close();
                    return;
                  }
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                  // The browser would scroll the page for these keys; the open list
                  // owns them.
                  event.preventDefault();
                  const items = Array.from(event.currentTarget.querySelectorAll('[role="option"]'));
                  if (items.length === 0) return;
                  const at = items.indexOf(document.activeElement);
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  const next = at === -1
                    ? (step === 1 ? 0 : items.length - 1)
                    : (at + step + items.length) % items.length;
                  items[next].focus();
                },
              },
              ...options.map((option) =>
                h(
                  'button',
                  {
                    key: option.id,
                    type: 'button',
                    role: 'option',
                    'aria-selected': option.id === value,
                    className: 'dsh-tu-drop-item',
                    style: styles.dropItem,
                    onClick: () => {
                      onPick(option.id);
                      close();
                    },
                  },
                  option.label,
                ),
              ),
            )
          : null,
      );
    }

    /**
     * The 合计 cell: the figure with a four-segment composition bar beneath it.
     *
     * The bar is what makes a column of numbers readable at a glance — the hue
     * shows which bucket the row actually spent on, so a cache-heavy request and a
     * full-price one stop looking identical. A row that spent nothing keeps the bare
     * figure: an all-track bar would imply a measured zero.
     */
    function totalCell(source) {
      const breakdown = BUCKETS
        .map((bucket) => `${bucket.label} ${exact(source[bucket.key])}`)
        .join(' · ');
      return h(
        'td',
        { style: { ...styles.td, ...styles.strong }, title: exact(source.totalTokens) },
        h(
          'span',
          { style: styles.stackCell },
          compact(source.totalTokens),
          source.totalTokens === 0
            ? null
            : h(
                'span',
                { style: styles.compose, title: breakdown },
                ...BUCKETS.map((bucket) =>
                  source[bucket.key] === 0
                    ? null
                    : h('span', {
                        key: bucket.key,
                        style: { ...styles.composeSeg, flexGrow: source[bucket.key], background: bucket.color },
                      }),
                ),
              ),
        ),
      );
    }

    function requestRow(row, isOpen, onToggle, onOpenSession) {
      const main = h(
        'tr',
        {
          key: row.key,
          // A zero-usage attempt reads as noise beside real rows, so it is dimmed
          // rather than hidden: the row still proves the request happened.
          className: row.totalTokens === 0 ? 'dsh-tu-row dsh-tu-zero' : 'dsh-tu-row',
          onClick: onToggle,
          'aria-expanded': isOpen,
          title: '点击查看该条明细',
          style: { cursor: 'pointer' },
        },
        h(
          'td',
          { style: styles.tdTime, title: stamp(row.time) },
          h('span', { style: styles.caret }, isOpen ? '▾' : '▸'),
          logTime(row.time),
        ),
        h(
          'td',
          { style: styles.tdSession, title: row.title },
          onOpenSession === undefined || row.sessionId === ''
            ? row.title
            : h(
                'span',
                {
                  className: 'dsh-tu-link',
                  role: 'link',
                  tabIndex: 0,
                  title: `打开会话「${row.title}」`,
                  // The row toggle owns a click on the row; the name claims its own.
                  onClick: (event) => {
                    event.stopPropagation();
                    onOpenSession(row.sessionId);
                  },
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenSession(row.sessionId);
                  },
                },
                row.title,
              ),
        ),
        h(
          'td',
          { style: styles.tdText },
          row.channel === ''
            ? h('span', { style: styles.chipMuted }, '未标注')
            : h('span', { style: styles.chip }, row.channel),
        ),
        h('td', { style: styles.tdModel, title: row.model === '' ? undefined : row.model }, row.model === '' ? '—' : row.model),
        h(
          'td',
          { style: { ...styles.td, ...styles.divider }, title: exact(row.promptTokens) },
          compact(row.promptTokens),
        ),
        h(
          'td',
          { style: { ...styles.td, ...styles.numDim }, title: exact(row.cacheReadTokens) },
          compact(row.cacheReadTokens),
        ),
        h(
          'td',
          { style: { ...styles.td, ...styles.numDim }, title: exact(row.completionTokens) },
          compact(row.completionTokens),
        ),
        totalCell(row),
        h('td', { style: { ...styles.td, ...styles.divider } }, duration(row.latencyMs)),
        h('td', { style: { ...styles.td, ...styles.numDim } }, duration(row.firstTokenMs)),
        h('td', { style: { ...styles.td, ...styles.numDim } }, rateBare(row.speed)),
        h('td', { style: styles.td }, streamMark(row.streamed)),
      );
      if (!isOpen) return main;

      const line = (key, value) =>
        h(
          'div',
          { key, style: styles.detailLine },
          h('span', { style: styles.detailKey }, key),
          h('span', { style: styles.detailVal }, value),
        );
      const bucket = (key, value, options) =>
        h(
          'div',
          { key, style: styles.bucketLine },
          h(
            'span',
            { style: { ...styles.bucketKey, ...(options?.sub === true ? styles.bucketSub : {}) } },
            options?.color === undefined
              ? null
              : h('span', { style: { ...styles.dot, background: options.color } }),
            key,
          ),
          h(
            'span',
            {
              style: {
                ...styles.bucketVal,
                ...(options?.total === true ? styles.bucketTotal : {}),
                ...(options?.sub === true ? styles.bucketSub : {}),
              },
            },
            value,
          ),
        );

      return [
        main,
        h(
          'tr',
          { key: `${row.key}:detail`, className: 'dsh-tu-detail' },
          h(
            'td',
            { colSpan: REQUEST_COLUMNS, style: styles.detailCell },
            h(
              'div',
              { style: styles.detailWrap },
              h(
                'div',
                { style: styles.detailCol },
                line('轮次', `第 ${exact(row.turn)} 轮 · 第 ${exact(row.step)} 步`),
                line('渠道', row.channel === '' ? '未标注' : row.channel),
                line('模型', row.model === '' ? '未标注' : row.model),
                line('会话', row.title),
              ),
              h(
                'div',
                { style: styles.detailCol },
                bucket('缓存未命中输入', exact(row.uncachedInputTokens), { color: BUCKETS[0].color }),
                bucket('缓存读', exact(row.cacheReadTokens), { color: BUCKETS[1].color }),
                bucket('缓存写', exact(row.cacheWriteTokens), { color: BUCKETS[2].color }),
                bucket('输出', exact(row.outputTokens), { color: BUCKETS[3].color }),
                row.reasoningTokens > 0
                  ? bucket('└ 其中推理', exact(row.reasoningTokens), { sub: true })
                  : null,
                bucket('合计', exact(row.totalTokens), { total: true }),
              ),
            ),
            h(
              'div',
              { style: styles.detailTimes },
              `耗时 ${duration(row.latencyMs)} · 首字 ${duration(row.firstTokenMs)} · 生成 ${duration(
                row.generationMs,
              )} · ${row.streamed ? '流式' : '非流式'}`,
            ),
          ),
        ),
      ];
    }

    /**
     * The date rule above one day's rows, carrying that day's own totals.
     *
     * A long log is scanned by day, not by row: the rule turns a page of identical
     * timestamps into a calendar of activity, and it reports the day's figures so
     * the reader can stop at the day they care about.
     *
     * @param rule - Day key plus that day's count and token total.
     * @returns The rule row element.
     */
    function dayRule(rule) {
      const parts = rule.key.split('-');
      const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
      return h(
        'tr',
        { key: `day-${rule.key}`, className: 'dsh-tu-day' },
        h(
          'td',
          { colSpan: REQUEST_COLUMNS, style: styles.dayCell },
          h(
            'div',
            { style: styles.dayRow },
            h('span', { style: styles.dayLabel }, `${parts[1]}-${parts[2]} ${weekday}`),
            h('span', { style: styles.dayMeta }, `${exact(rule.count)} 条 · 合计 ${compact(rule.tokens)}`),
          ),
        ),
      );
    }

    /**
     * One grouped row.
     *
     * The share of the filtered total is a cell of its own rather than a bar under
     * the label: a full-width hairline under a name reads as a rendering artefact,
     * and the number it encodes was never legible there anyway.
     *
     * @param group - One aggregated group.
     * @param total - Filtered total, which every share is taken against.
     * @returns The table row element.
     */
    function groupRow(group, total) {
      const share = total === 0 ? 0 : group.totalTokens / total;
      const cacheable = group.uncachedInputTokens + group.cacheReadTokens + group.cacheWriteTokens;
      return h(
        'tr',
        { key: group.key, className: 'dsh-tu-row' },
        h('td', { style: styles.tdGroup, title: group.key }, h('span', { style: styles.groupName }, group.key)),
        h(
          'td',
          { style: { ...styles.td, ...styles.divider } },
          h(
            'div',
            { style: styles.shareCell, title: `占合计 ${(share * 100).toFixed(1)}%` },
            h(
              'div',
              { style: styles.shareTrack },
              h('div', {
                style: { ...styles.shareBar, width: `${Math.max(share * 100, group.totalTokens > 0 ? 2 : 0)}%` },
              }),
            ),
            h('span', null, `${(share * 100).toFixed(1)}%`),
          ),
        ),
        h('td', { style: styles.td }, exact(group.rows)),
        h(
          'td',
          { style: { ...styles.td, ...styles.divider }, title: exact(group.promptTokens) },
          compact(group.promptTokens),
        ),
        h(
          'td',
          { style: { ...styles.td, ...styles.numDim }, title: exact(group.cacheReadTokens) },
          compact(group.cacheReadTokens),
        ),
        h(
          'td',
          { style: { ...styles.td, ...styles.numDim }, title: exact(group.completionTokens) },
          compact(group.completionTokens),
        ),
        totalCell(group),
        h(
          'td',
          { style: { ...styles.td, ...styles.numDim }, title: '缓存读 ÷ （缓存未命中 + 缓存读 + 缓存写）' },
          cacheable === 0 ? '—' : `${((group.cacheReadTokens / cacheable) * 100).toFixed(1)}%`,
        ),
        h('td', { style: { ...styles.td, ...styles.divider } }, duration(group.avgLatencyMs)),
        h('td', { style: { ...styles.td, ...styles.numDim } }, rateBare(group.speed)),
      );
    }

    /** A fresh totals record. */
    function zeroTotals() {
      const totals = { totalTokens: 0, promptTokens: 0, completionTokens: 0 };
      for (const bucket of BUCKETS) totals[bucket.key] = 0;
      return totals;
    }

    /** Add one row's buckets into a totals record. */
    function addRow(totals, row) {
      for (const bucket of BUCKETS) totals[bucket.key] += row[bucket.key];
      totals.totalTokens += row.totalTokens;
    }

    /**
     * The click handler that shows one Session's conversation, or undefined when
     * this composition has no Workspace navigation service.
     *
     * The lookup is deferred to the moment the entry is composed, so a composition
     * without the service renders the name as plain text instead of failing.
     *
     * @param ctx - Client context.
     * @returns The handler, or undefined.
     */
    function sessionOpener(ctx) {
      const workspace = ctx !== undefined && typeof ctx.get === 'function'
        ? ctx.get('uiWorkspace')
        : undefined;
      if (workspace === undefined || typeof workspace.openSession !== 'function') return undefined;
      return (sessionId) => {
        try {
          workspace.openSession(sessionId);
        } catch (error) {
          // A Session that no longer exists cannot be shown; the row simply stays.
        }
      };
    }

    /**
     * One row from a projection entry or from a durable ledger record.
     *
     * Both carry the same fields, so one builder keeps the two sources
     * indistinguishable once they reach the table.
     *
     * @param id - Session id the attempt belongs to.
     * @param title - Session title, or '' when the session is unknown.
     * @param entry - The projection entry or ledger record.
     * @returns The row.
     */
    function rowFromPayload(id, title, entry) {
      const row = {
        key: `${id}:${count(entry.time)}:${count(entry.turn)}:${count(entry.step)}`,
        sessionId: String(id),
        title,
        time: count(entry.time),
        turn: count(entry.turn),
        step: count(entry.step),
        channel: typeof entry.provider === 'string' && entry.provider !== '' ? entry.provider : '',
        model: typeof entry.model === 'string' && entry.model !== '' ? entry.model : '',
      };
      for (const bucket of BUCKETS) row[bucket.key] = count(entry[bucket.key]);
      // Carried for the detail panel only: the reasoning subset has no column.
      row.reasoningTokens = count(entry.reasoningTokens);
      row.promptTokens = row.uncachedInputTokens + row.cacheReadTokens + row.cacheWriteTokens;
      row.completionTokens = row.outputTokens;
      row.totalTokens = row.promptTokens + row.completionTokens;
      row.streamed = entry.streamed === true;
      row.latencyMs = measured(entry.latencyMs);
      row.firstTokenMs = measured(entry.firstTokenMs);
      row.generationMs = measured(entry.generationMs);
      // A per-request speed is only worth showing under the same rule the pooled
      // figure uses: a relay that reports the first token and the settlement in the
      // same instant yields a generation time near zero, and dividing by it invents
      // a six-figure tokens-per-second reading. Below the threshold the row shows
      // "—", which means "not measured" everywhere else in this panel too.
      row.speed =
        row.generationMs !== undefined
        && row.generationMs >= SPEED_MIN_GENERATION_MS
        && row.completionTokens >= SPEED_MIN_OUTPUT_TOKENS
          ? row.completionTokens / (row.generationMs / 1000)
          : undefined;
      return row;
    }

    /**
     * Flatten every listed Session's `requestLog` value into one log, newest first.
     *
     * `hasKey` reports whether any Session carried the projection at all, which
     * separates "no requests yet" from "the projection never arrived".
     */
    function buildLog(ids, byId, projections) {
      const rows = [];
      const totals = zeroTotals();
      const seen = new Set();
      let hasKey = false;
      // Pooled output speed: summed tokens over summed generation time, the way
      // cc-switch computes it, rather than an average of per-request rates.
      let speedTokens = 0;
      let speedGenerationMs = 0;
      let timedRows = 0;
      const list = Array.isArray(ids) ? ids : [];
      for (const id of list) {
        const snapshot = projections ? projections[id] : undefined;
        const values = snapshot ? snapshot.values : undefined;
        if (!values) continue;
        const log = values.requestLog;
        if (log !== undefined) hasKey = true;
        if (!Array.isArray(log)) continue;
        const title = titleOf(byId, id);
        for (const entry of log) {
          if (!entry || typeof entry !== 'object') continue;
          const row = rowFromPayload(id, title, entry);
          if (row.firstTokenMs !== undefined) timedRows += 1;
          if (
            row.firstTokenMs !== undefined
            && row.completionTokens >= SPEED_MIN_OUTPUT_TOKENS
            && row.generationMs !== undefined
            && row.generationMs >= SPEED_MIN_GENERATION_MS
          ) {
            speedTokens += row.completionTokens;
            speedGenerationMs += row.generationMs;
          }
          seen.add(row.sessionId);
          addRow(totals, row);
          rows.push(row);
        }
      }
      rows.sort((left, right) => right.time - left.time);
      return {
        rows,
        totals,
        hasKey,
        sessions: seen.size,
        timedRows,
        // Pooled ratio; undefined until at least one request qualifies.
        speed: speedGenerationMs > 0 ? speedTokens / (speedGenerationMs / 1000) : undefined,
      };
    }

    /**
     * The newest durable rows as a log, in the same shape {@link buildLog} returns.
     *
     * This is the fallback that makes the file worth having: a Session removed from
     * the list, or a projection discarded by a version bump, leaves nothing to fold,
     * yet the attempts are still on disk and still readable here.
     *
     * @param ledger - The durable payload.
     * @param byId - Session summaries, so titles survive where the session is known.
     * @returns A log over the durable rows.
     */
    function buildLedgerLog(ledger, byId) {
      const rows = [];
      const totals = zeroTotals();
      const seen = new Set();
      let speedTokens = 0;
      let speedGenerationMs = 0;
      let timedRows = 0;
      const list = ledger !== undefined && Array.isArray(ledger.recent) ? ledger.recent : [];
      for (const entry of list) {
        if (entry === null || typeof entry !== 'object') continue;
        const id = typeof entry.session === 'string' ? entry.session : '';
        const row = rowFromPayload(id, titleOf(byId, id), entry);
        if (row.firstTokenMs !== undefined) timedRows += 1;
        if (
          row.firstTokenMs !== undefined
          && row.completionTokens >= SPEED_MIN_OUTPUT_TOKENS
          && row.generationMs !== undefined
          && row.generationMs >= SPEED_MIN_GENERATION_MS
        ) {
          speedTokens += row.completionTokens;
          speedGenerationMs += row.generationMs;
        }
        seen.add(row.sessionId);
        addRow(totals, row);
        rows.push(row);
      }
      rows.sort((left, right) => right.time - left.time);
      return {
        rows,
        totals,
        hasKey: list.length > 0,
        sessions: seen.size,
        timedRows,
        speed: speedGenerationMs > 0 ? speedTokens / (speedGenerationMs / 1000) : undefined,
      };
    }

    /** Column readers the request table can order by, keyed as its headers name them. */
    const SORT_KEYS = {
      time: (row) => row.time,
      title: (row) => row.title,
      channel: (row) => row.channel,
      model: (row) => row.model,
      promptTokens: (row) => row.promptTokens,
      cacheReadTokens: (row) => row.cacheReadTokens,
      completionTokens: (row) => row.completionTokens,
      totalTokens: (row) => row.totalTokens,
      latencyMs: (row) => row.latencyMs,
      firstTokenMs: (row) => row.firstTokenMs,
      speed: (row) => row.speed,
    };

    /** Columns whose values compare as text rather than as numbers. */
    const SORT_TEXT = ['title', 'channel', 'model'];

    /** The order the panel opens in: newest request first, the ledger's own order. */
    const DEFAULT_SORT = { key: 'time', dir: 'desc' };

    /**
     * Order one row set by one column.
     *
     * A row whose measurement was never taken reads `—` on screen and sorts last in
     * either direction: absent is not zero, so it never leads a smallest-first list
     * and never reads as a measured zero at the other end.
     */
    function sortRows(rows, sort) {
      const pick = SORT_KEYS[sort.key];
      if (pick === undefined) return rows;
      const direction = sort.dir === 'asc' ? 1 : -1;
      const asText = SORT_TEXT.includes(sort.key);
      return [...rows].sort((left, right) => {
        const a = pick(left);
        const b = pick(right);
        if (a === undefined || b === undefined) {
          if (a === undefined && b === undefined) return 0;
          return a === undefined ? 1 : -1;
        }
        return asText
          ? direction * String(a).localeCompare(String(b))
          : direction * (a - b);
      });
    }

    /** Local `YYYY-MM-DD HH:mm:ss`, the one timestamp shape a spreadsheet parses as is. */
    function localStamp(time) {
      const date = new Date(count(time));
      const pad = (part) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /**
     * One row set as CSV text.
     *
     * Every field is quoted, so a session title carrying a comma or a quote needs no
     * case beyond doubling the quote. A measurement that was never taken exports as
     * an empty field, because `0` would claim it was measured as zero.
     */
    function toCsv(rows) {
      const columns = [
        ['时间', (row) => localStamp(row.time)],
        ['会话', (row) => row.title],
        ['渠道', (row) => row.channel],
        ['模型', (row) => row.model],
        ['轮次', (row) => row.turn],
        ['步', (row) => row.step],
        ['提示', (row) => row.promptTokens],
        ['缓存读', (row) => row.cacheReadTokens],
        ['缓存写', (row) => row.cacheWriteTokens],
        ['补全', (row) => row.completionTokens],
        ['推理', (row) => row.reasoningTokens],
        ['合计', (row) => row.totalTokens],
        ['耗时 ms', (row) => row.latencyMs],
        ['首字 ms', (row) => row.firstTokenMs],
        ['生成 ms', (row) => row.generationMs],
        ['速度 tok/s', (row) => row.speed],
        ['流式', (row) => (row.streamed ? '是' : '否')],
      ];
      const quote = (value) => `"${String(value === undefined ? '' : value).replace(/"/g, '""')}"`;
      const lines = [columns.map((column) => quote(column[0])).join(',')];
      for (const row of rows) {
        lines.push(columns.map((column) => quote(column[1](row))).join(','));
      }
      return lines.join('\r\n');
    }

    /**
     * Hand one CSV to the browser as a download.
     *
     * The byte-order mark is what makes a spreadsheet read the Chinese headers as
     * UTF-8 rather than as the local code page. The object URL is revoked on a later
     * task, because the click has to hand the blob to the download first.
     */
    function saveCsv(rows) {
      const blob = new Blob([`\ufeff${toCsv(rows)}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `token-usage-${localStamp(Date.now()).replace(/[-: ]/g, '')}.csv`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    /**
     * Component-local stylesheet.
     *
     * Rendered as an element inside the panel, so unmounting removes it — there is
     * no manual cleanup. Row striping and hover need real pseudo-classes, which an
     * inline style object cannot express.
     */
    /** Local `YYYY-MM-DD` for one timestamp, so day groups follow the viewer's zone. */
    function dayKey(time) {
      const date = new Date(count(time));
      const pad = (part) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    /** Local `YYYY-MM-DD HH` for one timestamp. */
    function hourKey(time) {
      const date = new Date(count(time));
      const pad = (part) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}`;
    }

    /** Local `MM-DD` axis label. */
    function dayLabel(time) {
      const date = new Date(count(time));
      const pad = (part) => String(part).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    /** Local `MM-DD HH:00` axis label. */
    function hourLabel(time) {
      const date = new Date(count(time));
      const pad = (part) => String(part).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`;
    }

    /**
     * How many days a chart should span for the rows it will draw.
     *
     * A fixed window is right only when the history fills it. With two weeks of data a
     * thirty-day axis spends two thirds of its width on days that hold nothing, which
     * reads as a chart that failed to draw rather than as a quiet stretch. The span
     * therefore follows the oldest row on screen — floored so a young install still
     * gets a readable axis, capped by the window that was asked for.
     *
     * @param rows - Rows the chart will draw.
     * @param cap - Widest span the chart may use.
     * @param floor - Narrowest span the chart may use.
     * @returns A whole number of days, counting today.
     */
    function spanDays(rows, cap, floor) {
      let oldest;
      for (const row of rows) {
        if (oldest === undefined || row.time < oldest) oldest = row.time;
      }
      if (oldest === undefined) return floor;
      const start = new Date(oldest);
      const now = new Date();
      const from = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
      const to = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      return Math.min(Math.max(Math.round((to - from) / 86400000) + 1, floor), cap);
    }

    /**
     * Dense daily buckets ending today, oldest first.
     *
     * Dense is the point: a day with no requests must appear as an empty column,
     * otherwise the chart closes the gap and reads as uninterrupted activity.
     *
     * @param rows - Rows to bucket.
     * @param days - Number of days to emit.
     * @returns One entry per day, carrying its own bucket totals.
     */
    function daySeries(rows, days) {
      const totals = new Map();
      for (const row of rows) {
        const key = dayKey(row.time);
        const entry = totals.get(key) ?? zeroTotals();
        addRow(entry, row);
        totals.set(key, entry);
      }
      const today = new Date();
      const out = [];
      for (let index = days - 1; index >= 0; index -= 1) {
        const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - index);
        const start = date.getTime();
        const key = dayKey(start);
        const entry = totals.get(key);
        out.push({
          key,
          start,
          label: dayLabel(start),
          tokens: entry === undefined ? 0 : entry.totalTokens,
          buckets: entry ?? zeroTotals(),
        });
      }
      return out;
    }

    /**
     * Dense hourly buckets ending with the current hour, oldest first.
     *
     * @param rows - Rows to bucket.
     * @param hours - Number of hours to emit.
     * @returns One entry per hour, carrying its own bucket totals.
     */
    function hourSeries(rows, hours) {
      const totals = new Map();
      for (const row of rows) {
        const key = hourKey(row.time);
        const entry = totals.get(key) ?? zeroTotals();
        addRow(entry, row);
        totals.set(key, entry);
      }
      const anchor = new Date();
      anchor.setMinutes(0, 0, 0);
      const out = [];
      for (let index = hours - 1; index >= 0; index -= 1) {
        const start = anchor.getTime() - index * 3600000;
        const key = hourKey(start);
        const entry = totals.get(key);
        out.push({
          key,
          start,
          label: hourLabel(start),
          tokens: entry === undefined ? 0 : entry.totalTokens,
          buckets: entry ?? zeroTotals(),
        });
      }
      return out;
    }

    /**
     * Dense hourly or daily cache-hit rate, oldest first.
     *
     * Pooled per bucket rather than averaged across requests: a bucket's rate is
     * its own cache reads over its own prompt tokens, so a handful of small
     * requests cannot weigh as much as one large one. A bucket with no prompt
     * tokens carries no rate at all, which is not the same as a rate of zero.
     *
     * @param rows - Rows to bucket.
     * @param count - Number of buckets to emit.
     * @param hourly - Bucket by hour instead of by local day.
     * @returns One entry per bucket; `rate` is undefined where the bucket had no prompt tokens.
     */
    function rateSeries(rows, count, hourly) {
      const keyOf = hourly ? hourKey : dayKey;
      const buckets = new Map();
      for (const row of rows) {
        const key = keyOf(row.time);
        const entry = buckets.get(key);
        if (entry === undefined) buckets.set(key, { read: row.cacheReadTokens, prompt: row.promptTokens });
        else {
          entry.read += row.cacheReadTokens;
          entry.prompt += row.promptTokens;
        }
      }
      const now = new Date();
      const out = [];
      for (let index = count - 1; index >= 0; index -= 1) {
        // Local calendar arithmetic, not `now - index * 86400000`: a day is not a
        // fixed number of milliseconds across a daylight-saving boundary.
        const start = hourly
          ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - index).getTime()
          : new Date(now.getFullYear(), now.getMonth(), now.getDate() - index).getTime();
        const entry = buckets.get(keyOf(start));
        out.push({
          key: keyOf(start),
          start,
          label: hourly ? hourLabel(start) : dayLabel(start),
          prompt: entry === undefined ? 0 : entry.prompt,
          rate: entry !== undefined && entry.prompt > 0 ? entry.read / entry.prompt : undefined,
        });
      }
      return out;
    }

    /**
     * One entry per day for the heat map, oldest first, including empty days.
     *
     * @param rows - Rows to bucket; the caller passes every retained row so the map
     *   is a year view rather than a view of the current filter.
     * @param days - Number of days to emit.
     * @returns Day entries carrying their weekday index and total.
     */
    function heatDays(rows, days) {
      const totals = new Map();
      for (const row of rows) {
        const key = dayKey(row.time);
        totals.set(key, (totals.get(key) ?? 0) + row.totalTokens);
      }
      const today = new Date();
      const out = [];
      for (let index = days - 1; index >= 0; index -= 1) {
        const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - index);
        const key = dayKey(date.getTime());
        out.push({ key, weekday: date.getDay(), label: dayLabel(date.getTime()), tokens: totals.get(key) ?? 0 });
      }
      return out;
    }

    /**
     * How many days a durable day series reaches back, counting today.
     *
     * The Host sends one entry per day that recorded something, so the length is a
     * count of active days, not a span; the span is what a chart axis needs.
     *
     * @param days - Durable day aggregates, oldest first.
     * @param cap - Widest span to report.
     * @returns A whole number of days, or 0 when the series is unusable.
     */
    function daySpan(days, cap) {
      if (!Array.isArray(days) || days.length === 0) return 0;
      const first = days[0] === undefined ? undefined : days[0].day;
      if (typeof first !== 'string') return 0;
      const parts = first.split('-').map((part) => Number(part));
      if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
      const start = new Date(parts[0], parts[1] - 1, parts[2]);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const span = Math.round((today.getTime() - start.getTime()) / 86400000) + 1;
      return Math.min(Math.max(span, 1), cap);
    }

    /**
     * One entry per day for the heat map, built from the durable day aggregates.
     *
     * Same shape {@link heatDays} returns, so one renderer serves both, but the
     * source is the whole recorded history rather than the retained window — which
     * is the entire point of persisting it.
     *
     * @param days - Durable day aggregates, oldest first.
     * @param span - Number of days to emit.
     * @returns Day entries carrying their weekday index and total.
     */
    function heatFromDays(days, span) {
      const totals = new Map();
      for (const day of days) {
        if (day === null || typeof day !== 'object' || typeof day.day !== 'string') continue;
        totals.set(day.day, count(day.totalTokens));
      }
      const today = new Date();
      const out = [];
      for (let index = span - 1; index >= 0; index -= 1) {
        const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - index);
        const key = dayKey(date.getTime());
        out.push({ key, weekday: date.getDay(), label: dayLabel(date.getTime()), tokens: totals.get(key) ?? 0 });
      }
      return out;
    }

    /**
     * Dense daily buckets for the trend chart, built from the durable day aggregates.
     *
     * @param days - Durable day aggregates, oldest first.
     * @param span - Number of days to emit.
     * @returns One entry per day, in the shape the trend renderer already takes.
     */
    function trendFromDays(days, span) {
      const byDay = new Map();
      for (const day of days) {
        if (day === null || typeof day !== 'object' || typeof day.day !== 'string') continue;
        const buckets = zeroTotals();
        for (const bucket of BUCKETS) buckets[bucket.key] = count(day[bucket.key]);
        buckets.totalTokens = count(day.totalTokens);
        buckets.promptTokens = count(day.promptTokens);
        buckets.completionTokens = count(day.completionTokens);
        byDay.set(day.day, buckets);
      }
      const today = new Date();
      const out = [];
      for (let index = span - 1; index >= 0; index -= 1) {
        const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - index);
        const start = date.getTime();
        const key = dayKey(start);
        const buckets = byDay.get(key) ?? zeroTotals();
        out.push({ key, start, label: dayLabel(start), tokens: buckets.totalTokens, buckets });
      }
      return out;
    }

    /**
     * The year grid: one column per week, seven rows, Monday first.
     *
     * Built as whole weeks rather than a run of days so the columns line up with
     * weekdays, which is the only thing that makes a year of cells readable at a
     * glance. Days after today stay in the grid as future cells so the last column
     * keeps its shape, and they never paint a level.
     *
     * @param days - Durable day aggregates, oldest first.
     * @param weeks - Number of week columns to emit, ending with the current week.
     * @param hue - CSS colour for a filled cell.
     * @returns Week columns plus the month label each column starts.
     */
    function yearWeeks(days, weeks, hue) {
      const totals = new Map();
      for (const day of days) {
        if (day === null || typeof day !== 'object' || typeof day.day !== 'string') continue;
        totals.set(day.day, count(day.totalTokens));
      }
      let peak = 0;
      for (const value of totals.values()) if (value > peak) peak = value;
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekday = (today.getDay() + 6) % 7;
      const lastMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - weekday);
      const columns = [];
      let previousMonth = -1;
      for (let index = weeks - 1; index >= 0; index -= 1) {
        const start = new Date(lastMonday.getFullYear(), lastMonday.getMonth(), lastMonday.getDate() - index * 7);
        const cells = [];
        for (let row = 0; row < 7; row += 1) {
          const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + row);
          const future = date.getTime() > today.getTime();
          const key = dayKey(date.getTime());
          const tokens = future ? 0 : totals.get(key) ?? 0;
          const ratio = peak === 0 ? 0 : tokens / peak;
          cells.push({
            key,
            date,
            future,
            tokens,
            level: tokens === 0 ? 0 : ratio > 0.66 ? 4 : ratio > 0.33 ? 3 : ratio > 0.12 ? 2 : 1,
          });
        }
        const month = start.getMonth();
        const label = month === previousMonth ? null : `${month + 1}月`;
        previousMonth = month;
        columns.push({ key: dayKey(start.getTime()), cells, label });
      }
      return { columns, peak, hue };
    }

    /**
     * The hit-rate line as SVG-ready runs.
     *
     * A day with no prompt tokens has no rate at all, which is not a rate of zero;
     * breaking the line there keeps a quiet stretch from reading as a collapse to
     * zero. Runs are consecutive measured days, so each becomes one polyline.
     *
     * @param points - Rate series, oldest first.
     * @returns Runs of measured points, in viewBox units.
     */
    function rateRuns(points) {
      const runs = [];
      let current = [];
      points.forEach((point, index) => {
        if (point.rate === undefined) {
          if (current.length > 0) {
            runs.push(current);
            current = [];
          }
          return;
        }
        current.push({ x: index, y: point.rate });
      });
      if (current.length > 0) runs.push(current);
      return runs;
    }

    /**
     * Read the durable ledger from the Host.
     *
     * `undefined` until the first answer arrives and after every failed read, so a
     * consumer falls back to the projection rather than to nothing — the panel has
     * to keep working on a composition that has no web server or no route.
     *
     * @returns The newest ledger payload, or undefined while unavailable.
     */
    function useLedger() {
      const [payload, setPayload] = React.useState(undefined);
      React.useEffect(() => {
        let alive = true;
        const read = () => {
          const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
          const timer = setTimeout(() => {
            if (controller !== undefined) controller.abort();
          }, LEDGER_TIMEOUT_MS);
          const stop = () => clearTimeout(timer);
          fetch(`${LEDGER_URL}?rows=${LEDGER_ROW_LIMIT}`, {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller === undefined ? undefined : controller.signal,
          })
            .then((response) => (response.ok ? response.json() : undefined))
            .then((data) => {
              stop();
              if (!alive) return;
              setPayload(data !== null && typeof data === 'object' ? data : undefined);
            })
            .catch(() => {
              // A route that is absent, unauthenticated or slow simply leaves the
              // panel on the projection; the next pass tries again.
              stop();
            });
        };
        read();
        const interval = setInterval(read, LEDGER_REFRESH_MS);
        return () => {
          alive = false;
          clearInterval(interval);
        };
      }, []);
      return payload;
    }

    /**
     * Reshape one durable aggregate into the group a table row understands.
     *
     * The ledger keeps its own per-day, per-model and per-channel totals and only
     * ever grows, which is exactly what a table of days needs: a view folded from
     * the browser's retained rows loses the oldest day of every Session as that
     * Session grows past its window, so the same day reports less every time it is
     * looked at.
     *
     * @param kind - Which dimension the entry belongs to.
     * @param entry - One ledger aggregate.
     * @returns A group row, or undefined when the entry names nothing.
     */
    function groupFromLedger(kind, entry) {
      if (entry === null || typeof entry !== 'object') return undefined;
      const label = kind === 'day'
        ? entry.day
        : kind === 'channel'
          ? (entry.provider === '' ? '未标注' : entry.provider)
          : (entry.model === '' ? '未标注' : `${entry.provider} / ${entry.model}`);
      if (typeof label !== 'string' || label === '') return undefined;
      const group = {
        key: label,
        rows: count(entry.requests),
        uncachedInputTokens: count(entry.uncachedInputTokens),
        cacheReadTokens: count(entry.cacheReadTokens),
        cacheWriteTokens: count(entry.cacheWriteTokens),
        outputTokens: count(entry.outputTokens),
        reasoningTokens: count(entry.reasoningTokens),
        promptTokens: count(entry.promptTokens),
        completionTokens: count(entry.completionTokens),
        totalTokens: count(entry.totalTokens),
        avgLatencyMs: typeof entry.avgLatencyMs === 'number' ? entry.avgLatencyMs : undefined,
        speed: typeof entry.speed === 'number' ? entry.speed : undefined,
      };
      return group;
    }

    /**
     * Aggregate rows under a label, largest total first.
     *
     * Each group carries the same figures a single row does, so one cell renderer
     * serves both: the four buckets, the prompt/completion split, a row count, the
     * mean latency, and a pooled output speed under the same thresholds.
     *
     * @param rows - Rows to group.
     * @param keyOf - Label for one row.
     * @returns One entry per label, largest total first.
     */
    function groupBy(rows, keyOf) {
      const groups = new Map();
      for (const row of rows) {
        const key = keyOf(row);
        let group = groups.get(key);
        if (group === undefined) {
          group = { key, rows: 0, latencyTotal: 0, timedRows: 0, speedTokens: 0, speedMs: 0, ...zeroTotals() };
          groups.set(key, group);
        }
        group.rows += 1;
        addRow(group, row);
        if (row.latencyMs !== undefined) {
          group.latencyTotal += row.latencyMs;
          group.timedRows += 1;
        }
        if (
          row.firstTokenMs !== undefined
          && row.completionTokens >= SPEED_MIN_OUTPUT_TOKENS
          && row.generationMs !== undefined
          && row.generationMs >= SPEED_MIN_GENERATION_MS
        ) {
          group.speedTokens += row.completionTokens;
          group.speedMs += row.generationMs;
        }
      }
      const list = [...groups.values()];
      for (const group of list) {
        group.promptTokens = group.uncachedInputTokens + group.cacheReadTokens + group.cacheWriteTokens;
        group.completionTokens = group.outputTokens;
        group.avgLatencyMs = group.timedRows === 0 ? undefined : group.latencyTotal / group.timedRows;
        group.speed = group.speedMs > 0 ? group.speedTokens / (group.speedMs / 1000) : undefined;
      }
      list.sort((left, right) => right.totalTokens - left.totalTokens);
      return list;
    }

    // Design tokens for this panel, resolved once per theme.
    //
    // The four data hues are platform statics where one exists and a violet literal
    // where none does; `--tu-accent` stays DSH's brand blue for chrome — arrows,
    // focus, and the heat ramp, where one sequential hue is the correct encoding.
    // The DSH `brand-primary` alias is a near-black/near-white neutral, so it never
    // paints data. The dark block re-picks every hue for the darker ground rather
    // than lightening one ramp.
    const LOCAL_CSS = [
      '.dsh-tu-scope {',
      '  --tu-input: var(--dsw-static-deepseek-500);',
      '  --tu-cache-read: var(--dsw-static-green-500);',
      '  --tu-cache-write: var(--dsw-static-amber-500);',
      '  --tu-output: rgb(167, 139, 250);',
      '  --tu-accent: var(--dsw-static-deepseek-500);',
      // The light theme maps bg-layer-1..3 to one white, so panels separate from
      // the page through a mixed neutral rather than through that alias.
      '  --tu-subtle: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, var(--dsw-alias-bg-base));',
      '  --tu-track: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);',
      // The year grid's empty days are a frame, not content: a heavy track turns
      // fifty weeks of nothing into a grey wall that drowns the days that filled.
      '  --tu-heat-empty: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);',
      '  --tu-heat-1: color-mix(in srgb, var(--tu-accent) 20%, transparent);',
      '  --tu-heat-2: color-mix(in srgb, var(--tu-accent) 42%, transparent);',
      '  --tu-heat-3: color-mix(in srgb, var(--tu-accent) 68%, transparent);',
      '  --tu-heat-4: var(--tu-accent);',
      '}',
      'body[data-ds-dark-theme] .dsh-tu-scope {',
      '  --tu-input: var(--dsw-static-deepseek-400);',
      '  --tu-cache-read: var(--dsw-static-green-400);',
      '  --tu-cache-write: var(--dsw-static-amber-400);',
      '  --tu-output: rgb(196, 181, 253);',
      '  --tu-accent: var(--dsw-static-deepseek-400);',
      '  --tu-subtle: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, var(--dsw-alias-bg-base));',
      '  --tu-track: color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);',
      '  --tu-heat-empty: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);',
      '  --tu-heat-1: color-mix(in srgb, var(--tu-accent) 26%, transparent);',
      '  --tu-heat-2: color-mix(in srgb, var(--tu-accent) 48%, transparent);',
      '  --tu-heat-3: color-mix(in srgb, var(--tu-accent) 74%, transparent);',
      '  --tu-heat-4: var(--tu-accent);',
      '}',
      '.dsh-tu-drop-item:hover { background: var(--dsw-alias-interactive-bg-hover) }',
      '.dsh-tu-link { cursor: pointer; text-decoration-color: transparent; transition: color .12s ease, text-decoration-color .12s ease }',
      '.dsh-tu-link:hover { color: var(--dsw-alias-label-primary); text-decoration: underline }',
      '.dsh-tu-link:focus-visible { outline: 2px solid var(--tu-accent); outline-offset: 1px; border-radius: 2px }',
      '@keyframes dsh-tu-pulse { 0%, 100% { opacity: 1; transform: scale(1) } 50% { opacity: .35; transform: scale(.82) } }',
      '.dsh-tu-live { animation: dsh-tu-pulse 1.6s ease-in-out infinite }',
      '@media (prefers-reduced-motion: reduce) { .dsh-tu-live { animation: none } }',
      '.dsh-tu-channel { border-radius: var(--dsw-radius-sm); transition: background-color .12s ease }',
      '.dsh-tu-channel:hover { background: var(--tu-subtle) }',
      '.dsh-tu-row > td { transition: background-color .12s ease }',
      '.dsh-tu-row:hover > td { background: var(--tu-subtle) }',
      '.dsh-tu-detail > td { background: var(--tu-subtle) }',
      '.dsh-tu-zero > td { opacity: .55 }',
      '.dsh-tu-scroll::-webkit-scrollbar { width: 8px; height: 8px }',
      '.dsh-tu-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 999px }',
      '.dsh-tu-scroll::-webkit-scrollbar-track { background: transparent }',
    ].join('\n');

    const styles = {      // Column layout with an inner scroller. `height: 100%` resolves to the
      // container's height when it has one and falls back to content height when
      // it does not, so neither host surface collapses. `minHeight: 0` is what
      // lets the inner scroller actually shrink inside a flex parent.
      page: {
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        padding: '16px 20px 18px',
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden',
      },
      head: { flex: 'none', marginBottom: 12 },
      title: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: '24px' },
      subtitle: { margin: '2px 0 0', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      // The day's figure: same line as the title, quiet enough not to compete with
      // the headline cards, but always present and always about today.
      today: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 6,
        padding: '3px 10px',
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-module-platform)',
        borderRadius: 999,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      },
      todayDot: {
        width: 6,
        height: 6,
        borderRadius: 999,
        flex: 'none',
        background: 'var(--tu-accent)',
      },
      todayLabel: { color: 'var(--dsw-alias-label-secondary)' },
      todayValue: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      todayMeta: { color: 'var(--dsw-alias-label-secondary)' },
      // The live gauge: quiet while idle, unmistakably alive while something runs.
      live: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        marginTop: 6,
        marginLeft: 6,
        padding: '3px 10px',
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-module-platform)',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      },
      liveOn: { color: 'var(--dsw-alias-label-primary)' },
      liveDot: {
        width: 6,
        height: 6,
        borderRadius: 999,
        flex: 'none',
        background: 'var(--dsw-alias-label-tertiary)',
        opacity: 0.5,
      },
      liveDotActive: { background: 'var(--tu-cache-read)', opacity: 1 },
      tabs: {
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        flex: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        // The platform's segmented-control trough, so the strip reads as part of
        // the same family as the settings switchers.
        background: 'var(--dsw-alias-bg-module-platform)',
      },
      tab: {
        appearance: 'none',
        border: 'none',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '20px',
        padding: '3px 12px',
        cursor: 'pointer',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
      },
      tabActive: {
        appearance: 'none',
        border: 'none',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '20px',
        padding: '3px 12px',
        cursor: 'pointer',
        borderRadius: 'var(--dsw-radius-sm)',
        // The raised fill, so the selected pill sits *above* the trough in both
        // themes; a bare layer alias inverted the contrast in dark mode.
        background: 'var(--dsw-alias-button-elevated-fill)',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 500,
      },
      // The headline block: four figures wide enough to read at a glance, and the
      // rest one click away. Seven equal cards made every number look equally
      // important, which reads as noise.
      hero: { flex: 'none', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 },
      heroRow: { display: 'flex', alignItems: 'stretch', gap: 8, minWidth: 0 },
      stats: {
        flex: 1,
        minWidth: 0,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(158px, 1fr))',
        gap: 8,
      },
      stat: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 4,
        minHeight: 78,
        padding: '10px 14px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        background: 'var(--dsw-alias-settings-card-fill)',
        borderRadius: 'var(--dsw-radius-md)',
        minWidth: 0,
      },
      statLabel: {
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      statValue: {
        fontSize: 22,
        fontWeight: 600,
        lineHeight: '28px',
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.02em',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      statHint: {
        fontSize: 12,
        lineHeight: '15px',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      // The expander: a quiet control that reveals the secondary figures.
      more: {
        flex: 'none',
        alignSelf: 'flex-start',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: 28,
        padding: '0 10px',
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        borderRadius: 999,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      unit: { fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-secondary)', marginLeft: 2 },
      dot: {
        display: 'inline-block',
        width: 5,
        height: 5,
        borderRadius: 999,
        marginRight: 4,
        verticalAlign: 'middle',
      },
      streamCell: { color: 'var(--dsw-alias-label-secondary)' },
      section: { flex: 'none', marginBottom: 16 },
      // Section heading in the platform's own idiom (the trajectory usage panel's
      // heading): secondary colour at the medium weight, no tracking.
      sectionTitle: {
        margin: '0 0 8px',
        fontSize: 12,
        fontWeight: 500,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      // Charts live in one card each: a heading row, a plotted area, and an axis
      // row. The card carries no inner boxes, so the plot reads as the object.
      chart: {
        display: 'flex',
        flexDirection: 'column',
        padding: '12px 14px 10px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        background: 'var(--dsw-alias-settings-card-fill)',
        borderRadius: 'var(--dsw-radius-md)',
      },
      chartHead: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        flexWrap: 'wrap',
        marginBottom: 10,
      },
      chartTitle: { fontSize: 13, fontWeight: 600, lineHeight: '20px' },
      chartMeta: {
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      // The plot: gridlines sit behind, bars grow from the baseline in front.
      plot: { position: 'relative', height: 132 },
      plotGrid: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none' },
      plotLine: {
        position: 'absolute',
        left: 0,
        right: 0,
        borderTop: '0.5px solid var(--dsw-alias-border-l1)',
      },
      plotTag: {
        position: 'absolute',
        left: 0,
        top: -2,
        fontSize: 12,
        lineHeight: '14px',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      plotBars: { position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 3, height: '100%' },
      plotBar: {
        flex: 1,
        minWidth: 2,
        // A column of one segment per bucket, so a bar reads as composition
        // rather than as one flat total.
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        borderRadius: '4px 4px 0 0',
        overflow: 'hidden',
      },
      plotBarEmpty: {
        flex: 1,
        minWidth: 2,
        // A stub, not a gap: with no height the flex row collapses the box to
        // zero and a window with few active days reads as a broken chart.
        height: 3,
        borderRadius: 2,
        background: 'var(--tu-track)',
      },
      // The hit-rate line shares the card with the bars and the same x positions,
      // so a drop in reuse lines up with the day that caused it.
      ratePlot: { position: 'relative', height: 44, marginTop: 4 },
      rateGrid: {
        position: 'absolute',
        left: 0,
        right: 0,
        borderTop: '0.5px dashed var(--dsw-alias-border-l1)',
        pointerEvents: 'none',
      },
      rateSvg: { display: 'block', width: '100%', height: 44 },
      chartAxis: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
        marginTop: 6,
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      // Decodes the stacked trend: inside a bar, hue is the only thing naming a
      // bucket, so the chart is unreadable without this key.
      legend: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 12px',
        padding: '6px 11px 0',
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      legendItem: { display: 'inline-flex', alignItems: 'center', gap: 4 },
      legendSwatch: { width: 8, height: 8, borderRadius: 2, flex: 'none' },
      // Year heat map: weekday rows, one column per week, cells square and sized
      // by the column so the grid fills the card instead of clustering in a corner.
      heatCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 14px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        background: 'var(--dsw-alias-settings-card-fill)',
        borderRadius: 'var(--dsw-radius-md)',
      },
      heatMonths: {
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      },
      heatBody: { display: 'grid', gap: 3, alignItems: 'center' },
      heatWeekday: {
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        paddingRight: 6,
        whiteSpace: 'nowrap',
      },
      heatCell: { aspectRatio: '1 / 1', width: '100%', minWidth: 0, borderRadius: 3 },
      heatFoot: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      heatLegend: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        flex: 'none',
      },
      heatSwatch: { width: 10, height: 10, borderRadius: 2, flex: 'none' },
      // Legacy split-bar rate styles are gone; the rate is drawn as a line inside
      // the trend card (see ratePlot/rateSvg above), so nothing here paints it.
      // Durable storage: what is on disk, where, and how far back it reaches.
      // A single line in the footer rather than a panel of its own — it qualifies
      // the numbers, it is not one of them.
      storeTop: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
      },
      storeDot: {
        width: 7,
        height: 7,
        borderRadius: 999,
        flex: 'none',
        background: 'var(--tu-cache-read)',
      },
      storeDotOff: {
        width: 7,
        height: 7,
        borderRadius: 999,
        flex: 'none',
        background: 'var(--tu-cache-write)',
      },
      // Channel cards: one per serving route, largest first.
      // Channels read as a ranked list, not as a row of cards: the question is which
      // route carries the tokens, and a list answers it by position instead of
      // asking the eye to compare five separate boxes.
      channelCard: {
        display: 'flex',
        flexDirection: 'column',
        padding: '6px 14px 8px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        background: 'var(--dsw-alias-settings-card-fill)',
        borderRadius: 'var(--dsw-radius-md)',
      },
      channelRow: {
        display: 'grid',
        gridTemplateColumns: 'minmax(86px, 160px) 56px minmax(80px, 460px) 1fr 72px 60px 86px',
        alignItems: 'center',
        gap: 12,
        padding: '7px 0',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
      },
      channelHead: { paddingTop: 2, paddingBottom: 6, color: 'var(--dsw-alias-label-secondary)' },
      channelLast: { borderBottom: 'none', paddingBottom: 2 },
      channelName: {
        fontSize: 13,
        lineHeight: '18px',
        fontWeight: 500,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      channelNum: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      // The bar carries the same four-segment composition the trend uses, so a
      // channel that is nearly all cache read looks different from one that is
      // nearly all fresh input.
      channelTrack: {
        display: 'flex',
        gap: 1,
        height: 6,
        borderRadius: 999,
        background: 'var(--tu-track)',
        overflow: 'hidden',
      },
      // Overview stacks its own sections and scrolls as a whole.
      overview: { flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 },
      toolbar: {
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        marginBottom: 8,
      },
      input: {
        boxSizing: 'border-box',
        height: 28,
        width: 240,
        padding: '0 10px',
        fontSize: 12,
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
      },
      // A native <select> opens the platform's own list, which no stylesheet can
      // reach. This listbox reproduces the harness menu surface instead: the same
      // fill, backdrop filter, elevation and item metrics as ui-primitives' Menu,
      // with the compact item scale the toolbar needs.
      dropRoot: { position: 'relative', display: 'inline-flex' },
      dropTrigger: {
        boxSizing: 'border-box',
        height: 28,
        minWidth: 104,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        padding: '0 8px',
        fontSize: 12,
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer',
      },
      dropCaret: { flex: 'none', fontSize: 9, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
      // Full-viewport catcher: a click anywhere outside dismisses the list, so
      // the plugin needs no document-level listener to unhook on dispose.
      dropBackdrop: { position: 'fixed', inset: 0, zIndex: 99 },
      dropMenu: {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        left: 0,
        zIndex: 100,
        boxSizing: 'border-box',
        minWidth: 156,
        padding: 4,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-menu-surface-fill)',
        backdropFilter: 'var(--dsw-menu-backdrop-filter)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
      },
      dropItem: {
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        minHeight: 24,
        padding: '2px 6px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '17px',
        textAlign: 'left',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      // The page box is the current page when empty, so it reads as a label until
      // it is typed into.
      pageInput: {
        boxSizing: 'border-box',
        height: 26,
        width: 52,
        padding: '0 6px',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
        fontVariantNumeric: 'tabular-nums',
      },
      buttonOn: {
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-button-elevated-fill)',
      },
      /** Zero-height flex item that ends the toolbar's first line. */
      toolbarBreak: { flexBasis: '100%', height: 0 },
      spacer: { flex: 1 },
      nav: { display: 'inline-flex', alignItems: 'center', gap: 6 },
      count: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' },
      button: {
        appearance: 'none',
        height: 26,
        minWidth: 26,
        padding: '0 8px',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
      },
      buttonOff: {
        appearance: 'none',
        height: 26,
        minWidth: 26,
        padding: '0 8px',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'default',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
        opacity: 0.5,
      },
      scroller: { flex: 1, minHeight: 0, overflow: 'auto' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: {
        position: 'sticky',
        top: 0,
        zIndex: 1,
        textAlign: 'right',
        padding: '6px 8px',
        background: 'var(--dsw-alias-bg-base)',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 500,
        fontSize: 12,
        lineHeight: '16px',
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
      },
      thLeft: {
        position: 'sticky',
        top: 0,
        zIndex: 1,
        textAlign: 'left',
        padding: '6px 8px',
        background: 'var(--dsw-alias-bg-base)',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 500,
        fontSize: 12,
        lineHeight: '16px',
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
      },
      // A header a click can reorder by: the column carries the pointer, and the
      // arrow names which column the visible order belongs to.
      thSortable: { cursor: 'pointer', userSelect: 'none' },
      thActive: { color: 'var(--dsw-alias-label-primary)' },
      thArrow: { marginLeft: 3, fontSize: 9, color: 'var(--tu-accent)' },
      td: {
        textAlign: 'right',
        padding: '6px 8px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        verticalAlign: 'middle',
      },
      tdTime: {
        textAlign: 'left',
        padding: '6px 8px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-secondary)',
        verticalAlign: 'middle',
      },
      // Session and model keep a floor so a long value is truncated by the window,
      // not squeezed to a few characters: `maxWidth: 0` alone let the column
      // collapse to `deepseek-…`, which hides the one fact the row exists to show.
      tdSession: {
        textAlign: 'left',
        padding: '6px 8px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        whiteSpace: 'nowrap',
        verticalAlign: 'middle',
        minWidth: 150,
        maxWidth: 280,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: 'var(--dsw-alias-label-secondary)',
      },
      tdModel: {
        textAlign: 'left',
        padding: '6px 8px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        whiteSpace: 'nowrap',
        verticalAlign: 'middle',
        minWidth: 180,
        maxWidth: 340,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      // Channel names read as the platform's neutral tag: a tinted capsule with no
      // border, at the dense-table type size and the small radius.
      chip: {
        display: 'inline-block',
        fontSize: 12,
        lineHeight: '20px',
        padding: '0 4px',
        borderRadius: 'var(--dsw-radius-xs)',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      // The absent-channel tag keeps the dashed outline to read as "not labelled",
      // which a filled capsule would claim.
      chipMuted: {
        display: 'inline-block',
        fontSize: 12,
        lineHeight: '20px',
        padding: '0 4px',
        border: '1px dashed var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-xs)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      // A grouped list is short, so it sits in a card: a table that stops halfway
      // down an empty page reads as a table that failed to load.
      tableCard: {
        margin: '0 2px',
        padding: '0 14px 10px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
        background: 'var(--dsw-alias-settings-card-fill)',
        borderRadius: 'var(--dsw-radius-md)',
      },
      tdGroup: {
        textAlign: 'left',
        padding: '8px 8px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        verticalAlign: 'middle',
        minWidth: 180,
        maxWidth: 420,
      },
      groupName: {
        display: 'block',
        fontSize: 13,
        fontWeight: 500,
        lineHeight: '20px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      // The share of the filtered total: a short track with the figure beside it,
      // which is the one reading the old hairline was trying to make.
      shareCell: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
      },
      shareTrack: {
        flex: 'none',
        width: 54,
        height: 5,
        borderRadius: 999,
        background: 'var(--tu-track)',
        overflow: 'hidden',
      },
      shareBar: { height: '100%', background: 'var(--tu-accent)' },
      // The date rule. Sticky under the header, so the day a row belongs to stays
      // on screen while its rows are read.
      dayCell: {
        position: 'sticky',
        // Right under the header: 6px + 6px padding on a 16px line plus its border.
        top: 29,
        zIndex: 1,
        padding: '7px 8px 5px',
        background: 'var(--dsw-alias-bg-base)',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        textAlign: 'left',
      },
      dayRow: { display: 'flex', alignItems: 'baseline', gap: 8 },
      dayLabel: {
        fontSize: 12,
        fontWeight: 600,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary)',
      },
      dayMeta: {
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      caret: {
        display: 'inline-block',
        width: 10,
        marginRight: 4,
        color: 'var(--dsw-alias-label-secondary)',
      },
      detailCell: {
        padding: 0,
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--tu-subtle)',
      },
      detailWrap: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '10px 32px',
        padding: '10px 14px 12px 26px',
      },
      detailCol: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 210 },
      detailLine: { display: 'flex', gap: 8, fontSize: 12, lineHeight: '18px' },
      detailKey: {
        minWidth: 76,
        color: 'var(--dsw-alias-label-secondary)',
        flex: 'none',
      },
      detailVal: {
        fontVariantNumeric: 'tabular-nums',
        wordBreak: 'break-all',
      },
      bucketLine: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 18,
        fontSize: 12,
        lineHeight: '18px',
        minWidth: 210,
      },
      bucketKey: { color: 'var(--dsw-alias-label-secondary)' },
      bucketVal: { fontVariantNumeric: 'tabular-nums' },
      bucketSub: { paddingLeft: 12, color: 'var(--dsw-alias-label-secondary)' },
      bucketTotal: { fontWeight: 600 },
      detailTimes: {
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
        padding: '10px 14px 0 26px',
      },
      strong: { fontWeight: 600 },
      // A hairline between the identity columns and each metric block, so a
      // twelve-column row reads as groups instead of one wall of digits.
      divider: { borderLeft: '1px solid var(--dsw-alias-border-l1)' },
      // The non-total metrics sit back so the eye lands on 合计 first.
      numDim: { color: 'var(--dsw-alias-label-secondary)' },
      // The 合计 cell: the figure over its composition bar. The number keeps the
      // column's right edge; the bar answers "made of what" without a second column.
      stackCell: { display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 },
      compose: {
        display: 'flex',
        width: 54,
        height: 3,
        gap: 1,
        borderRadius: 999,
        overflow: 'hidden',
        background: 'var(--tu-track)',
      },
      // `minWidth` keeps a bucket that is a fraction of a percent visible as a sliver
      // instead of vanishing, which is what the platform's own composition bar does.
      composeSeg: { flexBasis: 0, minWidth: 1, height: '100%' },
      footRow: {
        flex: 'none',
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        marginTop: 8,
      },
      foot: {
        flex: '1 1 auto',
        minWidth: 0,
        margin: 0,
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      empty: {
        border: '1px dashed var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-lg)',
        padding: '28px 20px',
        textAlign: 'center',
        fontSize: 13,
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary)',
      },
    };

    /**
     * One summary figure.
     *
     * @param props - Label, primary value, optional unit, and an exact figure shown dimmed below.
     * @returns The stat card.
     */
    function Stat({ label, value, unit, hint, title, dot }) {
      return h(
        'div',
        { style: styles.stat },
        h(
          'span',
          { style: styles.statLabel },
          dot === undefined ? null : h('span', { style: { ...styles.dot, background: dot } }),
          label,
        ),
        h(
          'span',
          // The face may be compact and the tooltip exact: the number never loses
          // precision, it just stops shouting it.
          { style: styles.statValue, title: title === undefined ? String(value) : title },
          value,
          unit === undefined ? null : h('span', { style: styles.unit }, unit),
        ),
        hint === undefined ? null : h('span', { style: styles.statHint, title: hint }, hint),
      );
    }

    /** The request-log page; rendered in the `main` slot and as a Settings page. */
    function TokenUsagePanel(props) {
      const [filter, setFilter] = React.useState('');
      const [range, setRange] = React.useState('all');
      const [rangeOpen, setRangeOpen] = React.useState(false);
      const [pageOpen, setPageOpen] = React.useState(false);
      const [view, setView] = React.useState('overview');
      const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE);
      const [page, setPage] = React.useState(1);
      // Key of the one open detail row; null when every row is collapsed.
      const [expanded, setExpanded] = React.useState(null);
      // Column the visible rows are ordered by; a header click owns it.
      const [sort, setSort] = React.useState(DEFAULT_SORT);
      // Secondary headline figures stay folded away until asked for.
      const [moreMetrics, setMoreMetrics] = React.useState(false);
      // Structured filters: a free-text box is fine for a hunch, but "show me this
      // channel" is a click, not a spelling test. '' means every value.
      const [channelFilter, setChannelFilter] = React.useState('');
      const [modelFilter, setModelFilter] = React.useState('');
      const [channelOpen, setChannelOpen] = React.useState(false);
      const [modelOpen, setModelOpen] = React.useState(false);
      // While paused the table keeps the rows it had, so a reader is not pushed
      // down the page by a request that lands mid-sentence.
      const [frozen, setFrozen] = React.useState(null);
      const [pageDraft, setPageDraft] = React.useState('');

      // The seat is always present; the fallback only guards a foreign composition.
      const selectSessions = typeof props.useSessions === 'function' ? props.useSessions : selectEmpty;
      const ids = selectSessions((state) => state.ids);
      const byId = selectSessions((state) => state.byId);
      const projections = selectSessions((state) => state.projectionsBySession);

      // Durable history. The projection is bounded per Session and dies with a
      // state-version bump; the Host's append-only ledger is neither, so the
      // year-scale views read it and fall back to the rows when it is unavailable.
      const ledger = useLedger();
      const projected = React.useMemo(() => buildLog(ids, byId, projections), [ids, byId, projections]);
      // The projection is the richer source while it holds rows (routes, timings,
      // titles); the durable rows take over when it holds none, so a detached or
      // version-bumped Session still shows its history instead of an empty page.
      const log = React.useMemo(() => {
        if (projected.rows.length > 0) return projected;
        const fromLedger = buildLedgerLog(ledger, byId);
        return fromLedger.rows.length > 0 ? fromLedger : projected;
      }, [projected, ledger, byId]);
      const durableDays = ledger !== undefined && Array.isArray(ledger.days) ? ledger.days : undefined;
      const durableTotals = ledger !== undefined && ledger.totals !== undefined ? ledger.totals : undefined;
      // Which record is more complete decides the source — nothing else. The test is
      // a count of attempts, because that is what "more complete" means here.
      //
      // This deliberately does NOT compare day spans. It used to, and that was a bug:
      // `spanDays` has a 28-day floor so a young install still draws a readable axis,
      // and comparing a 20-day ledger against that floored 28 rejected the ledger for
      // being "shorter" — even when it held 36,776 attempts against the rows' 22,809.
      // The panel then fell back to the truncated rows and the totals dropped by
      // gigabytes. A floor meant for chart geometry must never arbitrate between two
      // data sources.
      const durableSpan = daySpan(durableDays, HEATMAP_DAYS);
      const ledgerAhead = durableTotals !== undefined && durableTotals.requests >= log.rows.length;
      // The ledger keeps totals, not rows, so it can answer "every day", "every
      // model" and "everything" — but not "one channel's rows of the last 7 days". When a
      // filter is on, the rows are the only thing that can answer, and they carry
      // the window's own caveat.
      const unfiltered = range === 'all' && channelFilter === '' && modelFilter === '' && filter.trim() === '';
      const useLedgerAggregates = ledgerAhead && unfiltered && ledger !== undefined;
      const useDurable = durableDays !== undefined && ledgerAhead;

      // Live concurrency, straight from the session list's own running flag: the Host
      // sets it while a Session owns a running Agent, and the list store pushes it,
      // so this is a gauge rather than a poll. One running Session is one in-flight
      // conversation turn — the same thing new-api shows as 并发.
      const concurrency = React.useMemo(() => {
        const running = [];
        let agentAvailable = 0;
        for (const id of (Array.isArray(ids) ? ids : [])) {
          const summary = byId === undefined ? undefined : byId[id];
          if (summary === undefined || summary === null) continue;
          if (summary.agentAvailable === true) agentAvailable += 1;
          if (summary.running === true) {
            running.push({ id, title: titleOf(byId, id), updatedAt: count(summary.updatedAt) });
          }
        }
        return { running, agentAvailable };
      }, [ids, byId]);

      // The Host's own count of open steps, when it reports one: the only number
      // that can exceed the running-session count, because one conversation may
      // hold several calls in flight.
      const stepsInFlight = ledger !== undefined
        && ledger.live !== undefined
        && typeof ledger.live.steps === 'number'
        ? ledger.live.steps
        : undefined;

      // Today, always today and never the filter: the question "how much have I used
      // today" is asked before any window is picked, and a figure that moved with a
      // channel filter would answer a different question. The durable day is the
      // whole day; the retained rows are the fallback while the ledger is unread.
      const todayKey = dayKey(Date.now());
      const today = React.useMemo(() => {
        const totals = zeroTotals();
        let requests = 0;
        for (const row of log.rows) {
          if (dayKey(row.time) !== todayKey) continue;
          addRow(totals, row);
          requests += 1;
        }
        const cacheable = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
        const fromRows = {
          requests,
          tokens: totals.totalTokens,
          hitRate: cacheable === 0 ? undefined : totals.cacheReadTokens / cacheable,
          fromLedger: false,
        };
        const durable = durableDays === undefined
          ? undefined
          : durableDays.find((day) => day !== null && typeof day === 'object' && day.day === todayKey);
        // The ledger day is the whole day only once it holds the whole history: an
        // incomplete ledger — one that has not swept yet — must not be allowed to
        // report less than the retained rows already show.
        if (durable === undefined || count(durable.totalTokens) < fromRows.tokens) return fromRows;
        return {
          requests: count(durable.requests),
          tokens: count(durable.totalTokens),
          hitRate: typeof durable.cacheHitRate === 'number' ? durable.cacheHitRate : undefined,
          fromLedger: true,
        };
      }, [durableDays, log.rows, todayKey]);

      // One filtered row set feeds the summary, the counters and every view, so the
      // headline figures always describe exactly the rows on screen.
      const filtered = React.useMemo(() => {
        const window = RANGES.find((candidate) => candidate.id === range);
        const since = window === undefined || window.ms === undefined ? 0 : Date.now() - window.ms;
        const needle = filter.trim().toLowerCase();
        return log.rows.filter((row) => {
          if (since !== 0 && row.time < since) return false;
          if (channelFilter !== '' && channelKeyOf(row) !== channelFilter) return false;
          if (modelFilter !== '' && modelKeyOf(row) !== modelFilter) return false;
          if (needle === '') return true;
          return `${row.title} ${row.channel} ${row.model} ${row.sessionId}`.toLowerCase().includes(needle);
        });
      }, [log.rows, filter, range, channelFilter, modelFilter]);

      // What the table shows: the live rows, or the set captured when the reader
      // paused. Everything above the table keeps updating either way.
      const live = filtered;
      const shown = frozen === null ? live : frozen.rows;
      const newWhilePaused = frozen === null ? 0 : Math.max(log.rows.length - frozen.logRows, 0);

      // The pickers list what this log actually holds, largest first, so the list
      // is never longer than the data behind it.
      const channelOptions = React.useMemo(() => pickerOptions(log.rows, channelKeyOf, '全部渠道'), [log.rows]);
      const modelOptions = React.useMemo(() => pickerOptions(log.rows, modelKeyOf, '全部模型'), [log.rows]);
      // A frozen table under a changed filter would silently ignore the change, so
      // any narrowing of the view resumes the live read.
      React.useEffect(() => {
        setFrozen(null);
      }, [filter, range, channelFilter, modelFilter]);

      const filtersOn = filter.trim() !== '' || channelFilter !== '' || modelFilter !== '' || range !== 'all';
      const clearFilters = () => {
        setFilter('');
        setChannelFilter('');
        setModelFilter('');
        setRange('all');
        setPage(1);
      };

      const usage = React.useMemo(() => {
        if (useLedgerAggregates && durableTotals !== undefined) {
          const t = durableTotals;
          const summed = zeroTotals();
          for (const bucket of BUCKETS) summed[bucket.key] = count(t[bucket.key]);
          summed.promptTokens = count(t.promptTokens);
          summed.completionTokens = count(t.completionTokens);
          summed.totalTokens = count(t.totalTokens);
          return {
            totals: summed,
            rows: count(t.requests),
            sessions: Array.isArray(ledger.sessions) ? ledger.sessions.length : 0,
            timedRows: t.timedRequests === undefined ? undefined : count(t.timedRequests),
            latencyRows: count(t.requests),
            avgLatencyMs: typeof t.avgLatencyMs === 'number' ? t.avgLatencyMs : undefined,
            avgFirstTokenMs: typeof t.avgFirstTokenMs === 'number' ? t.avgFirstTokenMs : undefined,
            speed: typeof t.speed === 'number' ? t.speed : undefined,
            fromLedger: true,
          };
        }
        const summed = zeroTotals();
        const sessions = new Set();
        let speedTokens = 0;
        let speedMs = 0;
        let timedRows = 0;
        let latencyTotal = 0;
        let latencyRows = 0;
        let firstTokenTotal = 0;
        for (const row of filtered) {
          addRow(summed, row);
          sessions.add(row.sessionId);
          if (row.latencyMs !== undefined) {
            latencyTotal += row.latencyMs;
            latencyRows += 1;
          }
          if (row.firstTokenMs !== undefined) {
            timedRows += 1;
            firstTokenTotal += row.firstTokenMs;
          }
          if (
            row.firstTokenMs !== undefined
            && row.completionTokens >= SPEED_MIN_OUTPUT_TOKENS
            && row.generationMs !== undefined
            && row.generationMs >= SPEED_MIN_GENERATION_MS
          ) {
            speedTokens += row.completionTokens;
            speedMs += row.generationMs;
          }
        }
        summed.promptTokens = summed.uncachedInputTokens + summed.cacheReadTokens + summed.cacheWriteTokens;
        summed.completionTokens = summed.outputTokens;
        return {
          totals: summed,
          rows: filtered.length,
          sessions: sessions.size,
          timedRows,
          latencyRows,
          avgLatencyMs: latencyRows === 0 ? undefined : latencyTotal / latencyRows,
          avgFirstTokenMs: timedRows === 0 ? undefined : firstTokenTotal / timedRows,
          speed: speedMs > 0 ? speedTokens / (speedMs / 1000) : undefined,
          fromLedger: false,
        };
      }, [filtered, useLedgerAggregates, durableTotals, ledger]);

      const grouped = React.useMemo(() => {
        // A day's figure has to survive the day being over. Folding it from the
        // browser's retained rows cannot: every Session slowly drops its oldest
        // rows, so a past day reports less each time it is looked at. The ledger's
        // own per-day totals only grow.
        if (useLedgerAggregates) {
          const source = view === 'day'
            ? ledger.days
            : view === 'model'
              ? ledger.models
              : view === 'channel'
                ? ledger.channels
                : undefined;
          if (Array.isArray(source)) {
            const list = source
              .map((entry) => groupFromLedger(view, entry))
              .filter((entry) => entry !== undefined);
            list.sort((left, right) => right.totalTokens - left.totalTokens);
            return list;
          }
        }
        if (view === 'model') {
          return groupBy(filtered, (row) => (row.model === '' ? '未标注' : `${row.channel} / ${row.model}`));
        }
        if (view === 'channel') return groupBy(filtered, (row) => (row.channel === '' ? '未标注' : row.channel));
        if (view === 'day') return groupBy(filtered, (row) => dayKey(row.time));
        return [];
      }, [filtered, view, useLedgerAggregates, ledger]);

      // The trend follows the window: an hour-wide window reads as hourly buckets,
      // anything wider as one bucket per day. An explicit day window keeps its own
      // width; the open-ended ones take the span the retained rows actually cover.
      const trend = React.useMemo(
        () => (range === '24h'
          ? { unit: '小时', points: hourSeries(filtered, 24) }
          : {
              unit: '天',
              points:
                range === 'all' && useDurable && filter.trim() === ''
                  ? trendFromDays(durableDays, Math.max(spanDays(filtered, TREND_DAYS, 7), Math.min(durableSpan, TREND_DAYS)))
                  : daySeries(filtered, range === '7d' ? 7 : spanDays(filtered, TREND_DAYS, 7)),
            }),
        [filtered, range, useDurable, durableDays, durableSpan, filter],
      );

      // The heat map is a year view, so it reads every recorded day rather than the
      // filtered set — a map that emptied out when a filter changed would be
      // useless. The durable series is preferred because it is not bounded by the
      // Session's retained window, which is what left the early months blank. Its
      // own span sets the width, with the same readable floor a young install needs.
      const heat = React.useMemo(
        () => (useDurable
          ? heatFromDays(durableDays, Math.max(durableSpan, 28))
          : heatDays(log.rows, spanDays(log.rows, HEATMAP_DAYS, 28))),
        [useDurable, durableDays, durableSpan, log.rows],
      );

      const rate = React.useMemo(
        () => (range === '24h'
          ? rateSeries(filtered, 24, true)
          : rateSeries(filtered, range === '7d' ? 7 : spanDays(filtered, TREND_DAYS, 7), false)),
        [filtered, range],
      );

      const channels = React.useMemo(() => {
        if (useLedgerAggregates && Array.isArray(ledger.channels)) {
          const list = ledger.channels
            .map((entry) => groupFromLedger('channel', entry))
            .filter((entry) => entry !== undefined);
          list.sort((left, right) => right.totalTokens - left.totalTokens);
          return list;
        }
        return groupBy(filtered, (row) => (row.channel === '' ? '未标注' : row.channel));
      }, [filtered, useLedgerAggregates, ledger]);

      // Ordering reads the same filtered set, so every headline figure still
      // describes exactly the rows on screen; only their sequence changes.
      const ordered = React.useMemo(() => sortRows(shown, sort), [shown, sort]);

      const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
      const current = Math.min(Math.max(1, page), pageCount);
      const slice = ordered.slice((current - 1) * pageSize, current * pageSize);
      const goToPage = () => {
        const wanted = Number(pageDraft);
        setPageDraft('');
        if (!Number.isFinite(wanted) || pageDraft === '') return;
        setPage(Math.min(Math.max(Math.round(wanted), 1), pageCount));
      };
      // Pausing captures the rows and the log length, so the panel can say how
      // much arrived while the reader was holding still.
      const togglePaused = () => {
        if (frozen === null) setFrozen({ rows: live, logRows: log.rows.length });
        else setFrozen(null);
      };

      const cacheable =
        usage.totals.cacheReadTokens + usage.totals.cacheWriteTokens + usage.totals.uncachedInputTokens;
      const hitRate = cacheable === 0 ? '—' : `${((usage.totals.cacheReadTokens / cacheable) * 100).toFixed(1)}%`;

      const head = h(
        'div',
        { style: styles.head },
        h('h2', { style: styles.title }, 'Token 用量'),
        h(
          'p',
          { style: styles.subtitle },
          '沿用 provider 上报的 usage。提示 = 输入 + 缓存读 + 缓存写；补全 = 生成输出；速度 = 补全 ÷ 生成时间。',
        ),
        // The day's own figure, in the one place every view shows and no filter moves.
        h(
          'div',
          {
            style: styles.today,
            title: '今天的用量，不受时间范围与筛选影响；点一下到「日期」看每天的明细',
            role: 'button',
            tabIndex: 0,
            onClick: () => setView('day'),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              setView('day');
            },
          },
          h('span', { style: styles.todayDot }),
          h('span', { style: styles.todayLabel }, `今日 ${todayKey.slice(5)}`),
          h('span', { style: styles.todayValue }, `${compact(today.tokens)} tokens`),
          h('span', { style: styles.todayMeta }, `${exact(today.requests)} 次请求`),
          today.hitRate === undefined
            ? null
            : h('span', { style: styles.todayMeta }, `命中 ${(today.hitRate * 100).toFixed(1)}%`),
          h(
            'span',
            { style: styles.todayMeta },
            today.fromLedger ? '全量（账本）' : '按保留记录',
          ),
        ),
        // The live gauge: how many conversations are working right now. No window
        // and no filter changes it, because it is not a total — it is a state.
        h(
          'div',
          {
            style: concurrency.running.length === 0 ? styles.live : { ...styles.live, ...styles.liveOn },
            title: (concurrency.running.length === 0
              ? '当前没有正在运行的会话'
                + (concurrency.agentAvailable > 0 ? `（活跃 Agent ${exact(concurrency.agentAvailable)} 个）` : '')
              : '正在运行：'
                + concurrency.running.map((entry) => `\n· ${entry.title}`).join('')
                + `\n\n活跃 Agent ${exact(concurrency.agentAvailable)} 个`)
              + (stepsInFlight === undefined
                ? ''
                : `\n\nHost 侧在飞的步骤：${exact(stepsInFlight)} 个（每 30 秒采样一次，可能略滞后）`),
          },
          h('span', {
            style: concurrency.running.length === 0 ? styles.liveDot : { ...styles.liveDot, ...styles.liveDotActive },
            className: concurrency.running.length === 0 ? undefined : 'dsh-tu-live',
          }),
          h('span', { style: styles.todayLabel }, '运行中'),
          h('span', { style: styles.todayValue }, exact(concurrency.running.length)),
          // A conversation can hold more than one call in flight, and the session
          // list cannot show that: only the Host's step count can.
          stepsInFlight === undefined || stepsInFlight <= concurrency.running.length
            ? null
            : h('span', { style: styles.todayMeta }, `· ${exact(stepsInFlight)} 步在飞`),
        ),
      );

      // Four figures carry the headline; the rest are one click away. Seven equal
      // cards made every number shout as loudly as every other.
      const summary = h(
        'div',
        { style: styles.hero },
        h(
          'div',
          { style: styles.heroRow },
          h(
            'div',
            { style: styles.stats },
            h(Stat, {
              label: '请求',
              value: exact(usage.rows),
              hint: `覆盖 ${exact(usage.sessions)} 个会话`,
            }),
            h(Stat, {
              label: '合计 tokens',
              value: compact(usage.totals.totalTokens),
              title: exact(usage.totals.totalTokens),
              hint: `提示 ${compact(usage.totals.promptTokens)} · 补全 ${compact(usage.totals.completionTokens)}`,
            }),
            h(Stat, {
              label: '缓存命中率',
              value: hitRate,
              hint: `缓存读 ${compact(usage.totals.cacheReadTokens)} · 写 ${compact(usage.totals.cacheWriteTokens)}`,
            }),
            h(Stat, {
              label: '输出速度',
              value: usage.speed === undefined ? '—' : usage.speed.toFixed(1),
              unit: usage.speed === undefined ? undefined : 'tok/s',
              // The ledger reports a pooled speed but not a sample count; showing a
              // invented zero would be worse than showing nothing.
              hint: usage.timedRows === undefined ? undefined : `${exact(usage.timedRows)} 条计时取样`,
            }),
          ),
          h(
            'button',
            {
              type: 'button',
              style: styles.more,
              'aria-expanded': moreMetrics,
              onClick: () => setMoreMetrics(!moreMetrics),
            },
            moreMetrics ? '收起' : '更多指标',
            h('span', { style: { ...styles.caret, transform: moreMetrics ? 'rotate(180deg)' : 'none' } }, '▾'),
          ),
        ),
        moreMetrics
          ? h(
              'div',
              { style: styles.stats },
              h(Stat, {
                label: '缓存未命中',
                dot: 'var(--tu-input)',
                value: compact(usage.totals.uncachedInputTokens),
                title: exact(usage.totals.uncachedInputTokens),
                hint: `占提示 ${shareOf(usage.totals.uncachedInputTokens, usage.totals.promptTokens)}`,
              }),
              h(Stat, {
                label: '缓存读',
                dot: 'var(--tu-cache-read)',
                value: compact(usage.totals.cacheReadTokens),
                title: exact(usage.totals.cacheReadTokens),
                hint: `占提示 ${shareOf(usage.totals.cacheReadTokens, usage.totals.promptTokens)}`,
              }),
              h(Stat, {
                label: '缓存写',
                dot: 'var(--tu-cache-write)',
                value: compact(usage.totals.cacheWriteTokens),
                title: exact(usage.totals.cacheWriteTokens),
                hint: `占提示 ${shareOf(usage.totals.cacheWriteTokens, usage.totals.promptTokens)}`,
              }),
              h(Stat, {
                label: '补全',
                dot: 'var(--tu-output)',
                value: compact(usage.totals.completionTokens),
                title: exact(usage.totals.completionTokens),
                hint: '生成输出',
              }),
              h(Stat, {
                label: '平均耗时',
                value: duration(usage.avgLatencyMs),
                hint: `${exact(usage.latencyRows)} 条计时`,
              }),
              h(Stat, {
                label: '平均首字',
                value: duration(usage.avgFirstTokenMs),
                hint: `${exact(usage.timedRows)} 条计时`,
              }),
            )
          : null,
      );

      // The view switcher and the time window both scope the same filtered rows.
      const switcher = h(
        'div',
        { style: styles.tabs, role: 'tablist' },
        ...VIEWS.map((entry) =>
          h(
            'button',
            {
              key: entry.id,
              type: 'button',
              role: 'tab',
              'aria-selected': view === entry.id,
              style: view === entry.id ? styles.tabActive : styles.tab,
              onClick: () => {
                setView(entry.id);
                setPage(1);
              },
            },
            entry.label,
          ),
        ),
      );

      // One disclosure over a small closed set: a trigger plus the menu surface.
      const toolbar = h(
        'div',
        { style: styles.toolbar },
        switcher,
        h(Dropdown, {
          key: 'range',
          label: '时间范围',
          options: RANGES,
          value: range,
          onPick: (next) => {
            setRange(next);
            setPage(1);
          },
          open: rangeOpen,
          setOpen: setRangeOpen,
        }),
        h(Dropdown, {
          key: 'channel',
          label: '渠道筛选',
          options: channelOptions,
          value: channelFilter,
          onPick: (next) => {
            setChannelFilter(next);
            setPage(1);
          },
          open: channelOpen,
          setOpen: setChannelOpen,
        }),
        h(Dropdown, {
          key: 'model',
          label: '模型筛选',
          options: modelOptions,
          value: modelFilter,
          onPick: (next) => {
            setModelFilter(next);
            setPage(1);
          },
          open: modelOpen,
          setOpen: setModelOpen,
        }),
        h('input', {
          style: styles.input,
          type: 'search',
          value: filter,
          placeholder: '搜索：会话 / 渠道 / 模型',
          'aria-label': '搜索请求日志',
          onChange: (event) => {
            setFilter(event.target.value);
            setPage(1);
          },
        }),
        filtersOn
          ? h(
              'button',
              {
                type: 'button',
                style: styles.button,
                title: '清除全部筛选，回到全部时间',
                onClick: clearFilters,
              },
              '清除筛选',
            )
          : null,
        // Paging belongs to the request log alone: the grouped views list every group.
        view === 'requests'
          ? h(Dropdown, {
              key: 'pageSize',
              label: '每页条数',
              options: PAGE_SIZES.map((size) => ({ id: String(size), label: `${size} 条 / 页` })),
              value: String(pageSize),
              onPick: (next) => {
                setPageSize(Number(next));
                setPage(1);
              },
              open: pageOpen,
              setOpen: setPageOpen,
            })
          : null,
        // The count and the pager always start their own line: with two pickers and
        // a search box the first row is full at any sane window width, and a pager
        // that lands wherever the wrap happens reads as an accident.
        h('span', { style: styles.toolbarBreak }),
        // Reading a moving table is the actual inconvenience, so this pauses the
        // table only: the headline figures keep tracking the live log.
        h(
          'button',
          {
            type: 'button',
            style: frozen === null ? styles.button : { ...styles.button, ...styles.buttonOn },
            title: frozen === null
              ? '暂停表格刷新，方便逐行查看'
              : '恢复刷新并显示这段时间到达的记录',
            onClick: togglePaused,
          },
          frozen === null
            ? '暂停'
            : newWhilePaused === 0
              ? '继续'
              : `继续 · 新增 ${exact(newWhilePaused)}`,
        ),
        h(
          'button',
          {
            type: 'button',
            style: ordered.length === 0 ? styles.buttonOff : styles.button,
            disabled: ordered.length === 0,
            title: `把当前筛选的 ${exact(ordered.length)} 行导成 CSV`,
            onClick: () => saveCsv(ordered),
          },
          '导出',
        ),
        h('span', { style: styles.spacer }),
        h(
          'span',
          { style: styles.count },
          view === 'overview'
            ? null
            : view === 'requests'
              ? `共 ${exact(shown.length)} 条`
              : `${exact(grouped.length)} 组 · ${exact(filtered.length)} 条`,
        ),
        view === 'requests'
          ? h(
              'span',
              { style: styles.nav },
              h(
                'button',
                {
                  type: 'button',
                  style: current <= 1 ? styles.buttonOff : styles.button,
                  disabled: current <= 1,
                  'aria-label': '第一页',
                  title: '第一页',
                  onClick: () => setPage(1),
                },
                '«',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: current <= 1 ? styles.buttonOff : styles.button,
                  disabled: current <= 1,
                  'aria-label': '上一页',
                  onClick: () => setPage(current - 1),
                },
                '‹',
              ),
              // 656 pages of data is not navigated one click at a time.
              h('input', {
                style: styles.pageInput,
                type: 'text',
                inputMode: 'numeric',
                value: pageDraft,
                placeholder: String(current),
                'aria-label': '跳转到页码',
                title: '输入页码后回车跳转',
                onChange: (event) => setPageDraft(event.target.value.replace(/[^0-9]/g, '')),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') goToPage();
                },
                onBlur: () => setPageDraft(''),
              }),
              h('span', { style: styles.count }, `/ ${exact(pageCount)}`),
              h(
                'button',
                {
                  type: 'button',
                  style: current >= pageCount ? styles.buttonOff : styles.button,
                  disabled: current >= pageCount,
                  'aria-label': '下一页',
                  onClick: () => setPage(current + 1),
                },
                '›',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: current >= pageCount ? styles.buttonOff : styles.button,
                  disabled: current >= pageCount,
                  'aria-label': '最后一页',
                  title: '最后一页',
                  onClick: () => setPage(pageCount),
                },
                '»',
              ),
            )
          : null,
      );

      // The grouped views share one table shape; only the label column differs.
      const groupLabel = view === 'day' ? '日期' : view === 'channel' ? '渠道' : '渠道 / 模型';


      /**
       * One request-log header, clickable to order the visible rows by its column.
       * Clicking the column that already orders them flips the direction; a new
       * column starts largest-first, which is what a scan of these figures wants.
       */
      const sortable = (key, label, style) => {
        const active = sort.key === key;
        return h(
          'th',
          {
            key,
            style: { ...style, ...styles.thSortable, ...(active ? styles.thActive : {}) },
            title: '点击按此列排序',
            'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
            onClick: () => {
              setSort((current) => (current.key === key
                ? { key, dir: current.dir === 'desc' ? 'asc' : 'desc' }
                : { key, dir: 'desc' }));
              setPage(1);
            },
          },
          label,
          active ? h('span', { style: styles.thArrow }, sort.dir === 'asc' ? '↑' : '↓') : null,
        );
      };

      // Day rules are only meaningful under a chronological order; under a token
      // ordering the days interleave and a rule per row would be noise.
      const dayRules = new Map();
      if (sort.key === 'time') {
        const perDay = new Map();
        for (const row of ordered) {
          const key = dayKey(row.time);
          const entry = perDay.get(key) ?? { count: 0, tokens: 0 };
          entry.count += 1;
          entry.tokens += row.totalTokens;
          perDay.set(key, entry);
        }
        for (let index = 0; index < ordered.length; index += 1) {
          const key = dayKey(ordered[index].time);
          const previous = index === 0 ? undefined : dayKey(ordered[index - 1].time);
          if (previous !== key) {
            const entry = perDay.get(key);
            dayRules.set(index, { key, count: entry.count, tokens: entry.tokens });
          }
        }
      }

      const requestTable = h(
        'table',
        { style: styles.table },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            sortable('time', '时间', styles.thLeft),
            sortable('title', '会话', styles.thLeft),
            sortable('channel', '渠道', styles.thLeft),
            sortable('model', '模型', styles.thLeft),
            sortable('promptTokens', '提示', { ...styles.th, ...styles.divider }),
            sortable('cacheReadTokens', '缓存读', styles.th),
            sortable('completionTokens', '补全', styles.th),
            sortable('totalTokens', '合计', styles.th),
            sortable('latencyMs', '耗时', { ...styles.th, ...styles.divider }),
            sortable('firstTokenMs', '首字', styles.th),
            sortable('speed', '速度 tok/s', styles.th),
            h('th', { style: styles.th }, '流式'),
          ),
        ),
        h(
          'tbody',
          null,
          ...slice.flatMap((row, offset) => {
            const rule = dayRules.get((current - 1) * pageSize + offset);
            const parts = [];
            if (rule !== undefined) parts.push(dayRule(rule));
            parts.push(
              requestRow(
                row,
                expanded === row.key,
                () => setExpanded(expanded === row.key ? null : row.key),
                props.openSession,
              ),
            );
            return parts;
          }),
        ),
      );

      const groupTable = h(
        'div',
        { style: styles.tableCard },
        h(
          'table',
          { style: styles.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { style: styles.thLeft }, groupLabel),
              h('th', { style: { ...styles.th, ...styles.divider } }, '占比'),
              h('th', { style: styles.th }, '请求'),
              h('th', { style: styles.th }, '提示'),
              h('th', { style: styles.th }, '缓存读'),
              h('th', { style: styles.th }, '补全'),
              h('th', { style: styles.th }, '合计'),
              h('th', { style: styles.th }, '命中'),
              h('th', { style: { ...styles.th, ...styles.divider } }, '平均耗时'),
              h('th', { style: styles.th }, '速度 tok/s'),
            ),
          ),
          h('tbody', null, ...grouped.map((group) => groupRow(group, usage.totals.totalTokens))),
        ),
      );

      // Overview: the headline figures above, then the shape of the usage over time.
      // Three panels, each answering a different question: how it moved (bars, with
      // the reuse line on the same axis), how the year filled up (weeks), and who
      // served it (channels).
      const trendPeak = trend.points.reduce((max, point) => Math.max(max, point.tokens), 0);
      const trendTotal = trend.points.reduce((sum, point) => sum + point.tokens, 0);
      const hourly = trend.unit === '小时';
      const trendFirst = trend.points.length === 0 ? '' : trend.points[0].label;
      const trendLast = trend.points.length === 0 ? '' : trend.points[trend.points.length - 1].label;
      const trendMiddle = trend.points.length === 0
        ? ''
        : trend.points[Math.floor(trend.points.length / 2)].label;
      // Bars stack smallest-to-largest from the top, so the budget-dominating cache
      // read forms the base and the accents sit above it — the same reading order
      // the cards and the legend use.
      const stackOrder = [...BUCKETS].reverse();
      const rateRunsData = rateRuns(rate);
      // The rate line keeps its own 0-100% scale inside the same card: two panes,
      // one x axis, so a collapse in reuse lines up with the day behind it.
      const rateTop = 4;
      const rateHeight = 92;

      // The year grid: whole weeks, so the columns line up with weekdays, which is
      // the only thing that makes a year of cells readable at a glance.
      const YEAR_WEEKS = 53;
      const year = yearWeeks(
        heat.map((day) => ({ day: day.key, totalTokens: day.tokens })),
        YEAR_WEEKS,
      );
      const yearActive = year.columns.reduce(
        (sum, column) => sum + column.cells.filter((cell) => cell.tokens > 0).length,
        0,
      );
      const yearTotal = year.columns.reduce(
        (sum, column) => sum + column.cells.reduce((inner, cell) => inner + cell.tokens, 0),
        0,
      );
      const yearFirst = year.columns[0].cells[0];
      const yearLast = year.columns[year.columns.length - 1].cells[6];
      const WEEKDAY_LABELS = ['一', '', '三', '', '五', '', '日'];

      // What is on disk, in one line: the ledger is what makes these totals survive a
      // restart or a projection reset, so it is stated plainly rather than celebrated.
      const sweep = ledger === undefined ? undefined : ledger.sweep;
      // Three distinct states, because they call for three different actions: a
      // missing field means the Host half predates the sweep entirely, while "not
      // run yet" and "failed" are separate problems.
      const sweepNote = ledger === undefined
        ? ''
        : ledger.sweep === undefined
          ? '· 回扫字段缺失（Host 半是旧版本，重启后才有）'
          : sweep.at === undefined
            ? '· 回扫未运行'
            : sweep.error !== undefined
              ? '· 回扫失败：' + sweep.error
              : '· 回扫 ' + exact(sweep.sessions) + ' 个会话 / 补 ' + exact(sweep.rows) + ' 行'
                + (ledgerAhead ? '' : '（仍未超过保留记录，暂按保留记录显示）');
      const storageLine = h(
        'span',
        { style: styles.storeTop, title: ledger === undefined ? undefined : ledger.file },
        h('span', { style: durableTotals === undefined ? styles.storeDotOff : styles.storeDot }),
        durableTotals === undefined
          ? '未连接：显示的是会话投影里保留的部分，重启或投影版本变化后会更少'
          : '已落盘 ' + exact(durableTotals.requests) + ' 次请求到 ' + ledger.file
            + (count(ledger.failures) > 0 ? '（写入失败 ' + exact(ledger.failures) + ' 次）' : '')
            + ' ' + sweepNote
            // Which record the figures above were read from: the difference between
            // the two sources is exactly what made a past day look like it shrank.
            + (useLedgerAggregates
              ? '· 本页数字读账本（不随会话滚动减少）'
              : ledgerAhead
                ? '· 本页数字读保留记录（有筛选，账本无法切分）'
                : '· 本页数字读保留记录（账本仍少于它）'),
      );

      const overview = h(
        'div',
        { style: styles.overview },
        h(
          'div',
          { style: styles.section },
          h(
            'div',
            { style: styles.chart },
            h(
              'div',
              { style: styles.chartHead },
              h('span', { style: styles.chartTitle }, hourly ? '近 24 小时用量' : '近 ' + trend.points.length + ' 天用量'),
              h(
                'span',
                { style: styles.chartMeta },
                '合计 ' + compact(trendTotal) + ' · 峰值 ' + compact(trendPeak),
              ),
            ),
            h(
              'div',
              { style: styles.plot },
              h(
                'div',
                { style: styles.plotGrid },
                ...[0.25, 0.5, 0.75, 1].map((fraction) =>
                  h('div', {
                    key: 'grid-' + String(fraction),
                    style: { ...styles.plotLine, bottom: String(fraction * 100) + '%' },
                  }),
                ),
              ),
              h(
                'div',
                { style: styles.plotBars },
                ...trend.points.map((point) =>
                  point.tokens === 0
                    ? h('div', {
                        key: point.key,
                        title: point.label + '  无请求',
                        style: styles.plotBarEmpty,
                      })
                    : h(
                        'div',
                        {
                          key: point.key,
                          title: point.label + '  共 ' + exact(point.tokens) + ' tokens',
                          style: {
                            ...styles.plotBar,
                            height: String(Math.max((point.tokens / trendPeak) * 100, 2)) + '%',
                          },
                        },
                        ...stackOrder.map((bucket) =>
                          point.buckets[bucket.key] === 0
                            ? null
                            : h('div', {
                                key: bucket.key,
                                style: {
                                  flexGrow: point.buckets[bucket.key],
                                  flexBasis: 0,
                                  background: bucket.color,
                                },
                              }),
                        ),
                      ),
                ),
              ),
            ),
            h(
              'div',
              { style: styles.chartAxis },
              h('span', null, trendFirst),
              h('span', null, trendMiddle),
              h('span', null, trendLast),
            ),
            h(
              'div',
              { style: { ...styles.chartHead, marginTop: 14, marginBottom: 6 } },
              h('span', { style: styles.chartTitle }, '缓存命中率'),
              h(
                'span',
                { style: styles.chartMeta },
                hitRate === '—' ? '无输入，无法计算' : '总体 ' + hitRate + '（池化：缓存读 ÷ 提示）',
              ),
            ),
            h(
              'div',
              { style: styles.ratePlot },
              h('div', { style: { ...styles.rateGrid, bottom: '50%' } }),
              h(
                'svg',
                {
                  viewBox: '0 0 ' + String(Math.max(rate.length, 1) * 10) + ' 100',
                  preserveAspectRatio: 'none',
                  style: styles.rateSvg,
                },
                ...rateRunsData.flatMap((run, index) => {
                  const line = run
                    .map((entry) => (entry.x * 10 + 5) + ',' + String(rateHeight + 4 - entry.y * rateHeight))
                    .join(' ');
                  const parts = [
                    h('polyline', {
                      key: 'line-' + String(index),
                      points: line,
                      fill: 'none',
                      stroke: 'var(--tu-accent)',
                      strokeWidth: 1.5,
                      vectorEffect: 'non-scaling-stroke',
                      strokeLinejoin: 'round',
                      strokeLinecap: 'round',
                    }),
                  ];
                  if (run.length > 1) {
                    parts.push(
                      h('polygon', {
                        key: 'area-' + String(index),
                        points: (run[0].x * 10 + 5) + ',' + String(rateHeight + 4) + ' ' + line + ' '
                          + (run[run.length - 1].x * 10 + 5) + ',' + String(rateHeight + 4),
                        fill: 'var(--tu-accent)',
                        fillOpacity: 0.12,
                        stroke: 'none',
                      }),
                    );
                  }
                  return parts;
                }),
              ),
            ),
            h(
              'div',
              { style: styles.legend },
              ...BUCKETS.map((bucket) =>
                h(
                  'span',
                  { key: bucket.key, style: styles.legendItem },
                  h('span', { style: { ...styles.legendSwatch, background: bucket.color } }),
                  bucket.label,
                ),
              ),
              h(
                'span',
                { key: 'rate', style: styles.legendItem },
                h('span', {
                  style: { ...styles.legendSwatch, background: 'var(--tu-accent)', borderRadius: 999 },
                }),
                '缓存命中率',
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: styles.section },
          h(
            'div',
            { style: styles.heatCard },
            h(
              'div',
              { style: styles.chartHead },
              h('span', { style: styles.chartTitle }, '近 ' + YEAR_WEEKS + ' 周活跃度'),
              h(
                'span',
                { style: styles.chartMeta },
                compact(yearTotal) + ' tokens · ' + exact(yearActive) + ' 天有记录',
              ),
            ),
            h(
              'div',
              {
                style: {
                  ...styles.heatBody,
                  gridTemplateColumns: 'max-content repeat(' + year.columns.length + ', minmax(0, 1fr))',
                },
              },
              h('span', { key: 'corner' }),
              ...year.columns.map((column) =>
                h('span', { key: 'month-' + column.key, style: styles.heatMonths }, column.label === null ? '' : column.label),
              ),
              ...WEEKDAY_LABELS.flatMap((label, row) => [
                h('span', { key: 'weekday-' + String(row), style: styles.heatWeekday }, label),
                ...year.columns.map((column) => {
                  const cell = column.cells[row];
                  const background = cell.future
                    ? 'transparent'
                    : cell.tokens === 0
                      ? 'var(--tu-heat-empty)'
                      : 'var(--tu-heat-' + String(cell.level) + ')';
                  return h('div', {
                    key: cell.key,
                    title: cell.future
                      ? undefined
                      : localStamp(cell.date.getTime()).slice(0, 10) + '  ' + exact(cell.tokens) + ' tokens',
                    style: { ...styles.heatCell, background, opacity: cell.future ? 0 : 1 },
                  });
                }),
              ]),
            ),
            h(
              'div',
              { style: styles.heatFoot },
              h(
                'span',
                null,
                localStamp(yearFirst.date.getTime()).slice(0, 10) + ' – ' + localStamp(yearLast.date.getTime()).slice(0, 10),
              ),
              h(
                'span',
                { style: styles.heatLegend },
                '少',
                ...[1, 2, 3, 4].map((level) =>
                  h('span', {
                    key: level,
                    style: { ...styles.heatSwatch, background: 'var(--tu-heat-' + String(level) + ')' },
                  }),
                ),
                '多',
              ),
            ),
          ),
        ),
        channels.length === 0
          ? null
          : h(
              'div',
              { style: styles.section },
              h(
                'div',
                { style: styles.chartHead },
                h('span', { style: styles.chartTitle }, '渠道'),
                h('span', { style: styles.chartMeta }, '按当前筛选，合计降序'),
              ),
              h(
                'div',
                { style: styles.channelCard },
                h(
                  'div',
                  { style: { ...styles.channelRow, ...styles.channelHead } },
                  h('span', null, '渠道'),
                  h('span', { style: styles.channelNum }, '占比'),
                  h('span', null, '构成'),
                  h('span', { key: 'slack' }),
                  h('span', { style: styles.channelNum }, '请求'),
                  h('span', { style: styles.channelNum }, '命中'),
                  h('span', { style: styles.channelNum }, '合计'),
                ),
                ...channels.map((group, index) => {
                  const share = usage.totals.totalTokens === 0
                    ? 0
                    : group.totalTokens / usage.totals.totalTokens;
                  const cacheableGroup =
                    group.uncachedInputTokens + group.cacheReadTokens + group.cacheWriteTokens;
                  const last = index === channels.length - 1;
                  return h(
                    'div',
                    {
                      key: group.key,
                      className: 'dsh-tu-channel',
                      style: last
                        ? { ...styles.channelRow, ...styles.channelLast }
                        : styles.channelRow,
                    },
                    h('span', { style: styles.channelName, title: group.key }, group.key),
                    h(
                      'span',
                      { style: { ...styles.channelNum, color: 'var(--dsw-alias-label-secondary)' } },
                      (share * 100).toFixed(1) + '%',
                    ),
                    h(
                      'div',
                      { style: styles.channelTrack },
                      ...BUCKETS.map((bucket) =>
                        group[bucket.key] === 0
                          ? null
                          : h('div', {
                              key: bucket.key,
                              style: {
                                flexGrow: group[bucket.key],
                                flexBasis: 0,
                                height: '100%',
                                background: bucket.color,
                              },
                            }),
                      ),
                    ),
                    h('span', { key: 'slack' }),
                    h(
                      'span',
                      { style: { ...styles.channelNum, color: 'var(--dsw-alias-label-secondary)' } },
                      exact(group.rows),
                    ),
                    h(
                      'span',
                      { style: { ...styles.channelNum, color: 'var(--dsw-alias-label-secondary)' } },
                      cacheableGroup === 0
                        ? '—'
                        : ((group.cacheReadTokens / cacheableGroup) * 100).toFixed(1) + '%',
                    ),
                    h('span', { style: { ...styles.channelNum, fontWeight: 600 } }, compact(group.totalTokens)),
                  );
                }),
              ),
            ),
      );

      // A filter or window that matches nothing is a normal state, not an error.
      const nothing = filtered.length === 0;

      if (log.rows.length === 0) {
        return h(
          'div',
          { style: styles.page, className: 'dsh-tu-scope' },
          h('style', { key: 'dsh-tu-css' }, LOCAL_CSS),
          head,
          summary,
          h(
            'div',
            { style: styles.empty },
            log.hasKey
              ? '已取到请求用量投影，但还没有任何一条 provider 上报了 usage 的请求。'
              : '还没有取到请求日志。该投影由本插件的 Host 半注册；若刚装好，重启一次 dsh 后刷新页面即可。',
          ),
        );
      }

      return h(
        'div',
        { style: styles.page, className: 'dsh-tu-scope' },
        h('style', { key: 'dsh-tu-css' }, LOCAL_CSS),
        head,
        summary,
        toolbar,
        nothing
          ? h('div', { style: styles.empty }, '当前时间范围与筛选条件下没有请求。放宽范围或清空筛选。')
          : view === 'overview'
            ? overview
            : h(
                'div',
                { style: styles.scroller, className: 'dsh-tu-scroll' },
                view === 'requests' ? requestTable : groupTable,
              ),
        h(
          'div',
          { style: styles.footRow },
          h(
            'p',
            { style: styles.foot },
            view === 'overview'
              ? '趋势与命中率按当前窗口分桶（24 小时窗口按小时，其余按天），两者共用同一 x 轴；热力图读全部记录，不受筛选影响；渠道按当前筛选。'
              : view === 'requests'
                ? '点任意一行展开该条的四桶明细（含缓存写与推理子集）。一条 = 一次计费尝试；同一轮内重试会另计一行。耗时 = 步骤开始到落盘，首字 = 首个 token 增量，速度 = 补全 ÷ 生成时间。「—」表示该次没有测到，不是 0。'
                : '按当前筛选聚合，排序为合计降序。平均耗时是组内已计时请求的均值；速度是池化比值：仅计入补全 ≥ 100 且生成 ≥ 100ms 的请求。',
          ),
          storageLine,
        ),
      );
    }

    /**
     * Sidebar entry icon.
     *
     * The panel row supplies the requested square edge, so the entry matches the
     * sizing of the shipped panel icons instead of imposing its own.
     *
     * @param props - Icon presentation from the global panel row.
     * @returns The icon element.
     */
    function TokenUsageIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18;
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 3, y: 12, width: 4, height: 9, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 10, y: 6, width: 4, height: 15, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 17, y: 9, width: 4, height: 12, rx: 1, fill: 'currentColor' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = [
          // A Settings page beside General / Models / Plugins.
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: PANEL_ID, order: 25, label: 'Token 用量' },
              TokenUsagePanel,
            ),
          ),
          // A sidebar panel icon that opens the same page as a main panel.
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: 'Token 用量' },
              TokenUsageIcon,
            ),
          ),
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                // The log's session name is an entry into that conversation.
                inject: () => ({ openSession: sessionOpener(ctx) }),
              },
              TokenUsagePanel,
            ),
          ),
        ];

        // Ask the Session service for projection baselines the list surface never
        // carried a value for. Without this the Host computes `requestLog` and the
        // browser never receives it: the list carries hints only, and a Session's
        // baseline is read once per connection.
        //
        // A Session that already has a baseline is still re-read, because its
        // projection grows as requests settle; that is why the pass repeats
        // instead of remembering what it has already asked for.
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        if (sessions !== undefined && sessions.list !== undefined) {
          // Where the next pass resumes in the never-fetched list. Ordering the whole
          // queue by recency and taking the head starves it: an old Session with no
          // baseline sorts last on every pass, so its rows never reach the panel and
          // the totals are quietly short. The cursor walks that list instead, so every
          // Session is read within ceil(count / budget) passes whatever its age.
          let cursor = 0;
          let recentCursor = 0;
          const pump = () => {
            const snapshot =
              typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined;
            const list = snapshot && Array.isArray(snapshot.ids) ? snapshot.ids : [];
            const byId = snapshot && snapshot.byId ? snapshot.byId : {};
            const carried = snapshot && snapshot.projectionsBySession ? snapshot.projectionsBySession : {};
            const active = Date.now() - ACTIVE_WINDOW_MS;
            const missing = [];
            const recent = [];
            for (const id of list) {
              const values = carried[id] ? carried[id].values : undefined;
              const known = values !== undefined && values.requestLog !== undefined;
              if (!known) {
                // Nothing else will ever fetch this one, whatever its age.
                missing.push(id);
                continue;
              }
              // An idle Session's ledger cannot have grown, so re-reading it only
              // spends a round-trip.
              const updated = byId[id] ? byId[id].updatedAt : 0;
              if ((updated || 0) >= active) recent.push(id);
            }
            recent.sort((left, right) => {
              const a = byId[left] ? byId[left].updatedAt : 0;
              const b = byId[right] ? byId[right].updatedAt : 0;
              return (b || 0) - (a || 0);
            });
            const picked = [];
            if (missing.length > 0) {
              const take = Math.min(REFRESH_PER_PASS, missing.length);
              for (let index = 0; index < take; index += 1) {
                picked.push(missing[(cursor + index) % missing.length]);
              }
              cursor = (cursor + take) % missing.length;
            }
            // The active set rotates for the same reason: always re-reading the
            // newest twelve leaves the rest of a busy list permanently stale.
            const room = REFRESH_PER_PASS - picked.length;
            if (room > 0 && recent.length > 0) {
              const take = Math.min(room, recent.length);
              for (let index = 0; index < take; index += 1) {
                picked.push(recent[(recentCursor + index) % recent.length]);
              }
              recentCursor = (recentCursor + take) % recent.length;
            }
            for (const id of picked) {
              const pending = sessions.refreshProjections(id);
              // A failed read is retried by the next pass; the panel keeps whatever
              // values it already holds in the meantime.
              if (pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {});
            }
          };
          pump();
          if (typeof sessions.list.subscribe === 'function') {
            const unsubscribe = sessions.list.subscribe(pump);
            if (typeof unsubscribe === 'function') disposers.push(unsubscribe);
          }
          const timer = setInterval(pump, REFRESH_INTERVAL_MS);
          disposers.push(() => clearInterval(timer));
        }

        return () => {
          for (const dispose of disposers.splice(0)) dispose();
        };
      },
    };
  },
});
