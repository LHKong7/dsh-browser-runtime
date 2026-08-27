import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { chromium } from 'playwright'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BrowserRuntime, { BrowserEnvironmentId, BrowserSessionId } from 'dsh-browser-runtime'
import { PlaywrightBrowserProvider } from 'dsh-browser-runtime/playwright'
import { NetworkPolicy, routeWebSocketWithNetworkPolicy } from '../src/provider/network-policy.ts'

const hasChromium = existsSync(chromium.executablePath())

describe.skipIf(!hasChromium)('Playwright provider against a local deterministic page', () => {
  let server: Server
  let baseUrl: string
  let checkpointRoot: string
  let ctx: Context
  let runtimeFiber: Awaited<ReturnType<Context['plugin']>>
  let unregister: (() => Promise<void>) | undefined
  let popupRequests: number
  let activePopupResponses: number
  let downloadRequests: number
  let activeDownloadResponses: number

  beforeEach(async () => {
    popupRequests = 0
    activePopupResponses = 0
    downloadRequests = 0
    activeDownloadResponses = 0
    server = createServer((request, response) => {
      if (request.url === '/slow') {
        const timer = setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          response.end('<!doctype html><title>Slow fixture</title>')
        }, 200)
        response.on('close', () => { clearTimeout(timer) })
        return
      }
      if (request.url === '/large-text') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(`<!doctype html><title>Large text fixture</title><body>${'x'.repeat(100_000)}</body>`)
        return
      }
      if (request.url === '/tall') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><title>Tall fixture</title><body style="margin:0"><main style="height:5000px">Tall</main></body>')
        return
      }
      if (request.url === '/popup') {
        popupRequests += 1
        activePopupResponses += 1
        response.on('close', () => { activePopupResponses -= 1 })
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.write('<!doctype html><title>Unsupported popup</title>')
        return
      }
      if (request.url === '/download') {
        downloadRequests += 1
        activeDownloadResponses += 1
        response.on('close', () => { activeDownloadResponses -= 1 })
        response.writeHead(200, {
          'content-disposition': 'attachment; filename="fixture.txt"',
          'content-length': String(1024 * 1024),
          'content-type': 'text/plain; charset=utf-8',
        })
        response.write(Buffer.alloc(64 * 1024, 'x'))
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
        <html><head><title>Runtime fixture</title></head>
        <body>
          <p id="count"></p>
          <p id="socket-status"></p>
          <p id="dialog-status"></p>
          <p id="external-status"></p>
          <p id="permission-status"></p>
          <p id="upload-status"></p>
          <button id="increment">Increment</button>
          <button id="open-socket">Open socket</button>
          <button id="open-dialogs">Open dialogs</button>
          <button id="request-permissions">Request permissions</button>
          <button id="scripted-external">Open scripted external protocol</button>
          <button id="scripted-external-form">Submit scripted external form</button>
          <button id="scripted-external-location">Navigate scripted external protocol</button>
          <button id="scripted-upload">Open scripted upload</button>
          <button id="show-picker-upload">Show picker upload</button>
          <button id="scripted-download">Start scripted download</button>
          <button id="scripted-popup">Open scripted popup</button>
          <button id="scheduled-popup">Schedule popup</button>
          <button id="scheduled-download">Schedule download</button>
          <a id="popup-link" target="_blank" href="${baseUrl}popup">Open popup</a>
          <a id="download-link" download href="${baseUrl}download">Download file</a>
          <a id="response-download-link" href="${baseUrl}download">Response download</a>
          <a id="credential-link" href="${baseUrl.replace('http://', 'http://user:pass@')}">Credential URL</a>
          <a id="external-link" href="mailto:fixture@example.com">Open mail client</a>
          <form id="external-form" action="dsh-fixture:payload">
            <button type="submit">Submit external form</button>
          </form>
          <input id="upload" type="file" aria-label="Upload file">
          <input id="hidden-upload" type="file" hidden>
          <label role="button" for="hidden-upload">Open labeled upload</label>
          <input id="name" placeholder="Name">
          <input id="password" type="password" placeholder="Password">
          <script>
            const count = document.querySelector('#count')
            const render = () => { count.textContent = 'Count: ' + (localStorage.getItem('count') || '0') }
            document.querySelector('#increment').addEventListener('click', () => {
              localStorage.setItem('count', String(Number(localStorage.getItem('count') || '0') + 1))
              render()
            })
            document.querySelector('#open-socket').addEventListener('click', () => {
              const socket = new WebSocket('${baseUrl.replace('http://', 'ws://')}socket')
              socket.addEventListener('open', () => {
                document.querySelector('#socket-status').textContent = 'Socket: open'
              })
            })
            document.querySelector('#open-dialogs').addEventListener('click', () => {
              alert('fixture alert')
              const confirmed = confirm('fixture confirm')
              const prompted = prompt('fixture prompt', 'default')
              document.querySelector('#dialog-status').textContent =
                'Confirm: ' + confirmed + '; Prompt: ' + prompted
            })
            document.querySelector('#request-permissions').addEventListener('click', async () => {
              const names = [
                'geolocation',
                'notifications',
                'camera',
                'microphone',
                'clipboard-read',
                'clipboard-write',
              ]
              const states = {}
              for (const name of names) {
                states[name] = (await navigator.permissions.query({ name })).state
              }
              states.notificationRequest = await Notification.requestPermission()
              states.geolocationRequest = await new Promise(resolve => {
                navigator.geolocation.getCurrentPosition(
                  () => { resolve('granted') },
                  error => { resolve(error.code === error.PERMISSION_DENIED ? 'denied' : 'failed') },
                )
              })
              document.querySelector('#permission-status').textContent = JSON.stringify(states)
            })
            document.querySelector('#external-link').addEventListener('click', () => {
              document.querySelector('#external-status').textContent = 'External link dispatched'
            })
            document.querySelector('#external-form').addEventListener('submit', event => {
              event.preventDefault()
              document.querySelector('#external-status').textContent = 'External form dispatched'
            })
            document.querySelector('#scripted-external').addEventListener('click', () => {
              document.querySelector('#external-status').textContent = 'Scripted link handler'
              const link = document.createElement('a')
              link.href = 'tel:+12025550123'
              link.click()
            })
            document.querySelector('#scripted-external-form').addEventListener('click', () => {
              document.querySelector('#external-status').textContent = 'Scripted form handler'
              document.querySelector('#external-form').submit()
            })
            document.querySelector('#scripted-external-location').addEventListener('click', () => {
              document.querySelector('#external-status').textContent = 'Scripted location handler'
              location.href = 'mailto:fixture@example.com'
            })
            document.querySelector('#upload').addEventListener('click', () => {
              document.querySelector('#upload-status').textContent = 'Visible input clicked'
            })
            document.querySelector('#scripted-upload').addEventListener('click', () => {
              const upload = document.querySelector('#hidden-upload')
              upload.click()
              setTimeout(() => {
                document.querySelector('#upload-status').textContent = 'Files: ' + upload.files.length
              }, 0)
            })
            document.querySelector('#show-picker-upload').addEventListener('click', () => {
              const upload = document.querySelector('#hidden-upload')
              upload.showPicker()
              setTimeout(() => {
                document.querySelector('#upload-status').textContent = 'Files: ' + upload.files.length
              }, 0)
            })
            document.querySelector('#scripted-download').addEventListener('click', () => {
              const url = URL.createObjectURL(new Blob(['scripted download']))
              const link = document.createElement('a')
              link.href = url
              link.download = 'scripted.txt'
              link.click()
              setTimeout(() => { URL.revokeObjectURL(url) }, 0)
            })
            document.querySelector('#scripted-popup').addEventListener('click', () => {
              window.open('/popup', '_blank')
            })
            document.querySelector('#scheduled-popup').addEventListener('click', () => {
              setTimeout(() => {
                const link = document.createElement('a')
                link.href = '/popup'
                link.target = '_blank'
                link.click()
              }, 20)
            })
            document.querySelector('#scheduled-download').addEventListener('click', () => {
              setTimeout(() => {
                const link = document.createElement('a')
                link.href = '/download'
                link.click()
              }, 20)
            })
            render()
          </script>
        </body></html>`)
    })
    server.on('upgrade', (request, socket) => {
      if (request.url !== '/socket') {
        socket.destroy()
        return
      }
      const key = request.headers['sec-websocket-key']
      if (typeof key !== 'string') {
        socket.destroy()
        return
      }
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'))
      setTimeout(() => { socket.end() }, 20)
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

  it('truncates page text inside Chromium before returning the observation', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-observation-budget'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: `${baseUrl}large-text` })
    expect(opened.after).toMatchObject({
      title: 'Large text fixture',
      truncated: true,
    })
    expect(opened.after?.text).toHaveLength(60_000)
    expect(opened.after?.text).toBe('x'.repeat(60_000))
    await lease.release()
  })

  it('rejects screenshots that exceed pixel or encoded-byte budgets', async () => {
    if (unregister !== undefined) await unregister()
    const provider = new PlaywrightBrowserProvider({
      allowPrivateNetwork: true,
      checkpointRoot,
      actionTimeoutMs: 5_000,
      navigationTimeoutMs: 5_000,
      maxScreenshotPixels: 1_000_000,
      maxScreenshotBytes: 1,
    })
    unregister = ctx.browserRuntime.registerProvider(provider)

    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-screenshot-budget'),
      persistence: 'ephemeral',
    })
    await lease.act({ type: 'navigate', url: `${baseUrl}tall` })
    await expect(lease.screenshot()).rejects.toMatchObject({
      code: 'BROWSER_POLICY_DENIED',
      message: expect.stringContaining('1-byte limit'),
    })
    await expect(lease.screenshot({ fullPage: true }))
      .rejects.toMatchObject({
        code: 'BROWSER_POLICY_DENIED',
        message: expect.stringContaining('1000000-pixel limit'),
      })
    await lease.release()
  })

  it('opens a strict environment through the internal proxy-authentication bootstrap', async () => {
    const strictRoot = await mkdtemp(join(tmpdir(), 'browser-strict-checkpoints-'))
    const provider = new PlaywrightBrowserProvider({
      checkpointRoot: strictRoot,
      actionTimeoutMs: 5_000,
    })
    const signal = new AbortController().signal
    const environment = await provider.open({
      environmentId: BrowserEnvironmentId('strict-proxy-bootstrap'),
      sessionId: BrowserSessionId('strict-proxy-bootstrap'),
      signal,
    })
    try {
      const observation = await environment.observe({ maxTextChars: 1_000, signal })
      expect(observation.url).toBe('about:blank')
    } finally {
      await environment.close()
      await rm(strictRoot, { recursive: true, force: true })
    }
  })

  it('closes an interrupted context and permits a fresh environment', async () => {
    const owner = {}
    const sessionId = BrowserSessionId('playwright-cancel-recovery')
    const interrupted = await ctx.browserRuntime.acquire({ owner, sessionId, persistence: 'ephemeral' })
    const cancelled = new AbortController()
    const navigation = interrupted.act({ type: 'navigate', url: `${baseUrl}slow` }, cancelled.signal)
    await delay(20)
    cancelled.abort(new Error('navigation cancelled'))

    await expect(navigation).rejects.toThrow('navigation cancelled')
    await interrupted.release()

    const recovered = await ctx.browserRuntime.acquire({ owner, sessionId, persistence: 'ephemeral' })
    const opened = await recovered.act({ type: 'navigate', url: baseUrl })
    expect(opened.after?.title).toBe('Runtime fixture')
    await recovered.release()
  })

  it('forwards an admitted WebSocket', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-websocket-proxy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const button = opened.after!.elements.find(element => element.name === 'Open socket')!
    await lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: button.ref,
    })
    await delay(100)
    const observation = await lease.observe()
    expect(observation.text).toContain('Socket: open')
    await lease.release()
  })

  it('dismisses page dialogs before returning action evidence', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-dialogs'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const button = opened.after!.elements.find(element => element.name === 'Open dialogs')!
    const clicked = await lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: button.ref,
    })
    expect(clicked.after?.text).toContain('Confirm: false; Prompt: null')
    await lease.release()
  })

  it('denies browser permissions without opening a host prompt', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-permission-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const button = opened.after!.elements.find(element => element.name === 'Request permissions')!
    await lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: button.ref,
    })
    await delay(100)
    const observation = await lease.observe()
    expect(JSON.parse(observation.text.match(/\{[^}]+\}/u)![0]!)).toEqual({
      geolocation: 'denied',
      notifications: 'denied',
      camera: 'denied',
      microphone: 'denied',
      'clipboard-read': 'denied',
      'clipboard-write': 'denied',
      notificationRequest: 'denied',
      geolocationRequest: 'denied',
    })
    await lease.release()
  })

  it('rejects observed external-protocol links and forms before dispatch', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-external-protocol-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const link = opened.after!.elements.find(element => element.name === 'Open mail client')!
    await expect(lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: link.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    let refreshed = await lease.observe()
    expect(refreshed.text).not.toContain('External link dispatched')
    const submit = refreshed.elements.find(element => element.name === 'Submit external form')!
    await expect(lease.act({
      type: 'click',
      observationId: refreshed.id,
      elementRef: submit.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    refreshed = await lease.observe()
    expect(refreshed.text).not.toContain('External form dispatched')
    await lease.release()
  })

  it('blocks script-triggered external-protocol links and form submission', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-scripted-external-protocol-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const scriptedLink = opened.after!.elements.find(element => element.name === 'Open scripted external protocol')!
    await expect(lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: scriptedLink.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    let refreshed = await lease.observe()
    expect(refreshed.text).toContain('Scripted link handler')
    const scriptedForm = refreshed.elements.find(element => element.name === 'Submit scripted external form')!
    await expect(lease.act({
      type: 'click',
      observationId: refreshed.id,
      elementRef: scriptedForm.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    refreshed = await lease.observe()
    expect(refreshed.text).toContain('Scripted form handler')
    const scriptedLocation = refreshed.elements.find(
      element => element.name === 'Navigate scripted external protocol',
    )!
    await expect(lease.act({
      type: 'click',
      observationId: refreshed.id,
      elementRef: scriptedLocation.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    refreshed = await lease.observe()
    expect(refreshed.text).toContain('Scripted location handler')
    expect(refreshed.url).toBe(baseUrl)
    await lease.release()
  })

  it('rejects an observed file input before dispatch', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-file-input-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const input = opened.after!.elements.find(element => element.name === 'Upload file')!
    await expect(lease.act({
      type: 'fill',
      observationId: opened.after!.id,
      elementRef: input.ref,
      value: 'ignored',
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    const refreshed = await lease.observe()
    const refreshedInput = refreshed.elements.find(element => element.name === 'Upload file')!
    await expect(lease.act({
      type: 'click',
      observationId: refreshed.id,
      elementRef: refreshedInput.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    const observation = await lease.observe()
    expect(observation.text).not.toContain('Visible input clicked')
    await lease.release()
  })

  it('blocks showPicker and label activation for file inputs', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-file-activation-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const picker = opened.after!.elements.find(element => element.name === 'Show picker upload')!
    await expect(lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: picker.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    const refreshed = await lease.observe()
    expect(refreshed.text).toContain('Files: 0')
    const label = refreshed.elements.find(element => element.name === 'Open labeled upload')!
    await expect(lease.act({
      type: 'click',
      observationId: refreshed.id,
      elementRef: label.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    await lease.release()
  })

  it('blocks a script-triggered file chooser and rejects its action', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-scripted-file-chooser-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const button = opened.after!.elements.find(element => element.name === 'Open scripted upload')!
    await expect(lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: button.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    await delay(20)
    const observation = await lease.observe()
    expect(observation.text).toContain('Files: 0')
    await lease.release()
  })

  it('rejects a declared download before dispatch', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-declared-download-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const link = opened.after!.elements.find(element => element.name === 'Download file')!
    await expect(lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: link.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    expect({ downloadRequests, activeDownloadResponses }).toEqual({
      downloadRequests: 0,
      activeDownloadResponses: 0,
    })
    await lease.release()
  })

  it('cancels a script-triggered download and rejects its action', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-scripted-download-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const button = opened.after!.elements.find(element => element.name === 'Start scripted download')!
    await expect(lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: button.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    const observation = await lease.observe()
    expect(observation.title).toBe('Runtime fixture')
    await lease.release()
  })

  it('stops a response-triggered download and rejects its action', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-response-download-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const link = opened.after!.elements.find(element => element.name === 'Response download')!
    await expect(lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: link.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    await delay(50)
    expect({ downloadRequests, activeDownloadResponses }).toEqual({
      downloadRequests: 1,
      activeDownloadResponses: 0,
    })
    await lease.release()
  })

  it('stops a direct navigation to an attachment response', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-navigation-download-policy'),
      persistence: 'ephemeral',
    })
    await expect(lease.act({ type: 'navigate', url: `${baseUrl}download` }))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    await delay(50)
    expect({ downloadRequests, activeDownloadResponses }).toEqual({
      downloadRequests: 1,
      activeDownloadResponses: 0,
    })
    await lease.release()
  })

  it('stops a download created outside an active action', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-background-download-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const button = opened.after!.elements.find(element => element.name === 'Schedule download')!
    await lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: button.ref,
    })
    await delay(100)
    expect({ downloadRequests, activeDownloadResponses }).toEqual({
      downloadRequests: 1,
      activeDownloadResponses: 0,
    })
    const observation = await lease.observe()
    expect(observation.title).toBe('Runtime fixture')
    await lease.release()
  })

  it('rejects and closes a new page opened by an action', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-popup-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const link = opened.after!.elements.find(element => element.name === 'Open popup')!
    await expect(lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: link.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    await delay(50)
    expect({ popupRequests, activePopupResponses }).toEqual({ popupRequests: 0, activePopupResponses: 0 })
    const observation = await lease.observe()
    expect(observation.title).toBe('Runtime fixture')
    await lease.release()
  })

  it('blocks window.open without creating another page', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-window-open-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const button = opened.after!.elements.find(element => element.name === 'Open scripted popup')!
    await expect(lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: button.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    await delay(50)
    expect({ popupRequests, activePopupResponses }).toEqual({ popupRequests: 0, activePopupResponses: 0 })
    await lease.release()
  })

  it('closes a new page created outside an active action', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-background-popup-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const button = opened.after!.elements.find(element => element.name === 'Schedule popup')!
    await lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: button.ref,
    })
    await delay(100)
    expect({ popupRequests, activePopupResponses }).toEqual({ popupRequests: 1, activePopupResponses: 0 })
    const observation = await lease.observe()
    expect(observation.title).toBe('Runtime fixture')
    await lease.release()
  })

  it('surfaces a routed main-document denial from a click', async () => {
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('playwright-click-policy'),
      persistence: 'ephemeral',
    })
    const opened = await lease.act({ type: 'navigate', url: baseUrl })
    const credentialLink = opened.after!.elements.find(element => element.name === 'Credential URL')!

    await expect(lease.act({
      type: 'click',
      observationId: opened.after!.id,
      elementRef: credentialLink.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
    await lease.release()
  })

  it('blocks a private WebSocket before Chromium reaches its server', async () => {
    let upgrades = 0
    server.on('upgrade', (_request, socket) => {
      upgrades += 1
      socket.destroy()
    })
    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext()
      let routed = 0
      await context.routeWebSocket(/.*/, async (websocket) => {
        routed += 1
        await routeWebSocketWithNetworkPolicy(
          new NetworkPolicy({ mode: 'strict' }),
          {
            url: websocket.url(),
            connect: () => { websocket.connectToServer() },
            close: () => websocket.close({ code: 1008, reason: 'Blocked by browser network policy' }),
          },
        )
      })
      const page = await context.newPage()
      await page.evaluate(async (url) => {
        await new Promise<void>((resolve) => {
          const websocket = new WebSocket(url)
          const finish = () => { resolve() }
          websocket.addEventListener('error', finish, { once: true })
          websocket.addEventListener('close', finish, { once: true })
        })
      }, baseUrl.replace('http://', 'ws://'))

      expect(routed).toBe(1)
      expect(upgrades).toBe(0)
      await context.close()
    } finally {
      await browser.close()
    }
  })
})
