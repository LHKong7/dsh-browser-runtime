/** Isolated Playwright/Chromium provider with bounded observations and storage-state checkpoints. */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from 'playwright'
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
import { NetworkPolicy } from './network-policy.ts'

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
  /** Explicit Chromium executable; omission uses Playwright's managed browser. */
  readonly executablePath?: string
  /** Navigation timeout in milliseconds. */
  readonly navigationTimeoutMs?: number
  /** Click, fill, observation, and screenshot timeout in milliseconds. */
  readonly actionTimeoutMs?: number
  /** Maximum interactive elements returned by one observation. */
  readonly maxElements?: number
  /** Permit loopback, link-local, and private network destinations. */
  readonly allowPrivateNetwork?: boolean
  /** Provider-private checkpoint directory. */
  readonly checkpointRoot?: string
}

interface ResolvedConfig {
  readonly headless: boolean
  readonly executablePath?: string
  readonly navigationTimeoutMs: number
  readonly actionTimeoutMs: number
  readonly maxElements: number
  readonly allowPrivateNetwork: boolean
  readonly checkpointRoot: string
}

interface ElementSnapshot {
  readonly ordinal: number
  readonly kind: string
  readonly name: string
  readonly disabled: boolean
  readonly inputType?: string
  readonly fingerprint: string
}

interface PlaywrightTarget {
  readonly ordinal: number
}

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
  executablePath: z.string(),
  navigationTimeoutMs: z.number().default(30_000),
  actionTimeoutMs: z.number().default(10_000),
  maxElements: z.number().default(100),
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

  /** Return true when the configured or Playwright-managed Chromium executable exists. */
  available(): boolean {
    return existsSync(this.config.executablePath ?? chromium.executablePath())
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
    try {
      browser = await chromium.launch({
        headless: this.config.headless,
        ...(this.config.executablePath === undefined ? {} : { executablePath: this.config.executablePath }),
        env: chromiumEnvironment(controlHome),
      })
      request.signal.throwIfAborted()
      context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
        ...(storageState === undefined ? {} : { storageState }),
      })
      const policy = new NetworkPolicy({ allowPrivateNetwork: this.config.allowPrivateNetwork })
      const environment = new PlaywrightEnvironment(browser, context, controlHome, policy, this.config)
      await environment.initialize(request.signal)
      return environment
    } catch (error: unknown) {
      const cleanupFailures: unknown[] = []
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

/** One Playwright browser/context/page owned by the runtime. */
class PlaywrightEnvironment implements BrowserProviderEnvironment {
  private page: Page | undefined
  private closePromise: Promise<void> | undefined
  private lastBlockedUrl: string | undefined

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly controlHome: string,
    private readonly policy: NetworkPolicy,
    private readonly config: ResolvedConfig,
  ) {}

  async initialize(signal: AbortSignal): Promise<void> {
    await this.context.route('**/*', async (route) => {
      try {
        await this.policy.assertAllowed(route.request().url())
        await route.continue()
      } catch (error: unknown) {
        this.lastBlockedUrl = route.request().url()
        await route.abort('blockedbyclient')
      }
    })
    this.page = await this.context.newPage()
    this.page.setDefaultTimeout(this.config.actionTimeoutMs)
    this.page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs)
    this.page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}) })
    this.context.on('page', page => {
      if (page !== this.page) void page.close().catch(() => {})
    })
    signal.throwIfAborted()
  }

  async observe(request: { maxTextChars: number; signal: AbortSignal }): Promise<BrowserProviderObservation> {
    return this.run(request.signal, async () => {
      const page = this.requirePage()
      const [title, bodyText, elements] = await Promise.all([
        page.title(),
        page.locator('body').innerText().catch(() => ''),
        page.locator(INTERACTIVE_SELECTOR).evaluateAll(snapshotElements, this.config.maxElements),
      ])
      const truncated = bodyText.length > request.maxTextChars
      return {
        pageId: BrowserPageId('page-1'),
        url: page.url(),
        title,
        text: truncated ? bodyText.slice(0, request.maxTextChars) : bodyText,
        truncated,
        elements: elements.map((element): BrowserProviderElement => ({
          kind: element.kind,
          name: element.name,
          disabled: element.disabled,
          ...(element.inputType === undefined ? {} : { inputType: element.inputType }),
          fingerprint: element.fingerprint,
          target: { ordinal: element.ordinal } satisfies PlaywrightTarget,
        })),
      }
    })
  }

  async act(action: BrowserProviderAction, signal: AbortSignal): Promise<void> {
    await this.run(signal, async () => {
      const page = this.requirePage()
      if (action.type === 'navigate') {
        await this.policy.assertAllowed(action.url)
        this.lastBlockedUrl = undefined
        try {
          await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
        } catch (error: unknown) {
          if (this.lastBlockedUrl !== undefined) {
            throw new BrowserProviderPolicyError(`browser blocked request to ${this.lastBlockedUrl}`, { cause: error })
          }
          throw error
        }
        return
      }
      const locator = await this.resolveTarget(action.target)
      if (action.type === 'click') {
        await locator.click({ timeout: this.config.actionTimeoutMs })
      } else {
        await locator.fill(action.value, { timeout: this.config.actionTimeoutMs })
      }
    })
  }

  screenshot(options: { fullPage: boolean; signal: AbortSignal }): Promise<Uint8Array> {
    return this.run(options.signal, async () => {
      const data = await this.requirePage().screenshot({
        type: 'png',
        fullPage: options.fullPage,
        timeout: this.config.actionTimeoutMs,
      })
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

  private async resolveTarget(target: BrowserProviderTarget): Promise<Locator> {
    if (!isPlaywrightTarget(target.target)) throw new BrowserProviderTargetStaleError()
    const locator = this.requirePage().locator(INTERACTIVE_SELECTOR).nth(target.target.ordinal)
    let fingerprint: string
    try {
      fingerprint = await locator.evaluate(snapshotFingerprint)
    } catch (error: unknown) {
      throw new BrowserProviderTargetStaleError(`the observed element is no longer present: ${String(error)}`)
    }
    if (fingerprint !== target.fingerprint) throw new BrowserProviderTargetStaleError()
    return locator
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
      if (abortCleanup !== undefined) await abortCleanup.catch(() => {})
      if (signal.aborted) signal.throwIfAborted()
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async runClose(): Promise<void> {
    const failures: unknown[] = []
    try { await this.context.close() } catch (error: unknown) { failures.push(error) }
    try { await this.browser.close() } catch (error: unknown) { failures.push(error) }
    try { await removeControlHome(this.controlHome) } catch (error: unknown) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'Playwright environment cleanup failed')
  }

  private requirePage(): Page {
    if (this.page === undefined || this.page.isClosed()) throw new Error('Playwright page is closed')
    return this.page
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const navigationTimeoutMs = config.navigationTimeoutMs ?? 30_000
  const actionTimeoutMs = config.actionTimeoutMs ?? 10_000
  const maxElements = config.maxElements ?? 100
  for (const [key, value] of Object.entries({ navigationTimeoutMs, actionTimeoutMs, maxElements })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`browser-playwright: ${key} must be a positive integer`)
  }
  if (config.executablePath !== undefined && !isAbsolute(config.executablePath)) {
    throw new Error('browser-playwright: executablePath must be absolute')
  }
  return {
    headless: config.headless ?? true,
    ...(config.executablePath === undefined ? {} : { executablePath: config.executablePath }),
    navigationTimeoutMs,
    actionTimeoutMs,
    maxElements,
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

function snapshotElements(nodes: Element[], maxElements: number): ElementSnapshot[] {
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
    const fingerprint = JSON.stringify({ tag, role: role ?? '', inputType: inputType ?? '', name })
    return {
      ordinal,
      kind,
      name,
      disabled,
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

function snapshotFingerprint(node: Element): string {
  if (!(node instanceof HTMLElement)) return ''
  const tag = node.tagName.toLowerCase()
  const role = node.getAttribute('role')?.trim().toLowerCase()
  const inputType = node instanceof HTMLInputElement ? (node.type || 'text').toLowerCase() : undefined
  const candidate = node.getAttribute('aria-label')
    ?? node.getAttribute('title')
    ?? node.getAttribute('alt')
    ?? node.getAttribute('placeholder')
    ?? node.textContent
    ?? ''
  const name = candidate.replace(/\s+/g, ' ').trim().slice(0, 200)
  return JSON.stringify({ tag, role: role ?? '', inputType: inputType ?? '', name })
}

function isPlaywrightTarget(value: unknown): value is PlaywrightTarget {
  return typeof value === 'object'
    && value !== null
    && 'ordinal' in value
    && typeof value.ordinal === 'number'
    && Number.isInteger(value.ordinal)
    && value.ordinal >= 0
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/** Register the Playwright provider with `ctx.browserRuntime`. */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.browserRuntime.registerProvider(new PlaywrightBrowserProvider(config))
}

export default apply
