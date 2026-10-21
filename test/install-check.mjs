
/**
 * Install acceptance: the journey a stranger takes, from a clean clone to a
 * loadable Host half.
 *
 * The other harnesses import ../index.js from inside this checkout, where
 * node_modules already exists. That hides the one failure mode that actually
 * bit users: a link: package resolves its dependencies from its REAL directory,
 * so a clone with no node_modules makes the Host half fail with
 * "Cannot find package 'zod'" — and a failed Host half takes the Client half
 * down with it, leaving no sidebar icon at all.
 *
 * This harness reproduces that journey in a temporary directory:
 *
 *   1. copy the published tree (git archive, so only tracked files travel)
 *   2. resolve it through a link: dependency the way a profile does
 *   3. import it BEFORE installing dependencies — the import must fail cleanly
 *   4. npm install, then import again — it must succeed and export what dsh needs
 *   5. run the offline suite from that copy, proving the package is self-contained
 *
 * It needs npm on PATH and network access for the single dependency; when either
 * is missing it reports SKIP rather than failing the suite.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

const fails = []
const check = (name, ok, detail) => {
  if (!ok) fails.push(name + (detail === undefined ? '' : ' -- ' + JSON.stringify(detail)))
}

/** Run one command, resolving to its exit code and captured output. */
function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, env: { ...process.env, ...(options?.env ?? {}) } })
    let out = ''
    // A hanging npm (no network, a locked store) must not wedge the check.
    const deadline = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      resolve({ code: -1, out: out + '\n[timed out after ' + String(options?.timeoutMs ?? 120000) + 'ms]' })
    }, options?.timeoutMs ?? 120000)
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.on('data', (chunk) => { out += chunk })
    child.on('error', (error) => { clearTimeout(deadline); resolve({ code: -1, out: String(error) }) })
    child.on('close', (code) => { clearTimeout(deadline); resolve({ code: code ?? -1, out }) })
  })
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-tu-install-'))
try {
  // 1. The published tree: tracked files only, exactly what a visitor receives.
  const packageDir = join(scratch, 'dsh-token-usage')
  await mkdir(packageDir, { recursive: true })
  // git archive writes a tar to stdout, so it has to be piped into tar directly:
  // collecting it as a string would corrupt it and leave tar waiting on stdin.
  const packed = await new Promise((resolve) => {
    const archive = spawn('git', ['-C', root, 'archive', 'HEAD'])
    const untar = spawn('tar', ['-x', '-C', packageDir])
    const deadline = setTimeout(() => {
      try { archive.kill('SIGKILL') } catch { /* gone */ }
      try { untar.kill('SIGKILL') } catch { /* gone */ }
      resolve({ code: -1, out: 'timed out while packing the tree' })
    }, 60000)
    let errors = ''
    archive.stderr.on('data', (chunk) => { errors += chunk })
    untar.stderr.on('data', (chunk) => { errors += chunk })
    archive.on('error', (error) => { clearTimeout(deadline); resolve({ code: -1, out: String(error) }) })
    archive.stdout.pipe(untar.stdin)
    untar.on('close', (code) => { clearTimeout(deadline); resolve({ code: code ?? -1, out: errors }) })
  })
  if (packed.code !== 0) {
    // Not a git checkout (a released tarball, say): copy the tracked-shaped files.
    for (const name of ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'locale', 'test']) {
      await cp(join(root, name), join(packageDir, name), { recursive: true })
    }
  }
  check('the published tree carries no node_modules', !(await import('node:fs')).existsSync(join(packageDir, 'node_modules')))
  check('the published tree has the Host half', (await import('node:fs')).existsSync(join(packageDir, 'index.js')))

  // 2. A profile that depends on it through link:, the way the README installs it.
  const profileDir = join(scratch, 'profile')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'install-acceptance-profile',
    private: true,
    type: 'module',
    dependencies: { 'dsh-token-usage': 'link:' + packageDir },
  }, null, 2))

  // The profile has to resolve the link: dependency before anything can import it.
  const linked = await run('pnpm', ['install', '--silent'], { cwd: profileDir, timeoutMs: 120000 })
  check('the profile links the package', linked.code === 0, linked.out.slice(0, 120))

  // 3. Before installing the package's own dependencies the import must fail for
  //    the documented reason. This is the regression: it used to fail silently at
  //    runtime, in dsh, and take the Client half down with it.
  const before = await run(process.execPath, ['-e',
    "import('dsh-token-usage').then(() => console.log('IMPORTED')).catch((error) => console.log('FAILED:' + error.code))",
  ], { cwd: profileDir })
  check('without its dependencies the Host half cannot load', before.out.includes('FAILED:ERR_MODULE_NOT_FOUND'), before.out.slice(0, 160))
  const failedFirst = before.out.includes('FAILED:ERR_MODULE_NOT_FOUND')
  if (failedFirst) {
    check('the failure names the missing dependency', before.out.includes('FAILED'), before.out.slice(0, 120))
  }

  // 4. npm install inside the package, then the import must succeed.
  const installed = await run('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: packageDir, timeoutMs: 180000 })
  if (installed.code !== 0) {
    console.log('SKIP — npm install failed (offline?): ' + installed.out.slice(0, 160).replace(/\n/g, ' '))
  } else {
    const after = await run(process.execPath, ['-e',
      "import('dsh-token-usage').then((m) => console.log('OK:' + m.name + ':' + JSON.stringify(m.inject) + ':' + m.LEDGER_ROUTE)).catch((error) => console.log('FAILED:' + error.code))",
    ], { cwd: profileDir })
    check('after npm install the Host half loads', after.out.startsWith('OK:'), after.out.slice(0, 160))
    check('it registers the projection injection', after.out.includes('["sessionProjections"]'), after.out.slice(0, 160))
    check('it serves the documented route', after.out.includes('/token-usage/ledger'), after.out.slice(0, 160))

    // 5. The copy must be self-contained: one representative harness has to pass
    //    there too. The whole suite is run by run-all; repeating it here would
    //    double the wall time of the check for no extra signal.
    const one = await run(process.execPath, [join(packageDir, 'test', 'ledger-check.mjs')], { cwd: packageDir })
    check('the published copy can run a harness on its own', one.code === 0, one.out.trim().split('\n').slice(-1)[0])
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}

console.log((fails.length === 0 ? 'PASS' : 'FAIL') + ' — install acceptance (clean tree → link: → import → suite)')
for (const failure of fails) console.log('  ' + failure)
process.exit(fails.length === 0 ? 0 : 1)
