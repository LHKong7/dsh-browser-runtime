import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'
import {
  formatDiagnostics,
  readPackageIdentity,
  satisfiesNodeRange,
  unwrapExports,
} from '../src/cli/diagnostics.ts'
import { chromiumMissingMessage, readChromiumInstallation } from '../src/provider/chromium.ts'
import type { DiagnosticResult } from '../src/cli/diagnostics.ts'

const loaderUnwrap = Loader.prototype.unwrapExports as (exports: unknown) => unknown

describe('the CLI copy of Loader.unwrapExports', () => {
  it('matches the real Loader on every module shape the bundle can produce', () => {
    const namedOnly = { apply() {}, inject: ['browserRuntime'], name: 'browser-playwright' }
    const withDefault = { ...namedOnly, default: namedOnly.apply }
    const transpiled = { __esModule: true, default: namedOnly.apply, ...namedOnly }
    const shapes: unknown[] = [
      undefined,
      null,
      namedOnly,
      withDefault,
      transpiled,
      { __esModule: true, ...namedOnly },
      { default: { __esModule: true, default: namedOnly.apply } },
    ]
    for (const shape of shapes) {
      expect(unwrapExports(shape)).toBe(loaderUnwrap(shape))
    }
  })
})

describe('engines.node evaluation', () => {
  it('accepts the versions this package declares support for', () => {
    const range = '^22.19.0 || >=24.0.0'
    expect(satisfiesNodeRange('v22.19.0', range)).toBe(true)
    expect(satisfiesNodeRange('v22.22.2', range)).toBe(true)
    expect(satisfiesNodeRange('v24.0.0', range)).toBe(true)
    expect(satisfiesNodeRange('v25.3.1', range)).toBe(true)
  })

  it('rejects versions below the declared bounds and unparsable input', () => {
    const range = '^22.19.0 || >=24.0.0'
    expect(satisfiesNodeRange('v22.18.0', range)).toBe(false)
    expect(satisfiesNodeRange('v23.9.0', range)).toBe(false)
    expect(satisfiesNodeRange('v20.11.0', range)).toBe(false)
    expect(satisfiesNodeRange('not-a-version', range)).toBe(false)
    expect(satisfiesNodeRange('v22.19.0', 'nonsense')).toBe(false)
    expect(satisfiesNodeRange('v18.0.0', '*')).toBe(true)
  })
})

describe('package identity', () => {
  it('reads the installed manifest that owns the diagnostics module', async () => {
    const identity = await readPackageIdentity()
    expect(identity.name).toBe('dsh-browser-runtime')
    expect(identity.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(identity.enginesNode).toBe('^22.19.0 || >=24.0.0')
    expect(identity.bundlePatch).toBe('./cordis.patch.yml')
  })
})

describe('Chromium installation reporting', () => {
  it('resolves the pinned Playwright version and an absolute executable path', () => {
    const installation = readChromiumInstallation()
    expect(installation.playwrightVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(installation.executablePath).toMatch(/chrome|headless_shell/)
    expect(installation.cliPath?.endsWith('cli.js')).toBe(true)
  })

  it('names the version and the remedy when Chromium is absent', () => {
    const message = chromiumMissingMessage({ playwrightVersion: '1.62.1', installed: false })
    expect(message).toBe([
      'Playwright Chromium 1.62.1 is not installed.',
      'Run: dsh-browser-runtime install chromium',
    ].join('\n'))
  })
})

describe('diagnostics formatting', () => {
  it('aligns labels, shows remedies, and summarizes failures', () => {
    const results: DiagnosticResult[] = [
      { id: 'node', label: 'Node.js', status: 'ok', detail: 'v22.19.0' },
      { id: 'chromium', label: 'Chromium', status: 'fail', detail: 'not installed', remedy: 'install it' },
      { id: 'path', label: 'Chromium path', status: 'warn', detail: '(unresolved)' },
    ]
    const text = formatDiagnostics(results)
    expect(text).toContain('[ok  ] Node.js       ')
    expect(text).toContain('[FAIL] Chromium      ')
    expect(text).toContain('[warn] Chromium path')
    expect(text).toContain('→ install it')
    expect(text.trimEnd().endsWith('1 of 3 checks failed.')).toBe(true)
  })

  it('reports a clean run without a failure count', () => {
    const text = formatDiagnostics([{ id: 'node', label: 'Node.js', status: 'ok', detail: 'v22.19.0' }])
    expect(text.trimEnd().endsWith('1 checks passed.')).toBe(true)
  })
})
