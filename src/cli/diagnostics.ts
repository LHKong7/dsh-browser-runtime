/** Installation and environment checks shared by the CLI and its tests. */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromiumMissingMessage, readChromiumInstallation } from '../provider/chromium.ts'
import type { ChromiumInstallation } from '../provider/chromium.ts'

/** One doctor check and its outcome. */
export interface DiagnosticResult {
  /** Stable check identity used by scripts and issue reports. */
  readonly id: string
  /** Human-readable check label. */
  readonly label: string
  /** `ok` passes, `warn` is usable but degraded, `fail` blocks the Provider. */
  readonly status: 'ok' | 'warn' | 'fail'
  /** Observed value or failure summary. */
  readonly detail: string
  /** Command or edit that resolves a non-`ok` status. */
  readonly remedy?: string
}

/** Package identity and paths a diagnostic run resolves once. */
export interface PackageIdentity {
  readonly root: string
  readonly name: string
  readonly version: string
  readonly enginesNode: string
  readonly bundlePatch?: string
}

/** Entry points the DSH bundle patch mounts. */
export const ENTRY_POINTS = [
  { subpath: '.', pluginName: 'browser-runtime', shape: 'service' },
  { subpath: './playwright', pluginName: 'browser-playwright', shape: 'functional' },
  { subpath: './tools', pluginName: 'tool-browser', shape: 'functional' },
] as const

/**
 * Reproduce `Loader.unwrapExports` without depending on the loader package.
 * `tests/loader-conformance.spec.ts` pins this against the real implementation.
 * @param exports - imported module namespace or plugin value.
 * @returns the value the DSH Loader would hand to `ctx.plugin`.
 */
export function unwrapExports(exports: unknown): unknown {
  if (exports === null || exports === undefined) return exports
  const unwrapped = (exports as { default?: unknown }).default ?? exports
  if (!(unwrapped as { __esModule?: unknown }).__esModule) return unwrapped
  return (unwrapped as { default?: unknown }).default ?? unwrapped
}

/**
 * Locate the installed package root that owns this module.
 * @param from - module URL inside the package, defaulting to this file.
 * @returns manifest-derived identity for the installed bundle.
 */
export async function readPackageIdentity(from: string = import.meta.url): Promise<PackageIdentity> {
  const root = resolve(dirname(fileURLToPath(from)), '..', '..')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    name?: string
    version?: string
    engines?: { node?: string }
    dsh?: { bundle?: { patch?: string } }
  }
  const bundlePatch = manifest.dsh?.bundle?.patch
  return {
    root,
    name: manifest.name ?? 'dsh-browser-runtime',
    version: manifest.version ?? '0.0.0',
    enginesNode: manifest.engines?.node ?? '*',
    ...(bundlePatch === undefined ? {} : { bundlePatch }),
  }
}

/**
 * Evaluate the `^x.y.z` and `>=x.y.z` clauses this package declares.
 * @param version - running Node version such as `v22.19.0`.
 * @param range - `||`-joined range from `engines.node`.
 * @returns whether the running Node satisfies the declared range.
 */
export function satisfiesNodeRange(version: string, range: string): boolean {
  const running = parseVersion(version)
  if (running === undefined) return false
  if (range.trim() === '*') return true
  return range.split('||').some((clause) => {
    const text = clause.trim()
    const caret = text.startsWith('^')
    const atLeast = text.startsWith('>=')
    const bound = parseVersion(text.replace(/^\^|^>=/, ''))
    if (bound === undefined) return false
    if (caret) return running[0] === bound[0] && compare(running, bound) >= 0
    if (atLeast) return compare(running, bound) >= 0
    return compare(running, bound) === 0
  })
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] as number) - (right[index] as number)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Run every installation check for one package root.
 * @param identity - the installed bundle being diagnosed.
 * @param playwright - resolved Playwright installation facts.
 * @returns one result per check, in report order.
 */
export async function runDiagnostics(
  identity: PackageIdentity,
  playwright: ChromiumInstallation = readChromiumInstallation(),
): Promise<readonly DiagnosticResult[]> {
  const results: DiagnosticResult[] = []

  const nodeOk = satisfiesNodeRange(process.version, identity.enginesNode)
  results.push({
    id: 'node',
    label: 'Node.js',
    status: nodeOk ? 'ok' : 'fail',
    detail: `${process.version} (requires ${identity.enginesNode})`,
    ...(nodeOk ? {} : { remedy: `Install Node.js ${identity.enginesNode}` }),
  })

  results.push({
    id: 'plugin',
    label: 'Plugin version',
    status: 'ok',
    detail: `${identity.name}@${identity.version}`,
  })

  const playwrightResolved = playwright.playwrightVersion !== '(unresolved)'
  results.push({
    id: 'playwright',
    label: 'Playwright',
    status: playwrightResolved ? 'ok' : 'fail',
    detail: playwright.playwrightVersion,
    ...(playwrightResolved
      ? {}
      : { remedy: 'Reinstall the plugin so its bundled playwright dependency resolves' }),
  })

  results.push({
    id: 'chromium',
    label: 'Chromium',
    status: playwright.installed ? 'ok' : 'fail',
    detail: playwright.installed
      ? 'available'
      : `not installed${playwright.error === undefined ? '' : ` (${playwright.error})`}`,
    ...(playwright.installed ? {} : { remedy: 'dsh-browser-runtime install chromium' }),
  })

  results.push({
    id: 'chromium-path',
    label: 'Chromium path',
    status: playwright.executablePath === undefined ? 'warn' : 'ok',
    detail: playwright.executablePath ?? '(unresolved)',
  })

  for (const entry of ENTRY_POINTS) {
    results.push(await checkEntryPoint(identity, entry))
  }

  const patch = identity.bundlePatch
  const patchPath = patch === undefined ? undefined : resolve(identity.root, patch)
  results.push({
    id: 'bundle',
    label: 'Bundle patch',
    status: patchPath !== undefined && existsSync(patchPath) ? 'ok' : 'fail',
    detail: patchPath === undefined ? 'package.json declares no dsh.bundle.patch' : patchPath,
    ...(patchPath !== undefined && existsSync(patchPath)
      ? {}
      : { remedy: 'Reinstall the plugin; the profile would otherwise mount no rows' }),
  })

  results.push(await checkProvider(identity, playwright))
  return results
}

async function checkEntryPoint(
  identity: PackageIdentity,
  entry: (typeof ENTRY_POINTS)[number],
): Promise<DiagnosticResult> {
  const id = `entry:${entry.pluginName}`
  const label = `Entry ${identity.name}${entry.subpath === '.' ? '' : entry.subpath.slice(1)}`
  let plugin: unknown
  try {
    plugin = unwrapExports(await importEntry(identity, entry.subpath))
  } catch (error: unknown) {
    return { id, label, status: 'fail', detail: `import failed: ${String(error)}` }
  }
  if (entry.shape === 'service') {
    const ok = typeof plugin === 'function' && typeof (plugin as { Config?: unknown }).Config === 'function'
    return {
      id,
      label,
      status: ok ? 'ok' : 'fail',
      detail: ok ? 'Service class with static Config' : 'unwrapped value is not a Service class carrying Config',
      ...(ok ? {} : { remedy: 'Reinstall a build whose Service entry keeps its static Config' }),
    }
  }
  const shape = plugin as { apply?: unknown; inject?: unknown; name?: unknown; Config?: unknown } | null
  const missing = [
    typeof shape?.apply === 'function' ? undefined : 'apply',
    Array.isArray(shape?.inject) ? undefined : 'inject',
    typeof shape?.name === 'string' ? undefined : 'name',
    typeof shape?.Config === 'function' ? undefined : 'Config',
  ].filter((field): field is string => field !== undefined)
  return {
    id,
    label,
    status: missing.length === 0 ? 'ok' : 'fail',
    detail: missing.length === 0
      ? `named plugin "${String(shape?.name)}" with inject [${(shape?.inject as string[]).join(', ')}]`
      : `Loader.unwrapExports dropped: ${missing.join(', ')}`,
    ...(missing.length === 0
      ? {}
      : { remedy: 'Reinstall a build whose functional plugin entries have no default export' }),
  }
}

async function checkProvider(
  identity: PackageIdentity,
  playwright: ChromiumInstallation,
): Promise<DiagnosticResult> {
  try {
    const namespace = await importEntry(identity, './playwright') as {
      PlaywrightBrowserProvider: new (config?: object) => { available(): boolean | Promise<boolean> }
    }
    const available = await new namespace.PlaywrightBrowserProvider({}).available()
    return {
      id: 'provider',
      label: 'Provider playwright',
      status: available ? 'ok' : 'fail',
      detail: available ? 'available' : 'unavailable',
      ...(available ? {} : { remedy: chromiumMissingMessage(playwright).split('\n')[1] as string }),
    }
  } catch (error: unknown) {
    return {
      id: 'provider',
      label: 'Provider playwright',
      status: 'fail',
      detail: `construction failed: ${String(error)}`,
    }
  }
}

async function importEntry(identity: PackageIdentity, subpath: string): Promise<unknown> {
  const manifest = JSON.parse(await readFile(join(identity.root, 'package.json'), 'utf8')) as {
    exports?: Record<string, { default?: string } | string>
  }
  const entry = manifest.exports?.[subpath]
  const target = typeof entry === 'string' ? entry : entry?.default
  if (target === undefined) throw new Error(`package.json exports has no default target for "${subpath}"`)
  return import(pathToFileURL(resolve(identity.root, target)).href)
}

/** Format one diagnostics run as aligned terminal output. */
export function formatDiagnostics(results: readonly DiagnosticResult[]): string {
  const width = Math.max(...results.map(result => result.label.length))
  const symbol = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const
  const lines = results.flatMap((result) => {
    const head = `[${symbol[result.status]}] ${result.label.padEnd(width)}  ${result.detail}`
    return result.remedy === undefined ? [head] : [head, `${' '.repeat(width + 9)}→ ${result.remedy}`]
  })
  const failed = results.filter(result => result.status === 'fail').length
  lines.push('')
  lines.push(failed === 0
    ? `${results.length} checks passed.`
    : `${failed} of ${results.length} checks failed.`)
  return lines.join('\n')
}
