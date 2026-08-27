import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli/main.ts'

const built = existsSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)))

function capture(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk))
    return true
  })
  return { out, err }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dsh-browser-runtime CLI', () => {
  it('prints usage for help and for no arguments', async () => {
    const { out } = capture()
    expect(await main([])).toBe(0)
    expect(await main(['help'])).toBe(0)
    expect(await main(['--help'])).toBe(0)
    expect(out.join('')).toContain('install [browser]')
    expect(out.join('')).toContain('doctor')
  })

  it('prints the installed package version', async () => {
    const { out } = capture()
    expect(await main(['--version'])).toBe(0)
    expect(out.join('')).toMatch(/^dsh-browser-runtime \d+\.\d+\.\d+/)
  })

  it('rejects an unknown command with usage on stderr', async () => {
    const { err } = capture()
    expect(await main(['launch'])).toBe(2)
    expect(err.join('')).toContain('unknown command: launch')
  })

  it('refuses a browser the bundled Provider does not support', async () => {
    const { err } = capture()
    expect(await main(['install', 'firefox', 'webkit'])).toBe(2)
    const text = err.join('')
    expect(text).toContain('supports only chromium')
    expect(text).toContain('firefox, webkit')
  })

  it('reports an empty checkpoint store without creating it', async () => {
    const { out } = capture()
    expect(await main(['checkpoints'])).toBe(0)
    expect(out.join('')).toMatch(/No stored browser checkpoints/)
  })

  it.skipIf(!built)('reports every check and exits on the Chromium result', async () => {
    const { out } = capture()
    const code = await main(['doctor'])
    const text = out.join('')
    for (const label of ['Node.js', 'Plugin version', 'Playwright', 'Chromium', 'Bundle patch', 'Provider']) {
      expect(text).toContain(label)
    }
    expect(text).toMatch(/checks (passed|failed)\.$/m)
    expect(code).toBe(text.includes('[FAIL]') ? 1 : 0)
  })
})
