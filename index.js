/**
 * Host half of dsh-token-usage: the per-request usage ledger.
 *
 * Two duties, one measurement:
 *
 * 1. **Fold** — the `requestLog` Session projection, one row per billed attempt,
 *    read from the Session's own durable log. This is what the panel's request
 *    table shows.
 * 2. **Persist** — every folded row is also appended to an append-only JSONL
 *    file under `$DSH_HOME/token-usage/`. The projection is bounded
 *    (`MAX_REQUESTS` per Session, state that a version bump discards) and a
 *    Session can be deleted outright; the file is neither. Rows are keyed by
 *    (session, turn, step, attempt) and the file is read back last-wins, so a
 *    further usage sample for the same attempt supersedes rather than doubles,
 *    and a crash between two samples loses nothing that was already written.
 *
 * The file is served back to the browser by a Host route
 * (`GET /token-usage/ledger`) so the panel can report totals, a trend and a
 * heat map over the whole recorded history instead of the retained window.
 * The route authenticates with the same browser cookie the GUI itself uses.
 *
 * Row semantics, shared by both duties:
 *
 * - `assistant/attempt` and `assistant/message` each carry a provider usage
 *   sample; a sample for the Turn/Step already at the tail REPLACES that row,
 *   because a stream reports several cumulative samples for one attempt.
 * - `llm/retry-started` closes that replacement slot, so an attempt retried
 *   inside the same Turn/Step appends its own row rather than overwriting the
 *   attempt that failed.
 * - Provider and model come from the Assistant message's source.
 *
 * Timing, with the same definitions the Harness uses for its own `sessionStats`
 * (`first token` is the first non-empty token delta; a tool-call run counts from
 * its name):
 *
 * - `latencyMs`   — `step/start` to the settlement that reported the sample.
 * - `firstTokenMs`— `step/start` to the first token delta. Absent when the
 *   attempt streamed no token (cc-switch stores NULL for `first_token_ms` too).
 * - `generationMs`— first token to settlement: the denominator of output speed,
 *   matching cc-switch's `latency_ms - first_token_ms`.
 * - `streamed`    — whether the attempt carried token deltas at all.
 *
 * @module dsh-token-usage
 */

import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'

/** Cordis plugin name. */
export const name = 'token-usage'

/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['sessionProjections']

/**
 * Newest request rows retained in the projection state per Session.
 *
 * A storage bound, not a deployment setting: the state is checkpointed with every
 * other projection unit, so it stays bounded in the projection cache. Rows older
 * than this are dropped from the oldest end — the durable ledger is what keeps
 * them.
 */
export const MAX_REQUESTS = 600

/**
 * Newest request rows carried to the browser through the projection.
 *
 * Matches the retained bound instead of a smaller window: the panel's totals,
 * heat map, and per-channel split are sums over every row it receives, so a
 * shorter wire window silently understates them. Only a Session with that many
 * settled requests reaches the bound, so the payload grows where the history
 * actually exists rather than for every Session.
 */
export const WIRE_REQUESTS = 600

/** Exact route the durable ledger is read from. */
export const LEDGER_ROUTE = '/token-usage/ledger'

/** File name of the append-only ledger inside the data directory. */
export const LEDGER_FILE = 'requests.jsonl'

/** Directory under the Harness home holding this plugin's data. */
export const LEDGER_DIR_NAME = 'token-usage'

/** Records older than this are dropped when the ledger is compacted. */
export const LEDGER_KEEP_DAYS = 730

/** A ledger at most this large is compacted at startup; a larger one is only read. */
export const LEDGER_COMPACT_MAX_BYTES = 32 * 1024 * 1024

/** Lines needed before a startup compaction is worth a rewrite. */
export const LEDGER_COMPACT_MIN_LINES = 2000

/**
 * Ceiling on the remembered key set, so the idempotence of a re-read is bounded
 * in memory rather than unbounded in time. Past this the ledger stops deduping
 * by key and falls back to superseding only a Session's newest row.
 */
export const KEY_LIMIT = 400000

/** How long after start the disk sweep begins, ms: late enough to leave boot alone. */
export const SWEEP_START_MS = 12000

/** Weekly buckets: a day key is local time, the same reading the panel draws. */
const DAY_MS = 86400000

/** One provider-reported bucket, as a non-negative integer. */
const bucket = z.number().int().nonnegative()

/** One non-negative millisecond figure. */
const ms = z.number().nonnegative()

/** One billed request attempt. */
const requestSchema = z
  .object({
    /** Turn that opened the attempt. */
    turn: z.number().int().nonnegative(),
    /** Step inside that Turn. */
    step: z.number().int().nonnegative(),
    /** Commit time of the durable event that reported the sample. */
    time: z.number().int().nonnegative(),
    /** Provider that served the attempt, absent on a sample without a message. */
    provider: z.string().optional(),
    /** Model that served the attempt, absent on a sample without a message. */
    model: z.string().optional(),
    /** Prompt input billed at the full input rate. */
    uncachedInputTokens: bucket,
    /** Generated output. */
    outputTokens: bucket,
    /** Prompt served from the provider's prompt cache. */
    cacheReadTokens: bucket,
    /** Prompt written into that cache. */
    cacheWriteTokens: bucket,
    /** Output subset the provider attributed to reasoning, zero when unreported. */
    reasoningTokens: bucket,
    /** `step/start` to settlement, ms; absent when the step boundary was not observed. */
    latencyMs: ms.optional(),
    /** `step/start` to the first token delta, ms; absent when the attempt streamed no token. */
    firstTokenMs: ms.optional(),
    /** First token to settlement, ms: the output-speed denominator. */
    generationMs: ms.optional(),
    /** Whether the attempt carried token deltas at all. */
    streamed: z.boolean(),
  })
  .strict()

/** One durable ledger line: a request row plus the identity it supersedes by. */
const ledgerSchema = requestSchema
  .extend({
    /** `session|turn|step|attempt` — the last line for a key is the live one. */
    key: z.string().min(1),
    /** Session the attempt belongs to. */
    session: z.string().min(1),
    /** How the row was observed: live, reconciled from the fold, or read back from the log. */
    via: z.enum(['live', 'fold', 'sweep']).optional(),
  })

/** The unit's state: the retained rows, the open step boundary, and the tail's replacement marker. */
const stateSchema = z
  .object({
    /** Retained rows, oldest first. */
    requests: z.array(requestSchema),
    /** The step boundary timings are measured from; null outside a step. */
    step: z
      .object({
        turn: z.number().int().nonnegative(),
        step: z.number().int().nonnegative(),
        startTime: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    /**
     * Turn/Step whose trailing row a further sample may still replace, or null
     * when no slot is open. `llm/retry-started` clears it for that coordinate.
     */
    open: z
      .object({ turn: z.number().int().nonnegative(), step: z.number().int().nonnegative() })
      .strict()
      .nullable(),
  })
  .strict()

/** Keep a finite, JSON-safe count. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * Whether one stream chunk carries a token delta.
 *
 * Mirrors the Harness's `isTokenDelta`: only a non-empty delta counts, and a
 * tool-call delta counts when it carries arguments or the call's name.
 *
 * @param chunk - Any stream chunk.
 * @returns Whether the chunk is a token delta.
 */
function isTokenDelta(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== ''
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta !== '' || chunk.name !== undefined
  return false
}

/**
 * Reconstructed time of the first member of one packed delta run that `accept` takes.
 *
 * Member `i` sits at `time0` plus every delta before it, which is how the packed
 * run keeps one timestamp per settlement instead of one per chunk.
 *
 * @param run - One packed delta run.
 * @param accept - Whether a member qualifies.
 * @returns The member's time, or undefined when none qualifies.
 */
function firstRunMemberTime(run, accept) {
  const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts
  if (!Array.isArray(fragments) || !Array.isArray(run.dt)) return undefined
  let time = run.time0
  for (let index = 0; index < fragments.length; index += 1) {
    if (index > 0) time += run.dt[index - 1]
    if (accept(fragments[index])) return time
  }
  return undefined
}

/**
 * First token time of one packed delta run: a name-bearing tool-call run starts at
 * its first member, otherwise the first non-empty fragment.
 *
 * @param run - One packed delta run.
 * @returns The run's first token time, or undefined.
 */
function runFirstTokenTime(run) {
  if (run.type !== 'tool-call-chunks' && run.type !== 'text-chunks' && run.type !== 'reasoning-chunks') {
    return undefined
  }
  if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0
  return firstRunMemberTime(run, (fragment) => fragment !== '')
}

/**
 * First token time in a durable assistant stream, read from the records themselves.
 *
 * @param stream - The event's assistant stream records.
 * @returns The first token's time, or undefined when the stream carries no token.
 */
function streamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const time = record.type === 'chunk'
      ? (isTokenDelta(record.chunk) ? record.time : undefined)
      : runFirstTokenTime(record)
    if (time !== undefined) return time
  }
  return undefined
}

/**
 * Whether a durable assistant stream carried token deltas at all.
 *
 * @param stream - The event's assistant stream records.
 * @returns Whether the attempt streamed.
 */
function streamHadDeltas(stream) {
  if (!Array.isArray(stream)) return false
  return stream.some((record) => {
    if (record === null || typeof record !== 'object') return false
    if (record.type === 'chunk') return isTokenDelta(record.chunk)
    return record.type === 'text-chunks' || record.type === 'reasoning-chunks' || record.type === 'tool-call-chunks'
  })
}

/**
 * The last usage sample embedded in a durable assistant stream.
 *
 * The stream is the packed record list the event carries, so a usage chunk is
 * found by scanning for a `chunk` record wrapping a `usage` chunk; later records
 * win because a stream reports cumulative samples.
 *
 * @param stream - The event's assistant stream records.
 * @returns The newest sample, or undefined when the stream reported none.
 */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record !== null && typeof record === 'object' && record.type === 'chunk') {
      const chunk = record.chunk
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') return chunk.usage
    }
  }
  return undefined
}

/**
 * The usage sample one durable assistant event reports for its attempt.
 *
 * @param data - The event's payload.
 * @returns The sample, or undefined when the attempt reported none.
 */
function usageOf(data) {
  if (data === null || typeof data !== 'object') return undefined
  if (data.usage !== undefined && data.usage !== null) return data.usage
  return streamUsage(data.stream)
}

/**
 * The provider/model that served an attempt, taken from its Assistant message.
 *
 * @param data - The event's payload.
 * @returns The route fields, empty for a sample with no Assistant message.
 */
function routeOf(data) {
  const message = data !== null && typeof data === 'object' ? data.message : undefined
  const source = message !== null && typeof message === 'object' ? message.source : undefined
  if (source === null || typeof source !== 'object') return {}
  if (typeof source.provider !== 'string' || typeof source.model !== 'string') return {}
  return { provider: source.provider, model: source.model }
}

/**
 * One row from a durable assistant event, its usage sample, and the open step.
 *
 * `latencyMs`, `firstTokenMs` and `generationMs` are omitted rather than zeroed
 * when the boundary they need was not observed, so a consumer can tell "not
 * measured" from "instant" — the same distinction cc-switch draws by storing
 * NULL for `first_token_ms`.
 *
 * @param event - The committed event carrying the sample.
 * @param usage - The provider's sample.
 * @param step - The open step boundary, when it matches this event.
 * @returns The row.
 */
function rowOf(event, usage, step) {
  const row = {
    turn: event.data.turn,
    step: event.data.step,
    time: event.time,
    ...routeOf(event.data),
    uncachedInputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cacheReadTokens: count(usage.cacheReadTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens),
    reasoningTokens: count(usage.reasoningTokens),
    streamed: streamHadDeltas(event.data.stream),
  }
  if (step !== null && step !== undefined && step.turn === event.data.turn && step.step === event.data.step) {
    const latency = event.time - step.startTime
    if (Number.isFinite(latency) && latency >= 0) row.latencyMs = latency
    const firstToken = streamFirstTokenTime(event.data.stream)
    if (firstToken !== undefined) {
      const ttft = firstToken - step.startTime
      const generation = event.time - firstToken
      if (Number.isFinite(ttft) && ttft >= 0) row.firstTokenMs = ttft
      if (Number.isFinite(generation) && generation >= 0) row.generationMs = generation
    }
  }
  return row
}

/**
 * The per-request usage unit.
 *
 * `apply` is pure and returns the same reference for every event it ignores, so
 * an unchanged fold costs nothing downstream.
 */
export const requestLogProjectionDefinition = {
  key: 'requestLog',
  // v2 added the step boundary and the timing fields, so a v1 checkpoint is discarded.
  stateVersion: 2,
  stateSchema,
  init: () => ({ requests: [], step: null, open: null }),
  apply: (state, event) => {
    if (event.type === 'step/start') {
      return { ...state, step: { turn: event.data.turn, step: event.data.step, startTime: event.time } }
    }
    if (event.type === 'llm/retry-started') {
      // Close the replacement slot: the retried attempt becomes its own row.
      const { turn, step } = event.data
      if (state.open === null || state.open.turn !== turn || state.open.step !== step) return state
      return { ...state, open: null }
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
    const usage = usageOf(event.data)
    if (usage === undefined) return state

    const { turn, step } = event.data
    const row = rowOf(event, usage, state.step)
    const tail = state.requests.length === 0 ? undefined : state.requests[state.requests.length - 1]
    const replaceable =
      state.open !== null && state.open.turn === turn && state.open.step === step && tail !== undefined

    const requests = replaceable
      ? [...state.requests.slice(0, -1), mergeRows(tail, row)]
      : [...state.requests, row]
    const bounded = requests.length > MAX_REQUESTS ? requests.slice(requests.length - MAX_REQUESTS) : requests
    return { ...state, requests: bounded, open: { turn, step } }
  },
  wire: {
    viewSchema: z.array(requestSchema),
    view: (state) => state.requests.slice(-WIRE_REQUESTS),
  },
}

/**
 * Fold a settlement onto the attempt row it replaces.
 *
 * The settlement wins for usage, because its sample is the final cumulative one,
 * but a fact only the earlier event established is carried over rather than lost:
 * an `assistant/attempt` carries the stream that holds the timing, while an
 * `assistant/message` carries the route.
 *
 * @param tail - The trailing row, which described the same Turn/Step.
 * @param row - The settlement's own row.
 * @returns The merged row.
 */
function mergeRows(tail, row) {
  return {
    ...row,
    ...(row.provider === undefined && tail.provider !== undefined
      ? { provider: tail.provider, ...(tail.model === undefined ? {} : { model: tail.model }) }
      : {}),
    ...(row.latencyMs === undefined && tail.latencyMs !== undefined ? { latencyMs: tail.latencyMs } : {}),
    ...(row.firstTokenMs === undefined && tail.firstTokenMs !== undefined ? { firstTokenMs: tail.firstTokenMs } : {}),
    ...(row.generationMs === undefined && tail.generationMs !== undefined ? { generationMs: tail.generationMs } : {}),
    streamed: row.streamed || tail.streamed,
  }
}

/** The Harness home: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome() {
  const fromEnv = typeof process !== 'undefined' ? process.env.DSH_HOME : undefined
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** Local `YYYY-MM-DD`, the same day key the panel buckets by. */
export function dayKey(time) {
  const date = new Date(time)
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A fresh aggregate bucket. */
function zeroAgg() {
  return {
    requests: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    latencyMs: 0,
    firstTokenMs: 0,
    generationMs: 0,
    timedRequests: 0,
    speedTokens: 0,
    speedGenerationMs: 0,
  }
}

/**
 * Apply one record to an aggregate.
 *
 * @param agg - Aggregate to change in place.
 * @param row - The record.
 * @param sign - 1 to add, -1 to retract a superseded record.
 */
function addAgg(agg, row, sign) {
  agg.requests += sign
  agg.uncachedInputTokens += sign * row.uncachedInputTokens
  agg.outputTokens += sign * row.outputTokens
  agg.cacheReadTokens += sign * row.cacheReadTokens
  agg.cacheWriteTokens += sign * row.cacheWriteTokens
  agg.reasoningTokens += sign * row.reasoningTokens
  if (row.latencyMs !== undefined) agg.latencyMs += sign * row.latencyMs
  if (row.firstTokenMs !== undefined) {
    agg.firstTokenMs += sign * row.firstTokenMs
    agg.timedRequests += sign
  }
  if (row.generationMs !== undefined) agg.generationMs += sign * row.generationMs
  if (
    row.firstTokenMs !== undefined &&
    row.outputTokens >= SPEED_MIN_OUTPUT_TOKENS &&
    row.generationMs !== undefined &&
    row.generationMs >= SPEED_MIN_GENERATION_MS
  ) {
    agg.speedTokens += sign * row.outputTokens
    agg.speedGenerationMs += sign * row.generationMs
  }
}

/** Output tokens below this never enter the pooled speed ratio (cc-switch's threshold). */
export const SPEED_MIN_OUTPUT_TOKENS = 100

/** Generation time below this never enters the pooled speed ratio (cc-switch's threshold). */
export const SPEED_MIN_GENERATION_MS = 100

/**
 * One aggregate as the wire shape: absolute counts plus the derived readings the
 * panel shows, so a consumer never re-derives them differently.
 *
 * @param agg - The aggregate.
 * @returns Wire-ready numbers.
 */
function aggOut(agg) {
  const promptTokens = agg.uncachedInputTokens + agg.cacheReadTokens + agg.cacheWriteTokens
  return {
    requests: agg.requests,
    uncachedInputTokens: agg.uncachedInputTokens,
    outputTokens: agg.outputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheWriteTokens: agg.cacheWriteTokens,
    reasoningTokens: agg.reasoningTokens,
    promptTokens,
    completionTokens: agg.outputTokens,
    totalTokens: promptTokens + agg.outputTokens,
    cacheHitRate: promptTokens > 0 ? agg.cacheReadTokens / promptTokens : undefined,
    avgLatencyMs: agg.requests > 0 ? agg.latencyMs / agg.requests : undefined,
    /** How many attempts carried a first-token measurement: the pooled speed's sample size. */
    timedRequests: agg.timedRequests,
    avgFirstTokenMs: agg.timedRequests > 0 ? agg.firstTokenMs / agg.timedRequests : undefined,
    avgGenerationMs: agg.timedRequests > 0 ? agg.generationMs / agg.timedRequests : undefined,
    speed: agg.speedGenerationMs > 0 ? agg.speedTokens / (agg.speedGenerationMs / 1000) : undefined,
  }
}

/**
 * The durable ledger: an append-only JSONL file, its in-memory aggregates, and
 * the read path the panel uses.
 *
 * Writes are serialized through one promise chain so lines never interleave, and
 * every failure is contained: a ledger that cannot be written degrades the
 * panel's history, never the fold or the Session.
 */
export class Ledger {
  /**
   * @param options - Logger and clock.
   */
  constructor(options) {
    /** Optional Cordis logger; failures are reported, never thrown. */
    this.logger = options.logger
    /** Directory holding the ledger file. */
    this.dir = options.dir
    /** Absolute path of the ledger file. */
    this.file = join(options.dir, LEDGER_FILE)
    /** Serializes appends. */
    this.chain = Promise.resolve()
    /** Whether the data directory has been created this run. */
    this.ready = false
    /** Records appended this run. */
    this.appended = 0
    /** Append failures this run. */
    this.failures = 0
    /** Bytes of appended text this run. */
    this.appendedBytes = 0
    /** Lines read at startup. */
    this.lines = 0
    /** Distinct keys read at startup (equal to `lines` when the file was too large to dedupe). */
    this.unique = 0
    /** Whether the startup read deduplicated by key. */
    this.deduped = true
    /** True when the file was too large to withhold in memory for compaction. */
    this.oversized = false
    /** When the ledger was last read from disk. */
    this.loadedAt = undefined

    /** Every recorded attempt, keyed the way the file supersedes. */
    this.totals = zeroAgg()
    /** Local day to aggregate. */
    this.days = new Map()
    /** Provider to aggregate. */
    this.channels = new Map()
    /** `provider/model` to aggregate. */
    this.models = new Map()
    /** Session id to aggregate. */
    this.sessions = new Map()
    /** Newest record per Session, the only row a further sample can replace. */
    this.tail = new Map()
    /** Newest record time per Session, the watermark a fold reconciliation resumes from. */
    this.watermark = new Map()
    /** Newest records, oldest first, for a bounded recent view. */
    this.recent = []
    /**
     * Every key the file already holds, so a re-read of the same history — the
     * startup sweep, a resumed Session, a retried attempt — supersedes its row
     * instead of adding a second one. Bounded by KEY_LIMIT.
     */
    this.keys = new Set()
    /** The live step gauge, when the Host is running one. */
    this.live = undefined

    /** What the history sweep last did: when, how many Sessions, how many rows. */
    this.sweep = { at: undefined, sessions: 0, rows: 0, error: undefined }
    /** Oldest recorded time. */
    this.firstTime = undefined
    /** Newest recorded time. */
    this.lastTime = undefined
  }

  /** Bucket an aggregate for one key of one map. */
  bucketOf(map, key) {
    const found = map.get(key)
    if (found !== undefined) return found
    const created = zeroAgg()
    map.set(key, created)
    return created
  }

  /**
   * Record one attempt: retract the row it supersedes, add this one, and persist it.
   *
   * @param key - `session|turn|step|attempt`.
   * @param session - Session id.
   * @param row - The folded row.
   * @param via - How the row was observed.
   * @param persist - Whether to append to disk (a fold reconciliation of an
   *   already-recorded row still updates nothing and writes nothing).
   * @returns The record as written.
   */
  record(key, session, row, via, persist) {
    const record = { key, session, ...row, via }
    const tail = this.tail.get(session)
    if (this.keys.has(key)) {
      // Already recorded. Only a strictly newer sample for that same attempt may
      // replace it: an equal timestamp is this same event read again (a re-sweep),
      // and an older one is a late arrival racing the live feed. Both are dropped,
      // which is what keeps the totals monotone in time and a re-read free.
      if (tail === undefined || tail.key !== key || record.time <= tail.time) return undefined
      this.aggregatesFor(tail, -1)
    } else if (this.keys.size < KEY_LIMIT) {
      this.keys.add(key)
    }
    this.apply(record)
    this.tail.set(session, record)
    const watermark = this.watermark.get(session) ?? 0
    if (record.time > watermark) this.watermark.set(session, record.time)
    if (this.firstTime === undefined || record.time < this.firstTime) this.firstTime = record.time
    if (this.lastTime === undefined || record.time > this.lastTime) this.lastTime = record.time
    if (persist !== false) this.append(record)
    return record
  }

  /** Add or retract one record across every aggregate, returning the totals bucket. */
  aggregatesFor(record, sign) {
    addAgg(this.totals, record, sign)
    addAgg(this.bucketOf(this.days, dayKey(record.time)), record, sign)
    addAgg(this.bucketOf(this.channels, record.provider ?? ''), record, sign)
    addAgg(
      this.bucketOf(this.models, record.provider === undefined ? '' : `${record.provider}/${record.model ?? ''}`),
      record,
      sign,
    )
    addAgg(this.bucketOf(this.sessions, record.session), record, sign)
    return this.totals
  }

  /** Add one record to every aggregate and to the recent window. */
  apply(record) {
    this.aggregatesFor(record, 1)
    this.recent.push(record)
    if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT)
  }

  /** Queue one line for the file, serialized and fail-soft. */
  append(record) {
    let line
    try {
      line = `${JSON.stringify(record)}\n`
    } catch (error) {
      this.failures += 1
      this.warn(`ledger record was not serializable: ${String(error)}`)
      return
    }
    this.chain = this.chain.then(async () => {
      try {
        if (!this.ready) {
          await mkdir(this.dir, { recursive: true })
          this.ready = true
        }
        await appendFile(this.file, line, 'utf8')
        this.appended += 1
        this.appendedBytes += Buffer.byteLength(line)
      } catch (error) {
        this.failures += 1
        this.warn(`append failed (the ledger keeps the rows already written): ${String(error)}`)
      }
    })
  }

  /** Report a contained failure. */
  warn(message) {
    const logger = this.logger
    if (logger === undefined) return
    if (typeof logger.warn === 'function') logger.warn(`token-usage: ${message}`)
    else if (typeof logger.error === 'function') logger.error(`token-usage: ${message}`)
  }

  /** Wait for queued appends to settle; used by the route so a read sees what was just recorded. */
  async flush() {
    await this.chain
    return this.chain
  }

  /**
   * Read the ledger back and rebuild every aggregate.
   *
   * Last line wins per key, which is what makes a crash between two samples of
   * one attempt harmless: the earlier line is still a complete record, and the
   * later one supersedes it.
   *
   * @returns How many lines and keys were read.
   */
  async load() {
    let size
    try {
      const info = await stat(this.file)
      size = info.size
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { lines: 0, unique: 0 }
      this.warn(`ledger could not be inspected: ${String(error)}`)
      return { lines: 0, unique: 0 }
    }
    if (size === 0) return { lines: 0, unique: 0 }

    // A file small enough to hold is loaded through a key map, so duplicates can
    // be collapsed and the file rewritten; a larger one is aggregated line by
    // line and left alone, because the memory a full map would need is unbounded.
    const compactable = size <= LEDGER_COMPACT_MAX_BYTES
    const byKey = compactable ? new Map() : undefined
    let lines = 0
    let invalid = 0
    const stream = createReadStream(this.file, { encoding: 'utf8' })
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const raw of reader) {
        const text = raw.trim()
        if (text === '') continue
        lines += 1
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          invalid += 1
          continue
        }
        const checked = ledgerSchema.safeParse(parsed)
        if (!checked.success) {
          invalid += 1
          continue
        }
        if (this.keys.size < KEY_LIMIT) this.keys.add(checked.data.key)
        if (byKey !== undefined) byKey.set(checked.data.key, checked.data)
        else {
          this.deduped = false
          this.apply(checked.data)
        }
      }
    } catch (error) {
      this.warn(`ledger read stopped early: ${String(error)}`)
    }

    if (byKey !== undefined) {
      for (const record of byKey.values()) this.apply(record)
      this.unique = byKey.size
      // Rebuild the tail/watermark from the collapsed set: whatever is newest per
      // Session is the only row a further sample can still replace.
      for (const record of byKey.values()) {
        const tail = this.tail.get(record.session)
        if (tail === undefined || record.time >= tail.time) this.tail.set(record.session, record)
        const watermark = this.watermark.get(record.session) ?? 0
        if (record.time > watermark) this.watermark.set(record.session, record.time)
        if (this.firstTime === undefined || record.time < this.firstTime) this.firstTime = record.time
        if (this.lastTime === undefined || record.time > this.lastTime) this.lastTime = record.time
      }
      this.recent.sort((left, right) => left.time - right.time)
      if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT)
    }

    if (byKey === undefined) {
      this.unique = lines
      this.recent.sort((left, right) => left.time - right.time)
      if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT)
    }
    this.lines = lines
    this.invalid = invalid
    this.oversized = !compactable
    this.loadedAt = Date.now()
    if (invalid > 0) this.warn(`${String(invalid)} unreadable ledger line(s) were skipped`)
    if (byKey !== undefined && this.shouldCompact(lines, byKey.size)) await this.compact(byKey)
    return { lines, unique: this.unique }
  }

  /**
   * Whether the file deserves a rewrite: enough superseded lines to matter, or
   * records past the retention window.
   *
   * @param lines - Lines read.
   * @param unique - Distinct keys read.
   * @returns Whether to compact.
   */
  shouldCompact(lines, unique) {
    if (lines < LEDGER_COMPACT_MIN_LINES) return this.hasExpired()
    return lines > unique * 1.25 || this.hasExpired()
  }

  /** Whether any loaded record is older than the retention window. */
  hasExpired() {
    if (this.firstTime === undefined) return false
    return Date.now() - this.firstTime > LEDGER_KEEP_DAYS * DAY_MS
  }

  /**
   * Rewrite the file with one line per key, dropping expired records.
   *
   * Written to a sibling then renamed, so an interrupted compaction leaves the
   * previous file intact rather than a truncated one.
   *
   * @param byKey - The collapsed records.
   */
  async compact(byKey) {
    const cutoff = Date.now() - LEDGER_KEEP_DAYS * DAY_MS
    const kept = [...byKey.values()]
      .filter((record) => record.time >= cutoff)
      .sort((left, right) => left.time - right.time)
    const temporary = `${this.file}.compacting`
    const body = kept.map((record) => `${JSON.stringify(record)}\n`).join('')
    try {
      await writeFile(temporary, body, 'utf8')
      await rename(temporary, this.file)
      this.warn(`ledger compacted: ${String(byKey.size)} rows kept of ${String(this.lines)} lines`)
    } catch (error) {
      this.warn(`compaction skipped: ${String(error)}`)
    }
  }

  /**
   * Reconcile the retained projection rows into the ledger.
   *
   * A Session restored from disk does not republish its historical events, so the
   * live listener alone would never learn rows recorded before this process
   * started. Reading the fold back closes that gap, and the per-Session watermark
   * keeps the reconciliation idempotent.
   *
   * @param sessions - Live sessions.
   * @param stateOf - Reads one Session's folded `requestLog` state.
   * @returns How many rows were newly recorded.
   */
  reconcile(sessions, stateOf) {
    let recorded = 0
    for (const session of sessions) {
      const id = typeof session.id === 'string' ? session.id : String(session.id)
      let state
      try {
        state = stateOf(session)
      } catch (error) {
        this.warn(`fold read for "${id}" failed: ${String(error)}`)
        continue
      }
      const rows = state !== undefined && Array.isArray(state.requests) ? state.requests : undefined
      if (rows === undefined) continue
      const watermark = this.watermark.get(id) ?? 0
      // Attempts are numbered per Turn/Step in fold order, which is the ordinal
      // the live path assigns too: the first attempt is 0 and a retry is 1, so a
      // reconciled retry cannot overwrite the attempt that failed.
      const ordinals = new Map()
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue
        if (count(row.time) <= watermark) continue
        const checked = requestSchema.safeParse(row)
        if (!checked.success) continue
        const group = `${String(checked.data.turn)}|${String(checked.data.step)}`
        const ordinal = ordinals.get(group) ?? 0
        ordinals.set(group, ordinal + 1)
        this.record(`${id}|${group}|${String(ordinal)}`, id, checked.data, 'fold')
        recorded += 1
      }
    }
    return recorded
  }

  /** The wire shape: aggregates plus the newest rows, bounded for the wire. */
  snapshot(rowLimit) {
    const limit = Number.isFinite(rowLimit) && rowLimit > 0 ? Math.min(Math.floor(rowLimit), RECENT_LIMIT) : 0
    const rows = limit === 0 ? [] : this.recent.slice(-limit)
    const days = [...this.days.entries()]
      .sort((left, right) => (left[0] < right[0] ? -1 : 1))
      .slice(-DAY_LIMIT)
      .map(([day, agg]) => ({ day, ...aggOut(agg) }))
    const models = [...this.models.entries()]
      .map(([model, agg]) => ({ provider: model.split('/')[0] ?? '', model: model.split('/').slice(1).join('/'), ...aggOut(agg) }))
      .sort((left, right) => right.totalTokens - left.totalTokens)
      .slice(0, GROUP_LIMIT)
    const channels = [...this.channels.entries()]
      .map(([provider, agg]) => ({ provider, ...aggOut(agg) }))
      .sort((left, right) => right.totalTokens - left.totalTokens)
      .slice(0, GROUP_LIMIT)
    const sessions = [...this.sessions.entries()]
      .map(([session, agg]) => ({ session, ...aggOut(agg) }))
      .sort((left, right) => right.totalTokens - left.totalTokens)
      .slice(0, GROUP_LIMIT)
    return {
      version: 1,
      file: this.file,
      dir: this.dir,
      lines: this.lines,
      rows: this.unique,
      deduped: this.deduped,
      sweep: this.sweep,
      live: this.live === undefined ? undefined : this.live.snapshot(),
      appended: this.appended,
      failures: this.failures,
      bytes: this.appendedBytes,
      loadedAt: this.loadedAt,
      firstTime: this.firstTime,
      lastTime: this.lastTime,
      totals: aggOut(this.totals),
      days,
      models,
      channels,
      sessions,
      recent: rows,
      limits: { days: DAY_LIMIT, groups: GROUP_LIMIT, recent: RECENT_LIMIT, keepDays: LEDGER_KEEP_DAYS },
    }
  }
}

/** Local day buckets the wire carries; older days stay on disk and in the totals. */
const DAY_LIMIT = 400

/** Group rows per dimension the wire carries. */
const GROUP_LIMIT = 200

/** Newest records held in memory for the recent view. */
const RECENT_LIMIT = 2000

/**
 * How many steps are open right now, per Session.
 *
 * A Session's own running flag is a boolean, so a client watching it can only ever
 * say "one" for a conversation. A step opens on step/start and closes on the
 * settlement that reports its usage, so counting open steps per Session measures
 * what a request log measures: calls in flight, not conversations busy. A turn's
 * end clears whatever it left open, because a step that never settled must not be
 * counted forever.
 */
export class LiveSteps {
  constructor() {
    /** Session id to the set of its open turn|step coordinates. */
    this.open = new Map()
  }

  /**
   * Fold one committed event.
   *
   * @param id - Session id.
   * @param event - The committed event.
   */
  observe(id, event) {
    if (event.type === 'step/start') {
      const key = String(event.data.turn) + '|' + String(event.data.step)
      const set = this.open.get(id)
      if (set === undefined) this.open.set(id, new Set([key]))
      else set.add(key)
      return
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const set = this.open.get(id)
      if (set === undefined) return
      set.delete(String(event.data.turn) + '|' + String(event.data.step))
      return
    }
    if (event.type === 'turn/end') this.open.delete(id)
  }

  /** The current gauge. */
  snapshot() {
    let steps = 0
    let sessions = 0
    for (const set of this.open.values()) {
      if (set.size === 0) continue
      sessions += 1
      steps += set.size
    }
    return { steps, sessions, at: Date.now() }
  }
}

/**
 * The per-attempt accounting shared by the live listener and the disk sweep.
 *
 * One rule, two feeds: a sample for the Turn/Step already open supersedes the row
 * it produced, and `llm/retry-started` closes that slot so the retried attempt
 * becomes its own row. Keeping it in one place is what stops a swept row and a
 * live row for the same attempt from being counted as two.
 *
 * @returns An object whose `push` takes one event and returns the row to record,
 *   or undefined when the event carries no sample.
 */
export function makeFolder() {
  let step = null
  let attempt = 0
  const open = new Map()
  return {
    push(event, session, sessionId) {
      if (event.type === 'step/start') {
        step = { turn: event.data.turn, step: event.data.step, startTime: event.time }
        attempt = 0
        open.clear()
        return undefined
      }
      if (event.type === 'llm/retry-started') {
        if (step !== null && step.turn === event.data.turn && step.step === event.data.step) {
          attempt += 1
        }
        return undefined
      }
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
      const usage = usageOf(event.data)
      if (usage === undefined) return undefined
      const row = rowOf(event, usage, step)
      const key = `${sessionId}|${String(row.turn)}|${String(row.step)}|${String(attempt)}`
      const previous = open.get(key)
      const merged = previous === undefined ? row : mergeRows(previous, row)
      open.set(key, merged)
      return { key, row: merged }
    },
  }
}

/**
 * Read every stored Session's log back into the ledger.
 *
 * The live listener only sees events that arrive while this process runs, and the
 * projection only keeps each Session's newest `MAX_REQUESTS` rows, so history is
 * reachable two ways it never is otherwise:
 *
 * - a Session the client's list does not hold still has a log on disk, and its
 *   usage is part of the total;
 * - rows older than the projection's bound were dropped from the fold long ago.
 *
 * Reads are deduped by key, so a Session already fully recorded costs a read and
 * writes nothing.
 *
 * @param ledger - The ledger to fill.
 * @param persistence - Session persistence service.
 * @returns How many Sessions were read and how many rows were newly recorded.
 */
export async function sweepHistory(ledger, persistence) {
  if (persistence === undefined || typeof persistence.list !== 'function') {
    // Reported, not swallowed: a sweep that never ran is exactly the silent gap
    // this exists to close, so the ledger records why it did nothing.
    ledger.sweep = {
      at: Date.now(),
      sessions: 0,
      rows: 0,
      error: persistence === undefined ? 'sessionPersistence 服务不可用' : 'sessionPersistence 没有 list()',
    }
    return { sessions: 0, rows: 0 }
  }
  let snapshots
  try {
    snapshots = await persistence.list()
  } catch (error) {
    ledger.warn(`history sweep could not list Sessions: ${String(error)}`)
    ledger.sweep = { at: Date.now(), sessions: 0, rows: 0, error: `list() 失败：${String(error)}` }
    return { sessions: 0, rows: 0 }
  }
  let sessions = 0
  let rows = 0
  for (const snapshot of snapshots) {
    const id = snapshot === null || typeof snapshot !== 'object'
      ? undefined
      : (typeof snapshot.id === 'string' ? snapshot.id : undefined)
    if (id === undefined) continue
    let handle
    try {
      handle = await persistence.open(id, 'read')
      const slice = await handle.read()
      const folder = makeFolder()
      for (const event of slice.events) {
        const hit = folder.push(event, undefined, id)
        if (hit === undefined) continue
        if (ledger.record(hit.key, id, hit.row, 'sweep') !== undefined) rows += 1
      }
      sessions += 1
    } catch (error) {
      // A Session that cannot be read is skipped; the next sweep retries it.
      ledger.warn(`history sweep skipped "${id}": ${String(error)}`)
    } finally {
      if (handle !== undefined && typeof handle.close === 'function') {
        await Promise.resolve(handle.close()).catch(() => undefined)
      }
    }
  }
  ledger.sweep = {
    at: Date.now(),
    sessions,
    rows,
    error: sessions === 0 ? `list() 返回 ${String(snapshots.length)} 个会话，一个都没读成` : undefined,
  }
  return { sessions, rows }
}

/**
 * Register the `requestLog` unit and start the durable ledger.
 *
 * @param ctx - Registrant context carrying the projection registry.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(requestLogProjectionDefinition)

  const ledger = new Ledger({ logger: ctx.logger, dir: join(dshHome(), LEDGER_DIR_NAME) })
  ledger.load().catch((error) => ledger.warn(`startup load failed: ${String(error)}`))

  // Live rows. `session/event` fires per committed event, so the row lands in the
  // same turn that billed it rather than waiting for a checkpoint.
  ctx.effect(() => {
    const gauge = new LiveSteps()
    ledger.live = gauge
    const folders = new Map()
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        const id = typeof session.id === 'string' ? session.id : String(session.id)
        gauge.observe(id, event)
        const folder = folders.get(id) ?? makeFolder()
        folders.set(id, folder)
        const hit = folder.push(event, session, id)
        if (hit !== undefined) ledger.record(hit.key, id, hit.row, 'live')
      } catch (error) {
        // One malformed event must never take down the event bus or the fold.
        ledger.warn(`live record failed: ${String(error)}`)
      }
    })
    return () => {
      folders.clear()
      if (typeof dispose === 'function') dispose()
    }
  }, 'token-usage: ledger writer')

  // History the live feed never saw: Sessions that predate this process and rows
  // the projection dropped. Once per start is enough — after that the live
  // listener owns everything new — and it runs off the boot path on purpose.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      // Looked up here rather than injected: an injection that never fires would
      // skip the sweep without a trace, which is the failure this guards against.
      const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
      void sweepHistory(ledger, persistence)
        .then((result) => {
          ledger.warn(`history sweep: ${String(result.sessions)} Sessions read, ${String(result.rows)} rows recorded`)
        })
        .catch((error) => ledger.warn(`history sweep failed: ${String(error)}`))
    }, SWEEP_START_MS)
    return () => clearTimeout(timer)
  }, 'token-usage: history sweep')

  // Fold reconciliation for restores and for rows predating this process, plus a
  // periodic pass so a Session loaded later is picked up without a restart.
  ctx.effect(() => {
    const reconcile = () => {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      if (sessions === undefined || typeof sessions.list !== 'function') return
      try {
        ledger.reconcile(sessions.list(), (session) => ctx.sessionProjections.stateOf(session, 'requestLog'))
      } catch (error) {
        ledger.warn(`reconciliation pass failed: ${String(error)}`)
      }
    }
    const timer = setInterval(reconcile, RECONCILE_INTERVAL_MS)
    const delayed = setTimeout(reconcile, RECONCILE_START_MS)
    return () => {
      clearInterval(timer)
      clearTimeout(delayed)
    }
  }, 'token-usage: ledger reconciliation')

  // Read path. Registered only when the composition has a web server; the fiber
  // itself never depends on one, because a pending fiber would also drop the
  // Client half and the panel would vanish from the GUI.
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LEDGER_ROUTE,
      handler: (req, res) => {
        void serveLedger(webCtx.connection, ledger, req, res)
      },
    }), 'token-usage: ledger route')
  })
}

/** How often a Session is reconciled with the retained fold, ms. */
export const RECONCILE_INTERVAL_MS = 60000

/** Delay before the first reconciliation, ms: late enough for the list to have loaded. */
export const RECONCILE_START_MS = 5000

/**
 * Answer one ledger read.
 *
 * Authenticated with the same browser cookie the GUI uses: the route returns
 * usage history, so it is not left open to anything else that can reach the
 * loopback listener. A composition without the Connection service fails closed
 * rather than serving the data unauthenticated.
 *
 * @param connection - Connection handle owning browser authentication.
 * @param ledger - The ledger to render.
 * @param req - Incoming request.
 * @param res - Response to own.
 */
export async function serveLedger(connection, ledger, req, res) {
  if (connection === undefined || typeof connection.authorizeIndex !== 'function') {
    res.writeHead(404, { 'cache-control': 'no-store' })
    res.end('not found')
    return
  }
  if (!connection.authorizeIndex(req, res)) return

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'cache-control': 'no-store', allow: 'GET, HEAD' })
    res.end()
    return
  }

  const url = new URL(req.url ?? LEDGER_ROUTE, 'http://dsh.invalid')
  const requested = Number(url.searchParams.get('rows'))
  // A read after a write must see that write, so queued appends are settled
  // first; a failed append is already contained inside the chain.
  await ledger.flush()
  const body = JSON.stringify(ledger.snapshot(requested))
  res.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}
