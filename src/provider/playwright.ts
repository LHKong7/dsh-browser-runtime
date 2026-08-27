/** Isolated Playwright/Chromium provider with bounded observations and storage-state checkpoints. */

import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { chromium } from 'playwright'
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  CDPSession,
  Dialog,
  Download,
  FileChooser,
  Locator,
  Page,
  Request,
  Response,
} from 'playwright'
import { z as zod } from 'zod'
import { BrowserProviderPolicyError, BrowserProviderTargetStaleError } from '../runtime/error.ts'
import { BrowserCheckpointRef, BrowserPageId, BrowserProviderId } from '../runtime/types.ts'
import type {
  BrowserProvider,
  BrowserProviderAction,
  BrowserProviderCheckpoint,
  BrowserProviderElement,
  BrowserProviderEnvironment,
  BrowserProviderObservation,
  BrowserProviderOpenRequest,
  BrowserProviderRestoreRequest,
  BrowserProviderTarget,
  BrowserCheckpointRef as BrowserCheckpointRefType,
} from '../runtime/types.ts'
import type {} from '../runtime/runtime.ts'
import { chromiumMissingMessage, readChromiumInstallation } from './chromium.ts'
import { NetworkPolicy, routeWebSocketWithNetworkPolicy, routeWithNetworkPolicy } from './network-policy.ts'
import {
  chromiumNetworkArgs,
  NETWORK_PROXY_AUTHENTICATION_URL,
  NetworkPolicyProxy,
} from './network-proxy.ts'

/** Stable registry id for the bundled Playwright provider. */
export const PLAYWRIGHT_PROVIDER_ID = BrowserProviderId('playwright')
/** Cordis plugin name. */
export const name = 'browser-playwright'
/** Runtime service required by the provider. */
export const inject = ['browserRuntime']

/** Playwright launch, action, observation, and network-policy configuration. */
export interface Config {
  /** Run Chromium without a visible window. */
  readonly headless?: boolean
  /** Navigation timeout in milliseconds. */
  readonly navigationTimeoutMs?: number
  /** Click, fill, observation, and screenshot timeout in milliseconds. */
  readonly actionTimeoutMs?: number
  /** Maximum interactive elements returned by one observation. */
  readonly maxElements?: number
  /** Maximum device pixels in one screenshot. */
  readonly maxScreenshotPixels?: number
  /** Maximum encoded PNG bytes returned by one screenshot. */
  readonly maxScreenshotBytes?: number
  /** Permit loopback, link-local, and private network destinations. */
  readonly allowPrivateNetwork?: boolean
  /** Provider-private checkpoint directory. */
  readonly checkpointRoot?: string
}

interface ResolvedConfig {
  readonly headless: boolean
  readonly navigationTimeoutMs: number
  readonly actionTimeoutMs: number
  readonly maxElements: number
  readonly maxScreenshotPixels: number
  readonly maxScreenshotBytes: number
  readonly allowPrivateNetwork: boolean
  readonly checkpointRoot: string
}

interface ElementSnapshot {
  readonly ordinal: number
  readonly kind: string
  readonly name: string
  readonly disabled: boolean
  readonly opensNewPage: boolean
  readonly downloads: boolean
  readonly externalProtocol: boolean
  readonly inputType?: string
  readonly fingerprint: string
}

interface PlaywrightTarget {
  readonly ordinal: number
  readonly opensNewPage: boolean
}

interface ResolvedPlaywrightTarget {
  readonly locator: Locator
  readonly opensNewPage: boolean
  readonly downloads: boolean
  readonly externalProtocol: boolean
  readonly inputType?: string
}

const NEW_PAGE_POLICY_MESSAGE = 'browser blocked a new page because the Playwright Provider exposes one page'
const FILE_CHOOSER_POLICY_MESSAGE = 'browser blocked a file chooser because the Playwright Provider has no upload capability'
const DOWNLOAD_POLICY_MESSAGE = 'browser blocked a download because the Playwright Provider has no download capability'
const EXTERNAL_PROTOCOL_POLICY_MESSAGE = 'browser blocked an external protocol because the Playwright Provider does not expose host handlers'

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
].join(',')

const checkpointStateSchema = zod.object({
  cookies: zod.array(zod.object({
    name: zod.string(),
    value: zod.string(),
    domain: zod.string(),
    path: zod.string(),
    expires: zod.number(),
    httpOnly: zod.boolean(),
    secure: zod.boolean(),
    sameSite: zod.enum(['Strict', 'Lax', 'None']),
  }).passthrough()),
  origins: zod.array(zod.object({
    origin: zod.string(),
    localStorage: zod.array(zod.object({ name: zod.string(), value: zod.string() })),
  }).passthrough()),
})

/** Provider plugin configuration schema. */
export const Config: z<Config> = z.object({
  headless: z.boolean().default(true),
  navigationTimeoutMs: z.number().default(30_000),
  actionTimeoutMs: z.number().default(10_000),
  maxElements: z.number().default(100),
  maxScreenshotPixels: z.number().default(16_000_000),
  maxScreenshotBytes: z.number().default(16 * 1024 * 1024),
  allowPrivateNetwork: z.boolean().default(false),
  checkpointRoot: z.string(),
})

/** Playwright implementation of the BrowserProvider interface. */
export class PlaywrightBrowserProvider implements BrowserProvider {
  readonly id = PLAYWRIGHT_PROVIDER_ID
  readonly capabilities = {
    checkpoint: true,
    screenshot: true,
    multiplePages: false,
    attachExisting: false,
    persistentProfile: false,
    networkEvents: false,
  } as const
  private readonly config: ResolvedConfig

  constructor(config: Config = {}) {
    this.config = resolveConfig(config)
  }

  /** Return true when Playwright's managed Chromium executable exists. */
  available(): boolean {
    return readChromiumInstallation().installed
  }

  /** Name the missing Chromium build and the command that installs it. */
  unavailableReason(): string | undefined {
    const installation = readChromiumInstallation()
    return installation.installed ? undefined : chromiumMissingMessage(installation)
  }

  /**
   * Summarize the launch configuration for the plugin start log.
   * @param installation - the Chromium installation state to report.
   * @returns one `key=value` line per fact, in report order.
   */
  startupReport(installation = readChromiumInstallation()): readonly string[] {
    return [
      `provider=${this.id}`,
      `chromium=${installation.installed ? 'available' : 'missing'}`,
      `headless=${this.config.headless}`,
      `networkPolicy=${this.config.allowPrivateNetwork ? 'allow-private' : 'strict'}`,
    ]
  }

  /** Open a fresh isolated browser context. */
  open(request: BrowserProviderOpenRequest): Promise<BrowserProviderEnvironment> {
    return this.openEnvironment(request)
  }

  /** Restore cookies and localStorage into a fresh isolated browser context. */
  async restore(request: BrowserProviderRestoreRequest): Promise<BrowserProviderEnvironment> {
    const state = await this.readCheckpoint(request.checkpoint.ref)
    return this.openEnvironment(request, state)
  }

  /** Delete one provider-private checkpoint payload. */
  async destroyCheckpoint(ref: BrowserCheckpointRefType): Promise<void> {
    const filename = this.checkpointPath(ref)
    try {
      await unlink(filename)
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    }
  }

  private async openEnvironment(
    request: BrowserProviderOpenRequest,
    storageState?: BrowserContextOptions['storageState'],
  ): Promise<BrowserProviderEnvironment> {
    request.signal.throwIfAborted()
    const controlHome = await mkdtemp(join(tmpdir(), 'dsh-browser-home-'))
    await chmod(controlHome, 0o700)
    let browser: Browser | undefined
    let context: BrowserContext | undefined
    let networkProxy: NetworkPolicyProxy | undefined
    try {
      const policy = new NetworkPolicy({ allowPrivateNetwork: this.config.allowPrivateNetwork })
      if (!this.config.allowPrivateNetwork) networkProxy = new NetworkPolicyProxy(policy)
      const proxy = await networkProxy?.listen(request.signal)
      browser = await chromium.launch({
        headless: this.config.headless,
        env: chromiumEnvironment(controlHome),
        ...(proxy === undefined ? {} : { proxy }),
        args: ['--deny-permission-prompts', ...chromiumNetworkArgs(this.config.allowPrivateNetwork)],
      })
      request.signal.throwIfAborted()
      context = await browser.newContext({
        // Download events need an owned artifact so the Provider can cancel the transfer and delete partial data.
        acceptDownloads: true,
        permissions: [],
        serviceWorkers: 'block',
        ...(storageState === undefined ? {} : { storageState }),
      })
      if (networkProxy !== undefined) {
        await primeNetworkProxyAuthentication(context, this.config.actionTimeoutMs, request.signal)
      }
      const environment = new PlaywrightEnvironment(browser, context, controlHome, networkProxy, policy, this.config)
      await environment.initialize(request.signal)
      return environment
    } catch (error: unknown) {
      const cleanupFailures: unknown[] = []
      if (networkProxy !== undefined) {
        try { await networkProxy.close() } catch (cleanupError: unknown) { cleanupFailures.push(cleanupError) }
      }
      if (context !== undefined) {
        try { await context.close() } catch (cleanupError: unknown) { cleanupFailures.push(cleanupError) }
      }
      if (browser !== undefined) {
        try { await browser.close() } catch (cleanupError: unknown) { cleanupFailures.push(cleanupError) }
      }
      try { await removeControlHome(controlHome) } catch (cleanupError: unknown) { cleanupFailures.push(cleanupError) }
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], 'Playwright environment setup and rollback failed')
      }
      throw error
    }
  }

  private async readCheckpoint(ref: BrowserCheckpointRefType): Promise<BrowserContextOptions['storageState']> {
    const raw = await readFile(this.checkpointPath(ref), 'utf8')
    return checkpointStateSchema.parse(JSON.parse(raw))
  }

  private checkpointPath(ref: BrowserCheckpointRefType): string {
    if (!/^checkpoint-[0-9a-f-]{36}\.json$/i.test(ref)) {
      throw new Error(`invalid Playwright checkpoint reference: ${ref}`)
    }
    const filename = resolve(this.config.checkpointRoot, ref)
    const prefix = resolve(this.config.checkpointRoot) + sep
    if (!filename.startsWith(prefix)) throw new Error('Playwright checkpoint escaped its private root')
    return filename
  }
}

async function primeNetworkProxyAuthentication(
  context: BrowserContext,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const page = await context.newPage()
  const onAbort = () => {
    void page.close().catch(() => {
      // Environment setup rollback closes the BrowserContext after a page-close failure.
    })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await page.goto(NETWORK_PROXY_AUTHENTICATION_URL, { timeout: timeoutMs })
    if (signal.aborted) signal.throwIfAborted()
    if (response?.status() !== 200) throw new Error('browser policy proxy authentication failed')
  } catch (error: unknown) {
    if (signal.aborted) {
      await page.close().catch(() => {
        // Environment setup rollback closes the BrowserContext after a page-close failure.
      })
      signal.throwIfAborted()
    }
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!page.isClosed()) await page.close()
  }
}

/** One Playwright browser/context/page owned by the runtime. */
class PlaywrightEnvironment implements BrowserProviderEnvironment {
  private page: Page | undefined
  private cdpSession: CDPSession | undefined
  private closePromise: Promise<void> | undefined
  private blockedNavigation: BrowserProviderPolicyError | undefined
  private unexpectedPageRevision = 0
  private readonly unexpectedPageClosures = new Map<Page, Promise<void>>()
  private readonly unexpectedPageCloseFailures: unknown[] = []
  private readonly windowOpenBinding = `__dsh_window_open_${randomUUID().replaceAll('-', '_')}`
  private readonly fileChooserBinding = `__dsh_file_chooser_${randomUUID().replaceAll('-', '_')}`
  private readonly externalProtocolBinding = `__dsh_external_protocol_${randomUUID().replaceAll('-', '_')}`
  private blockedWindowOpenRevision = 0
  private fileChooserRevision = 0
  private readonly fileChooserClearings = new Map<FileChooser, Promise<void>>()
  private readonly fileChooserClearFailures: unknown[] = []
  private downloadRevision = 0
  private readonly downloadResponseStops = new Map<Response, Promise<void>>()
  private readonly downloadResponseStopFailures: unknown[] = []
  private readonly downloadCancellations = new Map<Download, Promise<void>>()
  private readonly downloadCancellationFailures: unknown[] = []
  private readonly dialogDismissals = new Map<Dialog, Promise<void>>()
  private readonly dialogDismissalFailures: unknown[] = []
  private readonly navigationSettlements = new Map<Request, Promise<void>>()
  private readonly navigationSettlementFailures: unknown[] = []
  private externalProtocolRevision = 0
  private nextExternalProtocolStopId = 0
  private readonly externalProtocolStops = new Map<number, Promise<void>>()
  private readonly externalProtocolStopFailures: unknown[] = []

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly controlHome: string,
    private readonly networkProxy: NetworkPolicyProxy | undefined,
    private readonly policy: NetworkPolicy,
    private readonly config: ResolvedConfig,
  ) {}

  async initialize(signal: AbortSignal): Promise<void> {
    await this.context.exposeBinding(this.windowOpenBinding, () => {
      this.blockedWindowOpenRevision += 1
    })
    await this.context.exposeBinding(this.fileChooserBinding, () => {
      this.fileChooserRevision += 1
    })
    await this.context.exposeBinding(this.externalProtocolBinding, () => {
      this.externalProtocolRevision += 1
    })
    await this.context.addInitScript(
      // Playwright serializes this function into Chromium, outside Node's coverage isolate.
      /* v8 ignore next */
      ({ externalProtocolBinding, fileChooserBinding, windowOpenBinding }) => {
        const report = (bindingName: string) => {
          const binding = Reflect.get(globalThis, bindingName)
          if (typeof binding === 'function') {
            void Promise.resolve(binding()).catch(() => {
              // BrowserContext teardown owns binding rejection after the page closes.
            })
          }
        }
        const navigationUrl = (node: HTMLElement): string | undefined => {
          let rawUrl: string | null = null
          if (node instanceof HTMLAnchorElement) {
            rawUrl = node.getAttribute('href')
          } else if (node instanceof HTMLFormElement) {
            rawUrl = node.getAttribute('action')
          } else if (node instanceof HTMLButtonElement && node.type === 'submit') {
            rawUrl = node.getAttribute('formaction') ?? node.form?.getAttribute('action') ?? null
          } else if (node instanceof HTMLInputElement && (node.type === 'submit' || node.type === 'image')) {
            rawUrl = node.getAttribute('formaction') ?? node.form?.getAttribute('action') ?? null
          }
          if (rawUrl === null) return undefined
          try {
            return new URL(rawUrl, node.ownerDocument.baseURI).toString()
          } catch {
            return rawUrl
          }
        }
        const usesExternalProtocol = (node: HTMLElement): boolean => {
          const rawUrl = navigationUrl(node)
          if (rawUrl === undefined) return false
          try {
            return !['http:', 'https:', 'javascript:', 'blob:', 'data:', 'about:']
              .includes(new URL(rawUrl, node.ownerDocument.baseURI).protocol.toLowerCase())
          } catch {
            return true
          }
        }
        Object.defineProperty(globalThis, 'open', {
          configurable: false,
          writable: false,
          value: () => {
            report(windowOpenBinding)
            return null
          },
        })
        const anchorClick = HTMLAnchorElement.prototype.click
        Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
          configurable: false,
          writable: false,
          value(this: HTMLAnchorElement) {
            if (usesExternalProtocol(this)) {
              report(externalProtocolBinding)
              return
            }
            Reflect.apply(anchorClick, this, [])
          },
        })
        const inputClick = HTMLInputElement.prototype.click
        Object.defineProperty(HTMLInputElement.prototype, 'click', {
          configurable: false,
          writable: false,
          value(this: HTMLInputElement) {
            if (this.type.toLowerCase() === 'file') {
              report(fileChooserBinding)
              return
            }
            Reflect.apply(inputClick, this, [])
          },
        })
        const inputShowPicker = Reflect.get(HTMLInputElement.prototype, 'showPicker')
        if (typeof inputShowPicker === 'function') {
          Object.defineProperty(HTMLInputElement.prototype, 'showPicker', {
            configurable: false,
            writable: false,
            value(this: HTMLInputElement) {
              if (this.type.toLowerCase() === 'file') {
                report(fileChooserBinding)
                return
              }
              Reflect.apply(inputShowPicker, this, [])
            },
          })
        }
        const formSubmit = HTMLFormElement.prototype.submit
        Object.defineProperty(HTMLFormElement.prototype, 'submit', {
          configurable: false,
          writable: false,
          value(this: HTMLFormElement) {
            if (usesExternalProtocol(this)) {
              report(externalProtocolBinding)
              return
            }
            Reflect.apply(formSubmit, this, [])
          },
        })
        globalThis.addEventListener('click', (event) => {
          const fileInput = event.composedPath().find((target): target is HTMLInputElement => (
            target instanceof HTMLInputElement && target.type.toLowerCase() === 'file'
          )) ?? (event.target instanceof HTMLLabelElement
            && event.target.control instanceof HTMLInputElement
            && event.target.control.type.toLowerCase() === 'file'
            ? event.target.control
            : undefined)
          if (fileInput === undefined) return
          event.preventDefault()
          event.stopImmediatePropagation()
          report(fileChooserBinding)
        }, { capture: true })
        globalThis.addEventListener('click', (event) => {
          const navigationTarget = event.composedPath().find((target): target is HTMLElement => (
            target instanceof HTMLElement && usesExternalProtocol(target)
          ))
          if (navigationTarget === undefined) return
          event.preventDefault()
          event.stopImmediatePropagation()
          report(externalProtocolBinding)
        }, { capture: true })
        globalThis.addEventListener('submit', (event) => {
          if (!(event.target instanceof HTMLFormElement)) return
          const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLElement
            ? event.submitter
            : event.target
          if (!usesExternalProtocol(submitter)) return
          event.preventDefault()
          event.stopImmediatePropagation()
          report(externalProtocolBinding)
        }, { capture: true })
      },
      {
        externalProtocolBinding: this.externalProtocolBinding,
        fileChooserBinding: this.fileChooserBinding,
        windowOpenBinding: this.windowOpenBinding,
      },
    )
    await this.context.routeWebSocket(/.*/, websocket => routeWebSocketWithNetworkPolicy(
      this.policy,
      {
        url: websocket.url(),
        connect: () => { websocket.connectToServer() },
        close: () => websocket.close({ code: 1008, reason: 'Blocked by browser network policy' }),
      },
    ))
    await this.context.route('**/*', async (route) => {
      const playwrightRequest = route.request()
      let requestFrame: ReturnType<Request['frame']> | undefined
      if (playwrightRequest.isNavigationRequest()) {
        try {
          requestFrame = playwrightRequest.frame()
        } catch {
          // Request.frame() throws here only when a new Page navigates before its Frame exists; Page cleanup owns it.
        }
      }
      const isPageNavigation = requestFrame?.page() === this.page
      const isPrimaryNavigation = requestFrame === this.page?.mainFrame()
      if (isPageNavigation) this.trackNavigationResponse(playwrightRequest)
      await routeWithNetworkPolicy(
        this.policy,
        {
          url: playwrightRequest.url(),
          continue: () => route.continue(),
          abort: () => route.abort('blockedbyclient'),
        },
        (error) => {
          if (isPrimaryNavigation) this.blockedNavigation = error
        },
      )
    })
    this.page = await this.context.newPage()
    this.cdpSession = await this.context.newCDPSession(this.page)
    await this.cdpSession.send('Page.enable')
    this.cdpSession.on('Page.frameRequestedNavigation', (event: { url: string }) => {
      this.stopExternalProtocolNavigation(event.url)
    })
    this.page.setDefaultTimeout(this.config.actionTimeoutMs)
    this.page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs)
    this.page.on('dialog', dialog => { this.dismissDialog(dialog) })
    this.page.on('filechooser', fileChooser => { this.clearFileChooser(fileChooser) })
    this.page.on('download', download => { this.cancelDownload(download) })
    this.page.on('response', response => { this.stopAttachmentResponse(response) })
    this.context.on('page', page => {
      if (page !== this.page) this.closeUnexpectedPage(page)
    })
    signal.throwIfAborted()
  }

  async observe(request: { maxTextChars: number; signal: AbortSignal }): Promise<BrowserProviderObservation> {
    return this.run(request.signal, async () => {
      const page = this.requirePage()
      const [title, body, elements] = await Promise.all([
        page.title(),
        page.locator('body').evaluate(snapshotBodyText, request.maxTextChars)
          .catch(() => ({ text: '', truncated: false })),
        page.locator(INTERACTIVE_SELECTOR).evaluateAll(snapshotElements, this.config.maxElements),
      ])
      return {
        pageId: BrowserPageId('page-1'),
        url: page.url(),
        title,
        text: body.text,
        truncated: body.truncated,
        elements: elements.map((element): BrowserProviderElement => ({
          kind: element.kind,
          name: element.name,
          disabled: element.disabled,
          ...(element.inputType === undefined ? {} : { inputType: element.inputType }),
          fingerprint: element.fingerprint,
          target: {
            ordinal: element.ordinal,
            opensNewPage: element.opensNewPage,
          } satisfies PlaywrightTarget,
        })),
      }
    })
  }

  async act(action: BrowserProviderAction, signal: AbortSignal): Promise<void> {
    await this.run(signal, async () => {
      const page = this.requirePage()
      await this.drainTransientResources()
      const unexpectedPageRevision = this.unexpectedPageRevision
      const blockedWindowOpenRevision = this.blockedWindowOpenRevision
      const fileChooserRevision = this.fileChooserRevision
      const downloadRevision = this.downloadRevision
      const externalProtocolRevision = this.externalProtocolRevision
      this.blockedNavigation = undefined
      let actionFailure: unknown
      try {
        if (action.type === 'navigate') {
          await this.policy.assertAllowed(action.url)
          await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
        } else {
          const target = await this.resolveTarget(action.target)
          if (target.inputType === 'file') {
            throw new BrowserProviderPolicyError(FILE_CHOOSER_POLICY_MESSAGE)
          }
          if (action.type === 'click') {
            if (target.externalProtocol) {
              throw new BrowserProviderPolicyError(EXTERNAL_PROTOCOL_POLICY_MESSAGE)
            }
            if (target.opensNewPage) {
              throw new BrowserProviderPolicyError(NEW_PAGE_POLICY_MESSAGE)
            }
            if (target.downloads) {
              throw new BrowserProviderPolicyError(DOWNLOAD_POLICY_MESSAGE)
            }
            await target.locator.click({ timeout: this.config.actionTimeoutMs })
          } else {
            await target.locator.fill(action.value, { timeout: this.config.actionTimeoutMs })
          }
        }
      } catch (error: unknown) {
        actionFailure = error
      }
      if (actionFailure === undefined) {
        try {
          await page.waitForTimeout(0)
        } catch (error: unknown) {
          actionFailure = error
        }
      }
      let resourceCleanupFailure: unknown
      try {
        await this.drainTransientResources()
      } catch (error: unknown) {
        resourceCleanupFailure = error
      }
      const detectedPolicyFailure = this.unexpectedPageRevision !== unexpectedPageRevision
        || this.blockedWindowOpenRevision !== blockedWindowOpenRevision
        ? new BrowserProviderPolicyError(NEW_PAGE_POLICY_MESSAGE)
        : this.fileChooserRevision !== fileChooserRevision
          ? new BrowserProviderPolicyError(FILE_CHOOSER_POLICY_MESSAGE)
          : this.downloadRevision !== downloadRevision
            ? new BrowserProviderPolicyError(DOWNLOAD_POLICY_MESSAGE)
            : this.externalProtocolRevision !== externalProtocolRevision
              ? new BrowserProviderPolicyError(EXTERNAL_PROTOCOL_POLICY_MESSAGE)
              : undefined
      const primaryFailure = this.blockedNavigation ?? detectedPolicyFailure ?? actionFailure
      if (resourceCleanupFailure !== undefined && primaryFailure !== undefined) {
        if (primaryFailure instanceof BrowserProviderPolicyError) {
          throw new BrowserProviderPolicyError(primaryFailure.message, {
            cause: new AggregateError(
              [primaryFailure, resourceCleanupFailure],
              'browser policy decision and transient-resource cleanup failed',
            ),
          })
        }
        throw new AggregateError(
          [primaryFailure, resourceCleanupFailure],
          'browser action and transient-resource cleanup failed',
        )
      }
      if (primaryFailure !== undefined) throw primaryFailure
      if (resourceCleanupFailure !== undefined) throw resourceCleanupFailure
    })
  }

  screenshot(options: { fullPage: boolean; signal: AbortSignal }): Promise<Uint8Array> {
    return this.run(options.signal, async () => {
      const page = this.requirePage()
      const layout = await page.evaluate(snapshotScreenshotLayout)
      const width = options.fullPage ? layout.contentWidth : layout.viewportWidth
      const height = options.fullPage ? layout.contentHeight : layout.viewportHeight
      const pixelWidth = Math.ceil(width * layout.deviceScaleFactor)
      const pixelHeight = Math.ceil(height * layout.deviceScaleFactor)
      const pixels = pixelWidth * pixelHeight
      if (!Number.isSafeInteger(pixels) || pixels > this.config.maxScreenshotPixels) {
        throw new BrowserProviderPolicyError(
          `browser blocked a ${pixelWidth}x${pixelHeight} screenshot because it exceeds the ${this.config.maxScreenshotPixels}-pixel limit`,
        )
      }
      const data = await page.screenshot({
        type: 'png',
        ...(options.fullPage
          ? { clip: { x: 0, y: 0, width, height } }
          : { fullPage: false }),
        timeout: this.config.actionTimeoutMs,
      })
      if (data.byteLength > this.config.maxScreenshotBytes) {
        throw new BrowserProviderPolicyError(
          `browser blocked a ${data.byteLength}-byte screenshot because it exceeds the ${this.config.maxScreenshotBytes}-byte limit`,
        )
      }
      return new Uint8Array(data)
    })
  }

  async checkpoint(signal: AbortSignal): Promise<BrowserProviderCheckpoint> {
    return this.run(signal, async () => {
      await ensurePrivateDirectory(this.config.checkpointRoot)
      const state = await this.context.storageState()
      const ref = BrowserCheckpointRef(`checkpoint-${randomUUID()}.json`)
      await writeFileAtomic(
        resolve(this.config.checkpointRoot, ref),
        `${JSON.stringify(state)}\n`,
        { mode: 0o600, dirMode: 0o700 },
      )
      return { ref, coverage: ['cookies', 'local-storage'] }
    })
  }

  close(): Promise<void> {
    this.closePromise ??= this.runClose()
    return this.closePromise
  }

  private async resolveTarget(target: BrowserProviderTarget): Promise<ResolvedPlaywrightTarget> {
    if (!isPlaywrightTarget(target.target)) throw new BrowserProviderTargetStaleError()
    const locator = this.requirePage().locator(INTERACTIVE_SELECTOR).nth(target.target.ordinal)
    let snapshot: ElementSnapshot | undefined
    try {
      snapshot = (await locator.evaluateAll(snapshotElements, 1))[0]
    } catch (error: unknown) {
      throw new BrowserProviderTargetStaleError(`the observed element is no longer present: ${String(error)}`)
    }
    if (snapshot?.fingerprint !== target.fingerprint) throw new BrowserProviderTargetStaleError()
    return {
      locator,
      opensNewPage: snapshot.opensNewPage,
      downloads: snapshot.downloads,
      externalProtocol: snapshot.externalProtocol,
      ...(snapshot.inputType === undefined ? {} : { inputType: snapshot.inputType }),
    }
  }

  private async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    let abortCleanup: Promise<void> | undefined
    const onAbort = () => { abortCleanup = this.close() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await operation()
      if (signal.aborted) {
        await abortCleanup
        signal.throwIfAborted()
      }
      return result
    } catch (error: unknown) {
      if (abortCleanup !== undefined) {
        await abortCleanup.catch(() => {
          // The caller's abort reason remains authoritative over environment cleanup failure.
        })
      }
      if (signal.aborted) signal.throwIfAborted()
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async runClose(): Promise<void> {
    const failures: unknown[] = []
    if (this.networkProxy !== undefined) {
      try { await this.networkProxy.close() } catch (error: unknown) { failures.push(error) }
    }
    try { await this.drainTransientResources() } catch (error: unknown) { failures.push(error) }
    try { await this.context.close() } catch (error: unknown) { failures.push(error) }
    try { await this.browser.close() } catch (error: unknown) { failures.push(error) }
    try { await removeControlHome(this.controlHome) } catch (error: unknown) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'Playwright environment cleanup failed')
  }

  private requirePage(): Page {
    if (this.page === undefined || this.page.isClosed()) throw new Error('Playwright page is closed')
    return this.page
  }

  private closeUnexpectedPage(page: Page): void {
    if (this.unexpectedPageClosures.has(page)) return
    this.unexpectedPageRevision += 1
    let closure: Promise<void>
    closure = page.close()
      .catch((error: unknown) => { this.unexpectedPageCloseFailures.push(error) })
      .finally(() => { this.unexpectedPageClosures.delete(page) })
    this.unexpectedPageClosures.set(page, closure)
  }

  private async drainUnexpectedPages(): Promise<void> {
    for (const page of this.context.pages()) {
      if (page !== this.page) this.closeUnexpectedPage(page)
    }
    while (this.unexpectedPageClosures.size > 0) {
      await Promise.all(this.unexpectedPageClosures.values())
    }
    if (this.unexpectedPageCloseFailures.length === 0) return
    const failures = this.unexpectedPageCloseFailures.splice(0)
    throw new AggregateError(failures, 'browser could not close an unsupported new page')
  }

  private dismissDialog(dialog: Dialog): void {
    if (this.dialogDismissals.has(dialog)) return
    let dismissal: Promise<void>
    dismissal = dialog.dismiss()
      .catch(async (error: unknown) => {
        this.dialogDismissalFailures.push(error)
        const page = dialog.page()
        if (page !== null && !page.isClosed()) {
          try { await page.close() } catch (closeError: unknown) { this.dialogDismissalFailures.push(closeError) }
        }
      })
      .finally(() => { this.dialogDismissals.delete(dialog) })
    this.dialogDismissals.set(dialog, dismissal)
  }

  private clearFileChooser(fileChooser: FileChooser): void {
    if (this.fileChooserClearings.has(fileChooser)) return
    this.fileChooserRevision += 1
    let clearing: Promise<void>
    clearing = fileChooser.setFiles([])
      .catch((error: unknown) => { this.fileChooserClearFailures.push(error) })
      .finally(() => { this.fileChooserClearings.delete(fileChooser) })
    this.fileChooserClearings.set(fileChooser, clearing)
  }

  private cancelDownload(download: Download): void {
    if (this.downloadCancellations.has(download)) return
    this.downloadRevision += 1
    let cancellation: Promise<void>
    cancellation = download.cancel()
      .catch((error: unknown) => { this.downloadCancellationFailures.push(error) })
      .finally(() => { this.downloadCancellations.delete(download) })
    this.downloadCancellations.set(download, cancellation)
  }

  private stopAttachmentResponse(response: Response): void {
    const request = response.request()
    const disposition = response.headers()['content-disposition']
    if (!request.isNavigationRequest()
      || request.frame().page() !== this.page
      || disposition?.split(';', 1)[0]?.trim().toLowerCase() !== 'attachment'
      || this.downloadResponseStops.has(response)) return
    this.downloadRevision += 1
    const cdpSession = this.cdpSession
    if (cdpSession === undefined) {
      this.downloadResponseStopFailures.push(new Error('browser control session is unavailable for an attachment response'))
      return
    }
    let stopping: Promise<void>
    stopping = cdpSession.send('Page.stopLoading').then(() => undefined)
      .catch((error: unknown) => { this.downloadResponseStopFailures.push(error) })
      .finally(() => { this.downloadResponseStops.delete(response) })
    this.downloadResponseStops.set(response, stopping)
  }

  private stopExternalProtocolNavigation(rawUrl: string): void {
    if (!usesExternalProtocolUrl(rawUrl)) return
    this.externalProtocolRevision += 1
    const cdpSession = this.cdpSession
    if (cdpSession === undefined) {
      this.externalProtocolStopFailures.push(new Error('browser control session is unavailable for an external protocol'))
      return
    }
    const id = this.nextExternalProtocolStopId
    this.nextExternalProtocolStopId += 1
    let stopping: Promise<void>
    stopping = cdpSession.send('Page.stopLoading').then(() => undefined)
      .catch((error: unknown) => { this.externalProtocolStopFailures.push(error) })
      .finally(() => { this.externalProtocolStops.delete(id) })
    this.externalProtocolStops.set(id, stopping)
  }

  private async drainTransientResources(): Promise<void> {
    const failures: unknown[] = []
    try {
      await this.drainTrackedOperations(
        this.navigationSettlements,
        this.navigationSettlementFailures,
        'browser could not settle a page navigation response',
      )
    } catch (error: unknown) {
      failures.push(error)
    }
    try {
      await this.drainTrackedOperations(
        this.externalProtocolStops,
        this.externalProtocolStopFailures,
        'browser could not stop an unsupported external protocol',
      )
    } catch (error: unknown) {
      failures.push(error)
    }
    try {
      await this.drainTrackedOperations(
        this.dialogDismissals,
        this.dialogDismissalFailures,
        'browser could not dismiss a page dialog',
      )
    } catch (error: unknown) {
      failures.push(error)
    }
    try {
      await this.drainTrackedOperations(
        this.fileChooserClearings,
        this.fileChooserClearFailures,
        'browser could not clear an unsupported file chooser',
      )
    } catch (error: unknown) {
      failures.push(error)
    }
    try {
      await this.drainTrackedOperations(
        this.downloadResponseStops,
        this.downloadResponseStopFailures,
        'browser could not stop an unsupported attachment response',
      )
    } catch (error: unknown) {
      failures.push(error)
    }
    try {
      await this.drainTrackedOperations(
        this.downloadCancellations,
        this.downloadCancellationFailures,
        'browser could not cancel an unsupported download',
      )
    } catch (error: unknown) {
      failures.push(error)
    }
    try {
      await this.drainUnexpectedPages()
    } catch (error: unknown) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'browser transient-resource cleanup failed')
    }
  }

  private async drainTrackedOperations<T>(
    operations: ReadonlyMap<T, Promise<void>>,
    operationFailures: unknown[],
    message: string,
  ): Promise<void> {
    while (operations.size > 0) await Promise.all(operations.values())
    if (operationFailures.length === 0) return
    const failures = operationFailures.splice(0)
    throw new AggregateError(failures, message)
  }

  private trackNavigationResponse(request: Request): void {
    if (this.navigationSettlements.has(request)) return
    let settlement: Promise<void>
    settlement = this.settleNavigationResponse(request)
      .catch((error: unknown) => { this.navigationSettlementFailures.push(error) })
      .finally(() => { this.navigationSettlements.delete(request) })
    this.navigationSettlements.set(request, settlement)
  }

  private async settleNavigationResponse(request: Request): Promise<void> {
    const response = request.response()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      await Promise.race([
        response,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            timedOut = true
            reject(new Error('browser page navigation response timed out'))
          }, this.config.navigationTimeoutMs)
        }),
      ])
      const page = this.page
      if (page !== undefined && !page.isClosed()) await page.waitForTimeout(0)
    } catch (error: unknown) {
      if (timedOut) {
        const page = this.page
        if (page !== undefined && !page.isClosed()) await page.close()
        await response.catch(() => {
          // Closing the primary Page owns a navigation response that never produced headers.
        })
      }
      throw error
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const navigationTimeoutMs = config.navigationTimeoutMs ?? 30_000
  const actionTimeoutMs = config.actionTimeoutMs ?? 10_000
  const maxElements = config.maxElements ?? 100
  const maxScreenshotPixels = config.maxScreenshotPixels ?? 16_000_000
  const maxScreenshotBytes = config.maxScreenshotBytes ?? 16 * 1024 * 1024
  for (const [key, value] of Object.entries({
    navigationTimeoutMs,
    actionTimeoutMs,
    maxElements,
    maxScreenshotPixels,
    maxScreenshotBytes,
  })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`browser-playwright: ${key} must be a positive integer`)
  }
  return {
    headless: config.headless ?? true,
    navigationTimeoutMs,
    actionTimeoutMs,
    maxElements,
    maxScreenshotPixels,
    maxScreenshotBytes,
    allowPrivateNetwork: config.allowPrivateNetwork ?? false,
    checkpointRoot: resolve(config.checkpointRoot ?? join(
      resolveDshHome(),
      'browser-runtime',
      'providers',
      'playwright',
      'v1',
      'checkpoints',
    )),
  }
}

function chromiumEnvironment(controlHome: string): Record<string, string> {
  const result: Record<string, string> = { HOME: controlHome }
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY']) {
    const value = process.env[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Playwright checkpoint root must be a real directory: ${directory}`)
  }
  await chmod(directory, 0o700)
}

async function removeControlHome(directory: string): Promise<void> {
  const resolved = resolve(directory)
  const prefix = resolve(tmpdir()) + sep
  if (!resolved.startsWith(prefix) || !resolved.split(sep).at(-1)?.startsWith('dsh-browser-home-')) {
    throw new Error(`refusing to remove unexpected browser control home: ${directory}`)
  }
  await rm(resolved, { recursive: true, force: true })
}

// Playwright serializes this function into Chromium, outside Node's coverage isolate.
/* v8 ignore next */
function snapshotBodyText(body: Element, maxTextChars: number): { text: string; truncated: boolean } {
  const text = body instanceof HTMLElement ? body.innerText : (body.textContent ?? '')
  return {
    text: text.slice(0, maxTextChars),
    truncated: text.length > maxTextChars,
  }
}

// Playwright serializes this function into Chromium, outside Node's coverage isolate.
/* v8 ignore next */
function snapshotScreenshotLayout(): {
  contentWidth: number
  contentHeight: number
  viewportWidth: number
  viewportHeight: number
  deviceScaleFactor: number
} {
  const root = document.documentElement
  const body = document.body
  const viewportWidth = Math.max(globalThis.innerWidth, 1)
  const viewportHeight = Math.max(globalThis.innerHeight, 1)
  return {
    contentWidth: Math.max(viewportWidth, root?.scrollWidth ?? 0, body?.scrollWidth ?? 0),
    contentHeight: Math.max(viewportHeight, root?.scrollHeight ?? 0, body?.scrollHeight ?? 0),
    viewportWidth,
    viewportHeight,
    deviceScaleFactor: Number.isFinite(globalThis.devicePixelRatio) && globalThis.devicePixelRatio > 0
      ? globalThis.devicePixelRatio
      : 1,
  }
}

// Playwright serializes this function into Chromium, outside Node's coverage isolate.
/* v8 ignore next */
function snapshotElements(nodes: Element[], maxElements: number): ElementSnapshot[] {
  const opensNewPage = (node: HTMLElement): boolean => {
    const defaultTarget = node.ownerDocument.querySelector('base[target]')?.getAttribute('target') ?? ''
    let target = ''
    if (node instanceof HTMLAnchorElement) {
      target = node.target || defaultTarget
    } else if (node instanceof HTMLButtonElement && node.type === 'submit') {
      target = node.formTarget || node.form?.target || defaultTarget
    } else if (node instanceof HTMLInputElement && (node.type === 'submit' || node.type === 'image')) {
      target = node.formTarget || node.form?.target || defaultTarget
    }
    const trimmed = target.trim()
    const normalized = trimmed.toLowerCase()
    if (normalized === '' || normalized === '_self' || normalized === '_parent'
      || normalized === '_top' || normalized === '_unfencedtop') return false
    if (normalized === '_blank') return true
    return ![...node.ownerDocument.querySelectorAll('iframe, frame')]
      .some(frame => frame.getAttribute('name') === trimmed)
  }
  const usesExternalProtocol = (node: HTMLElement): boolean => {
    let rawUrl: string | null = null
    if (node instanceof HTMLAnchorElement) {
      rawUrl = node.getAttribute('href')
    } else if (node instanceof HTMLButtonElement && node.type === 'submit') {
      rawUrl = node.getAttribute('formaction') ?? node.form?.getAttribute('action') ?? null
    } else if (node instanceof HTMLInputElement && (node.type === 'submit' || node.type === 'image')) {
      rawUrl = node.getAttribute('formaction') ?? node.form?.getAttribute('action') ?? null
    }
    if (rawUrl === null) return false
    try {
      return !['http:', 'https:', 'javascript:', 'blob:', 'data:', 'about:']
        .includes(new URL(rawUrl, node.ownerDocument.baseURI).protocol.toLowerCase())
    } catch {
      return true
    }
  }
  const describe = (node: HTMLElement, ordinal: number): ElementSnapshot => {
    const tag = node.tagName.toLowerCase()
    const role = node.getAttribute('role')?.trim().toLowerCase()
    const inputType = node instanceof HTMLInputElement ? (node.type || 'text').toLowerCase() : undefined
    const kind = role || (inputType === undefined ? tag : `${tag}:${inputType}`)
    const candidate = node.getAttribute('aria-label')
      ?? node.getAttribute('title')
      ?? node.getAttribute('alt')
      ?? node.getAttribute('placeholder')
      ?? node.textContent
      ?? ''
    const name = candidate.replace(/\s+/g, ' ').trim().slice(0, 200)
    const disabled = 'disabled' in node && Boolean((node as HTMLButtonElement).disabled)
    const newPage = opensNewPage(node)
    const downloads = node instanceof HTMLAnchorElement && node.hasAttribute('download')
    const externalProtocol = usesExternalProtocol(node)
    const fingerprint = JSON.stringify({
      tag,
      role: role ?? '',
      inputType: inputType ?? '',
      name,
      opensNewPage: newPage,
      downloads,
      externalProtocol,
    })
    return {
      ordinal,
      kind,
      name,
      disabled,
      opensNewPage: newPage,
      downloads,
      externalProtocol,
      ...(inputType === undefined ? {} : { inputType }),
      fingerprint,
    }
  }
  const result: ElementSnapshot[] = []
  for (let ordinal = 0; ordinal < nodes.length && result.length < maxElements; ordinal += 1) {
    const node = nodes[ordinal]
    if (!(node instanceof HTMLElement)) continue
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    if (style.visibility === 'hidden' || style.display === 'none' || rect.width === 0 || rect.height === 0) continue
    const snapshot = describe(node, ordinal)
    result.push(snapshot)
  }
  return result
}

function isPlaywrightTarget(value: unknown): value is PlaywrightTarget {
  return typeof value === 'object'
    && value !== null
    && 'ordinal' in value
    && 'opensNewPage' in value
    && typeof value.ordinal === 'number'
    && typeof value.opensNewPage === 'boolean'
    && Number.isInteger(value.ordinal)
    && value.ordinal >= 0
}

function usesExternalProtocolUrl(rawUrl: string): boolean {
  try {
    return !['http:', 'https:', 'javascript:', 'blob:', 'data:', 'about:']
      .includes(new URL(rawUrl).protocol.toLowerCase())
  } catch {
    return true
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * Register the Playwright provider with `ctx.browserRuntime` and report the
 * launch facts an operator needs before the first tool call.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const provider = new PlaywrightBrowserProvider(config)
  ctx.browserRuntime.registerProvider(provider)
  const logger = ctx.logger('browser-runtime')
  const installation = readChromiumInstallation()
  for (const line of provider.startupReport(installation)) logger.info(line)
  if (!installation.installed) logger.warn(chromiumMissingMessage(installation))
}
