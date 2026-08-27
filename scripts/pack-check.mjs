#!/usr/bin/env node
/**
 * Pack the release candidate and run the conformance gate over the tarball.
 *
 * A source-tree check cannot see a missing `files` entry, a stale `lib/`, or a
 * default export the build reintroduced. This packs the package, extracts the
 * archive under the repository so Node still resolves the workspace's
 * dependencies, and verifies the extracted contents.
 *
 * Usage: node scripts/pack-check.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const workDir = join(repoRoot, '.pack-check')

rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })

const packOutput = execFileSync('pnpm', ['pack', '--pack-destination', workDir], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
})
const tarball = packOutput.trim().split('\n').at(-1)
if (tarball === undefined || !tarball.endsWith('.tgz')) {
  throw new Error(`pnpm pack did not report a tarball path: ${packOutput}`)
}

execFileSync('tar', ['-xzf', tarball, '-C', workDir], { cwd: repoRoot, stdio: 'inherit' })

const extracted = join(workDir, 'package')
console.log(`tarball:    ${tarball}`)
console.log(`files:      ${countFiles(extracted)}`)

execFileSync(process.execPath, [join(repoRoot, 'scripts', 'verify-package.mjs'), extracted], {
  cwd: repoRoot,
  stdio: 'inherit',
})

// `doctor` reads the same artifact a profile would run it against. Chromium may
// legitimately be absent on a build machine, so only its own checks may fail.
console.log('')
const doctor = spawnSync(process.execPath, [join(extracted, 'lib', 'cli', 'index.js'), 'doctor'], {
  cwd: extracted,
  encoding: 'utf8',
})
process.stdout.write(doctor.stdout ?? '')
process.stderr.write(doctor.stderr ?? '')
const unexpected = (doctor.stdout ?? '')
  .split('\n')
  .filter(line => line.startsWith('[FAIL]') && !/Chromium|Provider playwright/.test(line))
if (unexpected.length > 0) {
  console.error(`tarball doctor reported unrelated failures:\n${unexpected.join('\n')}`)
  process.exitCode = 1
}

function countFiles(directory) {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(join(directory, entry.name)) : 1
  }
  return total
}
