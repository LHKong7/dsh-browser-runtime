import { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import BrowserRuntime, { BrowserProviderId, BrowserSessionId } from 'dsh-browser-runtime'
import type { BrowserProvider } from 'dsh-browser-runtime'
import { PlaywrightBrowserProvider, apply as applyPlaywright } from 'dsh-browser-runtime/playwright'

const CAPABILITIES = {
  checkpoint: false,
  screenshot: false,
  extraction: false,
  multiplePages: false,
  attachExisting: false,
  persistentProfile: false,
  networkEvents: false,
} as const

function unavailableProvider(id: string, unavailableReason?: () => string | undefined): BrowserProvider {
  return {
    id: BrowserProviderId(id),
    capabilities: CAPABILITIES,
    available: () => false,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    open: () => Promise.reject(new Error('not reached')),
  }
}

async function acquireFailure(provider: BrowserProvider, config: object = {}): Promise<Error> {
  const ctx = new Context()
  await ctx.plugin(BrowserRuntime, config)
  ctx.browserRuntime.registerProvider(provider)
  try {
    await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('diagnostics'),
      persistence: 'ephemeral',
    })
    throw new Error('acquire unexpectedly succeeded')
  } catch (error: unknown) {
    return error as Error
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('provider unavailability diagnostics', () => {
  it('quotes the remedy when the configured provider is unavailable', async () => {
    const provider = unavailableProvider('playwright', () => 'Run: dsh-browser-runtime install chromium')
    const error = await acquireFailure(provider, { provider: 'playwright' })
    expect(error).toMatchObject({ code: 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE' })
    expect(error.message).toContain('configured browser provider "playwright" is unavailable')
    expect(error.message).toContain('Run: dsh-browser-runtime install chromium')
  })

  it('quotes each provider remedy when auto-selection finds nothing available', async () => {
    const provider = unavailableProvider('playwright', () => 'Run: dsh-browser-runtime install chromium')
    const error = await acquireFailure(provider)
    expect(error).toMatchObject({ code: 'BROWSER_PROVIDER_UNAVAILABLE' })
    expect(error.message).toContain('no browser provider is available')
    expect(error.message).toContain('playwright: Run: dsh-browser-runtime install chromium')
  })

  it('keeps the bare message when a provider reports no remedy', async () => {
    const error = await acquireFailure(unavailableProvider('bare'), { provider: 'bare' })
    expect(error.message).toBe('configured browser provider "bare" is unavailable')
  })

  it('does not let a throwing diagnostic replace the selection failure', async () => {
    const provider = unavailableProvider('broken', () => { throw new Error('diagnostic exploded') })
    const error = await acquireFailure(provider, { provider: 'broken' })
    expect(error.message).toBe('configured browser provider "broken" is unavailable')
  })
})

describe('Playwright provider startup reporting', () => {
  it('reports the launch facts an operator needs', () => {
    const provider = new PlaywrightBrowserProvider({ headless: false, allowPrivateNetwork: true })
    expect(provider.startupReport({ playwrightVersion: '1.62.1', installed: true })).toEqual([
      'provider=playwright',
      'chromium=available',
      'headless=false',
      'networkPolicy=allow-private',
    ])
    expect(new PlaywrightBrowserProvider({}).startupReport({ playwrightVersion: '1.62.1', installed: false })).toEqual([
      'provider=playwright',
      'chromium=missing',
      'headless=true',
      'networkPolicy=strict',
    ])
  })

  it('names the missing Chromium build through the runtime error path', () => {
    const provider = new PlaywrightBrowserProvider({})
    const reason = provider.unavailableReason()
    if (provider.available()) {
      expect(reason).toBeUndefined()
    } else {
      expect(reason).toContain('is not installed')
      expect(reason).toContain('Run: dsh-browser-runtime install chromium')
    }
  })

  it('logs the startup report and warns once when Chromium is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntime)
    const messages: Message[] = []
    ctx.logger.exporter({ levels: { default: 3 }, export: message => messages.push(message) })

    applyPlaywright(ctx, {})
    const startup = messages.filter(message => message.name === 'browser-runtime')
    const info = startup.filter(message => message.type === 'info').map(message => String(message.args[0]))
    const warn = startup.filter(message => message.type === 'warn').map(message => String(message.args[0]))
    expect(info).toEqual(expect.arrayContaining(['provider=playwright', 'headless=true', 'networkPolicy=strict']))
    const installed = new PlaywrightBrowserProvider({}).available()
    expect(info).toContain(`chromium=${installed ? 'available' : 'missing'}`)
    expect(warn.length).toBe(installed ? 0 : 1)
    if (!installed) expect(warn[0]).toContain('Run: dsh-browser-runtime install chromium')
    await ctx.fiber.dispose()
  })
})
