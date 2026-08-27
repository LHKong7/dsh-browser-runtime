/** Facts about the Chromium build the pinned Playwright version manages. */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)

/** Installation state of the managed Chromium build. */
export interface ChromiumInstallation {
  /** Version of the Playwright package this bundle pins. */
  readonly playwrightVersion: string
  /** Absolute path Playwright expects the Chromium executable at. */
  readonly executablePath?: string
  /** Whether that executable exists in this process's environment. */
  readonly installed: boolean
  /** Absolute path of the bundled Playwright CLI, when it ships with the install. */
  readonly cliPath?: string
  /** Resolution failure that prevented the check. */
  readonly error?: string
}

/**
 * Resolve the pinned Playwright version and its managed Chromium executable.
 * @returns installation facts; never throws, so diagnostics can report them.
 */
export function readChromiumInstallation(): ChromiumInstallation {
  let manifestPath: string
  try {
    manifestPath = require.resolve('playwright/package.json')
  } catch (error: unknown) {
    return { playwrightVersion: '(unresolved)', installed: false, error: String(error) }
  }
  const manifest = require(manifestPath) as { version?: string }
  const playwrightVersion = manifest.version ?? '(unknown)'
  const cliPath = join(dirname(manifestPath), 'cli.js')
  const cli = existsSync(cliPath) ? { cliPath } : {}
  try {
    const executablePath = chromium.executablePath()
    return { playwrightVersion, executablePath, installed: existsSync(executablePath), ...cli }
  } catch (error: unknown) {
    return { playwrightVersion, installed: false, ...cli, error: String(error) }
  }
}

/**
 * Operator-facing explanation and remedy for a missing Chromium build.
 * @param installation - the checked installation state.
 * @returns a two-line message naming the version and the install command.
 */
export function chromiumMissingMessage(installation: ChromiumInstallation): string {
  const detail = installation.error === undefined ? '' : ` (${installation.error})`
  return [
    `Playwright Chromium ${installation.playwrightVersion} is not installed${detail}.`,
    'Run: dsh-browser-runtime install chromium',
  ].join('\n')
}

/** Default provider-private directory holding Playwright checkpoint payloads. */
export function defaultCheckpointRoot(dshHome: string): string {
  return join(dshHome, 'browser-runtime', 'providers', 'playwright', 'v1', 'checkpoints')
}
