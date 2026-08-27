import { setTimeout as delay } from 'node:timers/promises'
import {
  BrowserCheckpointRef,
  BrowserPageId,
  BrowserProviderId,
  BrowserProviderTargetStaleError,
} from 'dsh-browser-runtime'
import type {
  BrowserExtraction,
  BrowserProvider,
  BrowserProviderAction,
  BrowserProviderCapabilities,
  BrowserProviderCheckpoint,
  BrowserProviderEnvironment,
  BrowserProviderExtractRequest,
  BrowserProviderObservation,
  BrowserProviderTarget,
  BrowserProviderOpenRequest,
  BrowserProviderRestoreRequest,
  BrowserCheckpointRef as BrowserCheckpointRefType,
} from 'dsh-browser-runtime'

interface FakeProviderOptions {
  readonly id?: string
  readonly capabilities?: Partial<BrowserProviderCapabilities>
  readonly openDelayMs?: number
  readonly actionDelayMs?: number
  readonly actionError?: Error
  readonly checkpointBarrier?: Promise<void>
  readonly checkpointError?: Error
  readonly closeError?: Error
  readonly available?: boolean
  readonly availabilityBarrier?: Promise<void>
}

interface FakeTarget {
  readonly key: string
}

/** Deterministic provider used by runtime and tool contract tests. */
export class FakeBrowserProvider implements BrowserProvider {
  readonly id
  readonly capabilities
  readonly environments: FakeEnvironment[] = []
  readonly destroyed: BrowserCheckpointRefType[] = []
  opens = 0
  restores = 0
  disposes = 0
  availabilityChecks = 0
  activeActions = 0
  maxActiveActions = 0
  private checkpointSequence = 0
  private readonly options: FakeProviderOptions

  constructor(options: FakeProviderOptions = {}) {
    this.options = options
    this.id = BrowserProviderId(options.id ?? 'fake')
    this.capabilities = {
      checkpoint: true,
      screenshot: true,
      extraction: true,
      multiplePages: false,
      attachExisting: false,
      persistentProfile: false,
      networkEvents: false,
      ...options.capabilities,
    }
  }

  async available(): Promise<boolean> {
    this.availabilityChecks += 1
    await this.options.availabilityBarrier
    return this.options.available ?? true
  }

  async open(request: BrowserProviderOpenRequest): Promise<BrowserProviderEnvironment> {
    this.opens += 1
    await this.waitForOpen(request.signal)
    return this.makeEnvironment(request)
  }

  async restore(request: BrowserProviderRestoreRequest): Promise<BrowserProviderEnvironment> {
    this.restores += 1
    await this.waitForOpen(request.signal)
    return this.makeEnvironment(request)
  }

  destroyCheckpoint(ref: BrowserCheckpointRefType): Promise<void> {
    this.destroyed.push(ref)
    return Promise.resolve()
  }

  dispose(): Promise<void> {
    this.disposes += 1
    return Promise.resolve()
  }

  nextCheckpoint(): BrowserCheckpointRefType {
    this.checkpointSequence += 1
    return BrowserCheckpointRef(`fake-checkpoint-${this.checkpointSequence}`)
  }

  async enterAction(): Promise<void> {
    this.activeActions += 1
    this.maxActiveActions = Math.max(this.maxActiveActions, this.activeActions)
    await delay(this.options.actionDelayMs ?? 0)
    this.activeActions -= 1
  }

  private async waitForOpen(signal: AbortSignal): Promise<void> {
    const delayMs = this.options.openDelayMs ?? 0
    if (delayMs > 0) await delay(delayMs, undefined, { signal })
    signal.throwIfAborted()
  }

  private makeEnvironment(request: BrowserProviderOpenRequest): FakeEnvironment {
    const environment = new FakeEnvironment(this, request, this.options)
    this.environments.push(environment)
    return environment
  }
}

/** Mutable single-page environment behind FakeBrowserProvider. */
export class FakeEnvironment implements BrowserProviderEnvironment {
  url = 'about:blank'
  title = ''
  text = 'Blank page'
  /** Reported candidate count; raise it to exercise element truncation. */
  totalElements = 7
  elementsTruncated = false
  closes = 0
  checkpoints = 0
  activeActions = 0
  maxActiveActions = 0
  private revision = 0

  constructor(
    private readonly provider: FakeBrowserProvider,
    readonly request: BrowserProviderOpenRequest,
    private readonly options: FakeProviderOptions,
  ) {}

  observe({ maxTextChars, signal }: { maxTextChars: number; signal: AbortSignal }): Promise<BrowserProviderObservation> {
    signal.throwIfAborted()
    this.revision += 1
    const body = this.text.slice(0, maxTextChars)
    return Promise.resolve({
      pageId: BrowserPageId('page-1'),
      url: this.url,
      title: this.title,
      text: body,
      truncated: body.length < this.text.length,
      totalTextChars: this.text.length,
      elements: [
        {
          kind: 'button',
          name: 'Advance',
          disabled: false,
          section: 'form',
          priority: 1,
          pagination: false,
          fingerprint: 'advance',
          target: { key: 'advance' } satisfies FakeTarget,
        },
        {
          kind: 'input:text',
          name: 'Name',
          disabled: false,
          inputType: 'text',
          section: 'form',
          priority: 1,
          pagination: false,
          fingerprint: 'name',
          target: { key: 'name' } satisfies FakeTarget,
        },
        {
          kind: 'input:password',
          name: 'Password',
          disabled: false,
          inputType: 'password',
          section: 'form',
          priority: 1,
          pagination: false,
          fingerprint: 'password',
          target: { key: 'password' } satisfies FakeTarget,
        },
        {
          kind: 'a',
          name: '51-100',
          disabled: false,
          section: 'navigation',
          priority: 1,
          pagination: true,
          fingerprint: 'page-2',
          target: { key: 'page-2' } satisfies FakeTarget,
        },
        {
          kind: 'a',
          name: 'A paper about browsers',
          disabled: false,
          section: 'record',
          priority: 3,
          pagination: false,
          groupKey: 'dl[dl]#0',
          groupLabel: 'A paper about browsers',
          fingerprint: 'record-0-title',
          target: { key: 'record-0-title' } satisfies FakeTarget,
        },
        {
          kind: 'a',
          name: 'Download PDF',
          disabled: false,
          section: 'record',
          priority: 5,
          pagination: false,
          groupKey: 'dl[dl]#0',
          groupLabel: 'A paper about browsers',
          fingerprint: 'record-0-pdf',
          target: { key: 'record-0-pdf' } satisfies FakeTarget,
        },
        {
          kind: 'a',
          name: 'Jane Author',
          disabled: false,
          section: 'record',
          priority: 5,
          pagination: false,
          groupKey: 'dl[dl]#1',
          groupLabel: 'Another paper',
          fingerprint: 'record-1-author',
          target: { key: 'record-1-author' } satisfies FakeTarget,
        },
      ],
      elementsTruncated: this.elementsTruncated,
      totalElements: this.totalElements,
    })
  }

  async act(action: BrowserProviderAction, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.activeActions += 1
    this.maxActiveActions = Math.max(this.maxActiveActions, this.activeActions)
    try {
      await this.provider.enterAction()
      signal.throwIfAborted()
      if (this.options.actionError !== undefined) throw this.options.actionError
      if (action.type === 'navigate') {
        this.url = action.url
        this.title = 'Fake page'
        this.text = `Page at ${action.url}`
        return
      }
      if (action.type === 'history' || action.type === 'reload') {
        this.text = `${action.type === 'reload' ? 'Reloaded' : action.direction} ${this.revision}`
        return
      }
      if (action.target !== undefined && !isValidTarget(action.target)) {
        throw new BrowserProviderTargetStaleError()
      }
      switch (action.type) {
        case 'click': this.text = `Advanced ${this.revision}`; return
        case 'fill': this.text = `Filled ${action.value.length} characters`; return
        case 'press': this.text = `Pressed ${action.key}`; return
        case 'select': this.text = `Selected ${action.values.join(',')}`; return
        case 'check': this.text = `Checked ${action.checked}`; return
        case 'scroll': this.text = `Scrolled ${action.to} ${action.pages}`; return
        case 'wait': this.text = `Waited for ${action.until}`
      }
    } finally {
      this.activeActions -= 1
    }
  }

  extract(request: BrowserProviderExtractRequest): Promise<BrowserExtraction> {
    request.signal.throwIfAborted()
    if (request.region !== undefined && !isValidTarget(request.region)) {
      throw new BrowserProviderTargetStaleError()
    }
    const columns = ['index', 'title', 'url', 'text']
    const rows = Array.from({ length: Math.min(request.limit, 3) }, (_row, index) => ({
      index: String(index),
      title: `Record ${index}`,
      url: `${this.url}#${index}`,
      text: `Body of record ${index}`.slice(0, request.maxTextChars),
    }))
    return Promise.resolve({ kind: request.kind, columns, rows, total: 3, truncated: rows.length < 3 })
  }

  screenshot({ signal }: { fullPage: boolean; signal: AbortSignal }): Promise<Uint8Array> {
    signal.throwIfAborted()
    return Promise.resolve(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10))
  }

  async checkpoint(signal: AbortSignal): Promise<BrowserProviderCheckpoint> {
    signal.throwIfAborted()
    this.checkpoints += 1
    await this.options.checkpointBarrier
    signal.throwIfAborted()
    if (this.options.checkpointError !== undefined) throw this.options.checkpointError
    return {
      ref: this.provider.nextCheckpoint(),
      coverage: ['cookies', 'local-storage'],
    }
  }

  close(): Promise<void> {
    this.closes += 1
    if (this.options.closeError !== undefined) return Promise.reject(this.options.closeError)
    return Promise.resolve()
  }
}

function isValidTarget(target: BrowserProviderTarget): boolean {
  const value: unknown = target.target
  return typeof value === 'object'
    && value !== null
    && 'key' in value
    && typeof value.key === 'string'
    && value.key === target.fingerprint
}
