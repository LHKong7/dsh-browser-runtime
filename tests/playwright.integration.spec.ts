import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { chromium } from 'playwright'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BrowserRuntime, { BrowserSessionId } from 'dsh-browser-runtime'
import { PlaywrightBrowserProvider } from 'dsh-browser-runtime/playwright'

const hasChromium = existsSync(chromium.executablePath())

describe.skipIf(!hasChromium)('Playwright provider against a local deterministic page', () => {
  let server: Server
  let baseUrl: string
  let checkpointRoot: string
  let ctx: Context
  let runtimeFiber: Awaited<ReturnType<Context['plugin']>>
  let unregister: (() => Promise<void>) | undefined

  beforeEach(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
        <html><head><title>Runtime fixture</title></head>
        <body>
          <p id="count"></p>
          <button id="increment">Increment</button>
          <input id="name" placeholder="Name">
          <input id="password" type="password" placeholder="Password">
          <script>
            const count = document.querySelector('#count')
            const render = () => { count.textContent = 'Count: ' + (localStorage.getItem('count') || '0') }
            document.querySelector('#increment').addEventListener('click', () => {
              localStorage.setItem('count', String(Number(localStorage.getItem('count') || '0') + 1))
              render()
            })
            render()
          </script>
        </body></html>`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    checkpointRoot = await mkdtemp(join(tmpdir(), 'browser-checkpoints-'))
    ctx = new Context()
    runtimeFiber = await ctx.plugin(BrowserRuntime, { provider: 'playwright' })
    const provider = new PlaywrightBrowserProvider({
      allowPrivateNetwork: true,
      checkpointRoot,
      actionTimeoutMs: 5_000,
      navigationTimeoutMs: 5_000,
    })
    unregister = ctx.browserRuntime.registerProvider(provider)
  })

  afterEach(async () => {
    if (unregister !== undefined) await unregister()
    if (runtimeFiber !== undefined) await runtimeFiber.dispose()
    if (server !== undefined) await new Promise<void>(resolve => server.close(() => { resolve() }))
    if (checkpointRoot !== undefined) await rm(checkpointRoot, { recursive: true, force: true })
  })

  it('navigates, observes, acts, captures PNG evidence, and restores localStorage', async () => {
    const owner = {}
    const sessionId = BrowserSessionId('playwright-resume')
    const first = await ctx.browserRuntime.acquire({
      owner,
      sessionId,
      persistence: 'resume',
    })
    const opened = await first.act({ type: 'navigate', url: baseUrl })
    expect(opened.after?.title).toBe('Runtime fixture')
    const initial = opened.after!
    const button = initial.elements.find(element => element.name === 'Increment')!
    const password = initial.elements.find(element => element.inputType === 'password')!
    await expect(first.act({
      type: 'fill',
      observationId: initial.id,
      elementRef: password.ref,
      value: 'secret',
    })).rejects.toMatchObject({ code: 'BROWSER_PASSWORD_INPUT_FORBIDDEN' })

    const clicked = await first.act({
      type: 'click',
      observationId: initial.id,
      elementRef: button.ref,
    })
    expect(clicked.after?.text).toContain('Count: 1')
    const screenshot = await first.screenshot({ fullPage: true })
    expect([...screenshot.data.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])

    const stale = clicked.after!
    await first.observe()
    await expect(first.act({
      type: 'click', observationId: stale.id, elementRef: stale.elements[0]!.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_STALE_REFERENCE' })
    await first.release()
    expect(ctx.browserRuntime.checkpointFor(sessionId)?.coverage).toEqual(['cookies', 'local-storage'])

    const resumed = await ctx.browserRuntime.acquire({ owner, sessionId, persistence: 'resume' })
    expect(resumed.generation).toBe(2)
    const reopened = await resumed.act({ type: 'navigate', url: baseUrl })
    expect(reopened.after?.text).toContain('Count: 1')
    await resumed.release()
  })
})
