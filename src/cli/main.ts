/** `dsh-browser-runtime` command implementations, free of process side effects. */

import { spawn } from 'node:child_process'
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defaultCheckpointRoot } from '../provider/chromium.ts'
import { chromiumMissingMessage, readChromiumInstallation } from '../provider/chromium.ts'
import { formatDiagnostics, readPackageIdentity, runDiagnostics } from './diagnostics.ts'

/** Browsers the bundled Provider supports. */
const SUPPORTED_BROWSERS = ['chromium'] as const

const USAGE = `dsh-browser-runtime <command> [options]

Commands:
  install [browser]   Install the browser build managed by the pinned Playwright
                      version. Only "chromium" is supported; it is the default.
                      Pass --with-deps to also install Linux system packages.
  doctor              Report Node, plugin, Playwright, Chromium, entry-point,
                      bundle, and Provider state. Exits non-zero on a failure.
  checkpoints         List the Playwright Provider's stored browser state.
                      Pass --clear to delete every payload; a Runtime index
                      entry left pointing at a deleted payload opens a fresh
                      environment instead of failing.
  help                Show this message.
`

/**
 * Run one CLI invocation.
 * @param argv - arguments after the executable and script.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [command = 'help', ...rest] = argv
  switch (command) {
    case 'install': return install(rest)
    case 'doctor': return doctor()
    case 'checkpoints': return checkpoints(rest)
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return 0
    case 'version':
    case '--version':
    case '-v': {
      const identity = await readPackageIdentity()
      process.stdout.write(`${identity.name} ${identity.version}\n`)
      return 0
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
      return 2
  }
}

async function install(args: readonly string[]): Promise<number> {
  const withDeps = args.includes('--with-deps')
  const browsers = args.filter(argument => !argument.startsWith('--'))
  const requested = browsers.length === 0 ? ['chromium'] : browsers
  const unsupported = requested.filter(browser => !SUPPORTED_BROWSERS.includes(browser as 'chromium'))
  if (unsupported.length > 0) {
    process.stderr.write(
      `dsh-browser-runtime supports only ${SUPPORTED_BROWSERS.join(', ')}; refusing: ${unsupported.join(', ')}\n`,
    )
    return 2
  }

  const playwright = readChromiumInstallation()
  if (playwright.cliPath === undefined) {
    process.stderr.write(
      'the bundled playwright dependency could not be resolved; reinstall dsh-browser-runtime\n',
    )
    return 1
  }
  process.stdout.write(`Installing Playwright ${playwright.playwrightVersion} chromium…\n`)
  const code = await run(process.execPath, [
    playwright.cliPath,
    'install',
    ...(withDeps ? ['--with-deps'] : []),
    ...requested,
  ])
  if (code !== 0) return code

  const installed = readChromiumInstallation()
  if (!installed.installed) {
    process.stderr.write(`${chromiumMissingMessage(installed)}\n`)
    return 1
  }
  process.stdout.write(`Chromium is installed at ${installed.executablePath}\n`)
  return 0
}

async function doctor(): Promise<number> {
  const identity = await readPackageIdentity()
  const results = await runDiagnostics(identity, readChromiumInstallation())
  process.stdout.write(`${formatDiagnostics(results)}\n`)
  return results.some(result => result.status === 'fail') ? 1 : 0
}

/**
 * List or clear the Provider-private checkpoint payloads.
 *
 * The Runtime's index lives in DSH storage and is not reachable from here, so
 * clearing deletes payloads only; the Runtime drops an index entry whose
 * payload is gone and opens a fresh environment for that session.
 */
async function checkpoints(args: readonly string[]): Promise<number> {
  const root = defaultCheckpointRoot(resolveDshHome())
  let entries: string[]
  try {
    entries = (await readdir(root)).filter(entry => entry.endsWith('.json')).sort()
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
    process.stdout.write(`No stored browser checkpoints (${root} does not exist).\n`)
    return 0
  }
  if (entries.length === 0) {
    process.stdout.write(`No stored browser checkpoints in ${root}.\n`)
    return 0
  }
  if (!args.includes('--clear')) {
    process.stdout.write(`${root}\n`)
    for (const entry of entries) {
      const info = await stat(join(root, entry))
      process.stdout.write(`  ${entry}  ${info.size} bytes  ${info.mtime.toISOString()}\n`)
    }
    process.stdout.write(`${entries.length} checkpoint payloads. Delete them with --clear.\n`)
    return 0
  }
  let cleared = 0
  for (const entry of entries) {
    try {
      await unlink(join(root, entry))
      cleared += 1
    } catch (error: unknown) {
      if (!isMissing(error)) throw error
    }
  }
  process.stdout.write(`Deleted ${cleared} checkpoint payloads from ${root}.\n`)
  return 0
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', code => resolve(code ?? 1))
  })
}
