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
import type { ElementSnapshot } from './page-snapshot.ts'
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
import {
  BrowserProviderCheckpointMissingError,
  BrowserProviderPolicyError,
  BrowserProviderTargetStaleError,
} from '../runtime/error.ts'
import { BrowserCheckpointRef, BrowserPageId, BrowserProviderId } from '../runtime/types.ts'
import type {
  BrowserExtraction,
  BrowserProvider,
  BrowserProviderAction,
  BrowserProviderCheckpoint,
  BrowserProviderElement,
  BrowserProviderEnvironment,
  BrowserProviderExtractRequest,
  BrowserProviderObservation,
  BrowserProviderObserveRequest,
  BrowserProviderOpenRequest,
  BrowserProviderRestoreRequest,
  BrowserProviderTarget,
  BrowserCheckpointRef as BrowserCheckpointRefType,
} from '../runtime/types.ts'
import type {} from '../runtime/runtime.ts'
import { chromiumMissingMessage, defaultCheckpointRoot, readChromiumInstallation } from './chromium.ts'
import {
  extractStructuredContent,
  scrollViewport,
  snapshotBodyText,
  snapshotElements,
  snapshotScreenshotLayout,
} from './page-snapshot.ts'
import {
  NetworkPolicy,
  routeWebSocketWithNetworkPolicy,
  routeWithNetworkPolicy,
  usesPolicyProxy,
} from './network-policy.ts'
import type { NetworkPolicyConfig, NetworkPolicyMode } from './network-policy.ts'
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
  /**
   * Egress policy. `strict` admits only public unicast destinations;
   * `allowlist` adds named hosts and CIDRs while keeping the policy proxy, DNS
   * pinning, and the Chromium egress restrictions; `unrestricted` removes them.
   */
  readonly network?: NetworkPolicyConfigInput
  /**
   * Deprecated coarse switch retained for existing profiles. `true` is
   * equivalent to `network.mode: unrestricted`; prefer the allowlist.
   * @deprecated use `network` instead.
   */
  readonly allowPrivateNetwork?: boolean
  /** Provider-private checkpoint directory. */
  readonly checkpointRoot?: string
}

/** Egress policy as a profile writes it. */
export interface NetworkPolicyConfigInput {
  readonly mode?: NetworkPolicyMode
  readonly allowHosts?: string[]
  readonly allowCidrs?: string[]
  readonly denyCidrs?: string[]
}

interface ResolvedConfig {
  readonly headless: boolean
  readonly navigationTimeoutMs: number
  readonly actionTimeoutMs: number
  readonly maxElements: number
  readonly maxScreenshotPixels: number
  readonly maxScreenshotBytes: number
  readonly network: NetworkPolicyConfig
  readonly checkpointRoot: string
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
  network: z.object({
    mode: z.union(['strict', 'allowlist', 'unrestricted'] as const).default('strict'),
    allowHosts: z.array(z.string()).default([]),
    allowCidrs: z.array(z.string()).default([]),
    denyCidrs: z.array(z.string()).default([]),
  }),
  allowPrivateNetwork: z.boolean().default(false),
  checkpointRoot: z.string(),
})

/** Playwright implementation of the BrowserProvider interface. */
export class PlaywrightBrowserProvider implements BrowserProvider {
  readonly id = PLAYWRIGHT_PROVIDER_ID
  /**
   * The pinned Playwright version. Checkpoint payloads are Playwright storage
   * state, so a payload written by another build is not this build's to read.
   */
  readonly version = readChromiumInstallation().playwrightVersion
  readonly capabilities = {
    checkpoint: true,
    screenshot: true,
    extraction: true,
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
      `networkPolicy=${this.config.network.mode}`,
      ...(this.config.network.mode === 'allowlist'
        ? [`networkAllow=${describeAllowance(this.config.network)}`]
        : []),
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
      const policy = new NetworkPolicy(this.config.network)
      if (usesPolicyProxy(policy.mode)) networkProxy = new NetworkPolicyProxy(policy)
      const proxy = await networkProxy?.listen(request.signal)
      browser = await chromium.launch({
        headless: this.config.headless,
        env: chromiumEnvironment(controlHome),
        ...(proxy === undefined ? {} : { proxy }),
        args: ['--deny-permission-prompts', ...chromiumNetworkArgs(this.config.network.mode)],
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
    let raw: string
    try {
      raw = await readFile(this.checkpointPath(ref), 'utf8')
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new BrowserProviderCheckpointMissingError(`Playwright checkpoint payload ${ref} no longer exists`)
      }
      throw error
    }
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

  async observe(request: BrowserProviderObserveRequest): Promise<BrowserProviderObservation> {
    return this.run(request.signal, async () => {
      const page = this.requirePage()
      const maxElements = request.maxElements === undefined
        ? this.config.maxElements
        : Math.min(Math.max(Math.trunc(request.maxElements), 0), this.config.maxElements)
      const [title, body, snapshot] = await Promise.all([
        page.title(),
        page.locator('body').evaluate(snapshotBodyText, request.maxTextChars)
          .catch(() => ({ text: '', truncated: false, totalChars: 0 })),
        page.locator(INTERACTIVE_SELECTOR).evaluateAll(snapshotElements, maxElements),
      ])
      return {
        pageId: BrowserPageId('page-1'),
        url: page.url(),
        title,
        text: body.text,
        truncated: body.truncated,
        totalTextChars: body.totalChars,
        elements: snapshot.elements.map((element): BrowserProviderElement => ({
          kind: element.kind,
          name: element.name,
          disabled: element.disabled,
          ...(element.inputType === undefined ? {} : { inputType: element.inputType }),
          section: element.section,
          priority: element.priority,
          pagination: element.pagination,
          ...(element.groupKey === undefined ? {} : { groupKey: element.groupKey }),
          ...(element.groupLabel === undefined ? {} : { groupLabel: element.groupLabel }),
          fingerprint: element.fingerprint,
          target: {
            ordinal: element.ordinal,
            opensNewPage: element.opensNewPage,
          } satisfies PlaywrightTarget,
        })),
        elementsTruncated: snapshot.total > snapshot.elements.length,
        totalElements: snapshot.total,
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
        await this.dispatch(page, action)
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

  /**
   * Run one resolved Provider action against the single owned Page.
   *
   * Every element-addressed action revalidates its opaque target first, so a
   * page that changed since the observation fails as stale rather than acting
   * on a different element.
   */
  private async dispatch(page: Page, action: BrowserProviderAction): Promise<void> {
    switch (action.type) {
      case 'navigate': {
        await this.policy.assertAllowed(action.url)
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
        return
      }
      case 'history': {
        const moved = action.direction === 'back'
          ? await page.goBack({ waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
          : await page.goForward({ waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
        if (moved === null) {
          throw new BrowserProviderPolicyError(
            `browser has no ${action.direction} entry in this environment's session history`,
          )
        }
        return
      }
      case 'reload': {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
        return
      }
      case 'scroll': {
        if (action.to === 'element') {
          const target = await this.resolveTarget(requireTarget(action.target))
          await target.locator.scrollIntoViewIfNeeded({ timeout: this.config.actionTimeoutMs })
          return
        }
        await page.evaluate(scrollViewport, { to: action.to, pages: action.pages })
        return
      }
      case 'wait': {
        const timeout = Math.min(action.timeoutMs ?? this.config.actionTimeoutMs, this.config.navigationTimeoutMs)
        if (action.until === 'load') {
          await page.waitForLoadState('load', { timeout })
          return
        }
        if (action.until === 'network-idle') {
          await page.waitForLoadState('networkidle', { timeout })
          return
        }
        const target = await this.resolveTarget(requireTarget(action.target))
        await target.locator.waitFor({
          state: action.until === 'element-visible' ? 'visible' : 'hidden',
          timeout,
        })
        return
      }
      case 'press': {
        if (action.target === undefined) {
          await page.keyboard.press(action.key)
          return
        }
        const target = await this.assertActionable(action.target)
        await target.locator.press(action.key, { timeout: this.config.actionTimeoutMs })
        return
      }
      case 'click': {
        const target = await this.assertActionable(action.target)
        if (target.externalProtocol) throw new BrowserProviderPolicyError(EXTERNAL_PROTOCOL_POLICY_MESSAGE)
        if (target.opensNewPage) throw new BrowserProviderPolicyError(NEW_PAGE_POLICY_MESSAGE)
        if (target.downloads) throw new BrowserProviderPolicyError(DOWNLOAD_POLICY_MESSAGE)
        await target.locator.click({ timeout: this.config.actionTimeoutMs })
        return
      }
      case 'fill': {
        const target = await this.assertActionable(action.target)
        await target.locator.fill(action.value, { timeout: this.config.actionTimeoutMs })
        return
      }
      case 'select': {
        const target = await this.assertActionable(action.target)
        await target.locator.selectOption([...action.values], { timeout: this.config.actionTimeoutMs })
        return
      }
      case 'check': {
        const target = await this.assertActionable(action.target)
        if (action.checked) await target.locator.check({ timeout: this.config.actionTimeoutMs })
        else await target.locator.uncheck({ timeout: this.config.actionTimeoutMs })
        return
      }
    }
  }

  /** Revalidate one opaque target and reject the element kinds policy forbids. */
  private async assertActionable(target: BrowserProviderTarget): Promise<ResolvedPlaywrightTarget> {
    const resolved = await this.resolveTarget(target)
    if (resolved.inputType === 'file') throw new BrowserProviderPolicyError(FILE_CHOOSER_POLICY_MESSAGE)
    return resolved
  }

  async extract(request: BrowserProviderExtractRequest): Promise<BrowserExtraction> {
    return this.run(request.signal, async () => {
      const page = this.requirePage()
      const scope = request.region === undefined
        ? page.locator('body')
        : (await this.resolveTarget(request.region)).locator
      const result = await scope.evaluate(extractStructuredContent, {
        kind: request.kind,
        limit: request.limit,
        maxTextChars: request.maxTextChars,
      })
      return {
        kind: request.kind,
        url: page.url(),
        columns: result.columns,
        rows: result.rows,
        total: result.total,
        truncated: result.total > result.rows.length,
      }
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
      snapshot = (await locator.evaluateAll(snapshotElements, 1)).elements[0]
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
    network: resolveNetworkConfig(config),
    checkpointRoot: resolve(config.checkpointRoot ?? defaultCheckpointRoot(resolveDshHome())),
  }
}

/**
 * Fold the deprecated `allowPrivateNetwork` switch into the egress policy.
 *
 * The old switch is coarse: it removed the policy proxy and every Chromium
 * egress restriction to reach one private host. It still maps to
 * `unrestricted` so existing profiles keep working, but combining it with an
 * explicit mode is a contradiction rather than a merge.
 */
function resolveNetworkConfig(config: Config): NetworkPolicyConfig {
  const requested = config.network
  if (config.allowPrivateNetwork === true) {
    if (requested?.mode !== undefined && requested.mode !== 'unrestricted') {
      throw new Error(
        `browser-playwright: allowPrivateNetwork conflicts with network.mode "${requested.mode}"; set only network`,
      )
    }
    return {
      mode: 'unrestricted',
      allowHosts: requested?.allowHosts ?? [],
      allowCidrs: requested?.allowCidrs ?? [],
      denyCidrs: requested?.denyCidrs ?? [],
    }
  }
  return {
    mode: requested?.mode ?? 'strict',
    allowHosts: requested?.allowHosts ?? [],
    allowCidrs: requested?.allowCidrs ?? [],
    denyCidrs: requested?.denyCidrs ?? [],
  }
}

/** One-line summary of what an allowlist admits beyond public unicast. */
function describeAllowance(network: NetworkPolicyConfig): string {
  const entries = [...(network.allowHosts ?? []), ...(network.allowCidrs ?? [])]
  const denied = network.denyCidrs ?? []
  const allowed = entries.length === 0 ? 'none' : entries.join(',')
  return denied.length === 0 ? allowed : `${allowed} deny=${denied.join(',')}`
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

/** A Provider action reached an element path without the target the Runtime should have resolved. */
function requireTarget(target: BrowserProviderTarget | undefined): BrowserProviderTarget {
  if (target === undefined) throw new BrowserProviderTargetStaleError('the action lost its element reference')
  return target
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
