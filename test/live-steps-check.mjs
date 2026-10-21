
/**
 * The step gauge: a Session's running flag can only say one, so the Host counts
 * open steps instead — that is the number a request log means by concurrency.
 */
import { LiveSteps } from '../index.js'

let pass = 0
const fails = []
const check = (name, ok, detail) => { if (ok) pass += 1; else fails.push(name + (detail === undefined ? '' : ' -- ' + JSON.stringify(detail))) }

const step = (turn, index) => ({ type: 'step/start', time: 1, data: { turn, step: index } })
const settle = (turn, index) => ({ type: 'assistant/message', time: 2, data: { turn, step: index, usage: { inputTokens: 1 } } })
const endTurn = (turn) => ({ type: 'turn/end', time: 3, data: { turn } })

const gauge = new LiveSteps()
check('an idle gauge reads zero', JSON.stringify(gauge.snapshot().steps) === '0', gauge.snapshot())

gauge.observe('a', step(1, 0))
check('one open step', gauge.snapshot().steps === 1 && gauge.snapshot().sessions === 1, gauge.snapshot())

// Two calls in flight inside ONE conversation: the case a running flag cannot show.
gauge.observe('a', step(1, 1))
check('two steps in one Session', gauge.snapshot().steps === 2 && gauge.snapshot().sessions === 1, gauge.snapshot())

gauge.observe('b', step(1, 0))
check('a second Session adds one step and one session', gauge.snapshot().steps === 3 && gauge.snapshot().sessions === 2, gauge.snapshot())

gauge.observe('a', settle(1, 0))
check('a settlement closes its own step only', gauge.snapshot().steps === 2 && gauge.snapshot().sessions === 2, gauge.snapshot())

gauge.observe('a', settle(1, 1))
check('closing both leaves the other Session open', gauge.snapshot().steps === 1 && gauge.snapshot().sessions === 1, gauge.snapshot())

gauge.observe('b', endTurn(1))
check('a turn end clears what it left open', gauge.snapshot().steps === 0 && gauge.snapshot().sessions === 0, gauge.snapshot())

// A step that never settles must not leak past its turn.
gauge.observe('c', step(7, 3))
gauge.observe('c', endTurn(7))
check('an unsettled step does not leak', gauge.snapshot().steps === 0, gauge.snapshot())

// Unrelated events must not disturb the count.
gauge.observe('d', step(1, 0))
gauge.observe('d', { type: 'assistant/attempt', time: 4, data: { turn: 1, step: 0 } })
check('an attempt sample also closes the step', gauge.snapshot().steps === 0, gauge.snapshot())

console.log(pass + ' passed, ' + fails.length + ' failed')
for (const failure of fails) console.log('  FAIL ' + failure)
process.exit(fails.length > 0 ? 1 : 0)
