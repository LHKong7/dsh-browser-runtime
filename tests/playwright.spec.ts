import { describe, expect, it } from 'vitest'
import { PlaywrightBrowserProvider } from 'dsh-browser-runtime/playwright'

describe('Playwright provider configuration', () => {
  it('rejects non-positive screenshot budgets at load time', () => {
    expect(() => new PlaywrightBrowserProvider({ maxScreenshotPixels: 0 }))
      .toThrow('browser-playwright: maxScreenshotPixels must be a positive integer')
    expect(() => new PlaywrightBrowserProvider({ maxScreenshotBytes: 0 }))
      .toThrow('browser-playwright: maxScreenshotBytes must be a positive integer')
  })
})
