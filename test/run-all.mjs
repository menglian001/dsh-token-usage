/**
 * Run every offline harness and report one line each.
 *
 * These exercise the plugin's own contracts — the projection fold, the ledger's
 * write/reload/compaction/idempotence, the pump's coverage, and the panel's
 * render tree — without needing a running dsh.
 */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = (await readdir(here))
  .filter((name) => name.endsWith('.mjs') && name !== 'run-all.mjs')
  .sort()

let failed = 0
for (const name of files) {
  const output = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, name)], { cwd: join(here, '..') })
    let text = ''
    child.stdout.on('data', (chunk) => { text += chunk })
    child.stderr.on('data', (chunk) => { text += chunk })
    child.on('close', (code) => resolve({ code, text }))
  })
  const tail = output.text.trim().split('\n').filter((line) => line !== '').pop() ?? ''
  const ok = output.code === 0
  if (!ok) failed += 1
  console.log((ok ? '  ok   ' : '  FAIL ') + name.replace(/\.mjs$/, '').padEnd(22) + tail.slice(0, 90))
}

console.log(failed === 0 ? '\nall ' + files.length + ' harnesses passed' : '\n' + failed + ' of ' + files.length + ' failed')
process.exit(failed === 0 ? 0 : 1)
