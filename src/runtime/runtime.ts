/** Provider-neutral ownership, lifecycle, observation, transition, and checkpoint control plane. */

import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  BrowserRuntimeError,
  BrowserProviderCheckpointMissingError,
  BrowserProviderPolicyError,
  BrowserProviderTargetStaleError,
  errorEvidence,
} from './error.ts'
import { browserRuntimeDomainSpec, transitionRecord } from './metadata.ts'
import type { BrowserTransitionRecord } from './metadata.ts'
import { SerialExecutor, waitWithSignal } from './serial.ts'
import {
  BrowserCheckpointRef,
  BrowserElementGroupRef,
  BrowserElementRef,
  BrowserEnvironmentId,
  BrowserObservationId,
  BrowserProviderId,
  BrowserTransitionId,
} from './types.ts'
import type {
  BrowserAcquireRequest,
  BrowserAction,
  BrowserCapability,
  BrowserCheckpointRecord,
  BrowserElement,
  BrowserElementGroup,
  BrowserEnvironmentLease,
  BrowserExtraction,
  BrowserExtractRequest,
  BrowserObservation,
  BrowserObserveOptions,
  BrowserPersistence,
  BrowserProvider,
  BrowserProviderAction,
  BrowserProviderCapabilities,
  BrowserProviderEnvironment,
  BrowserProviderId as BrowserProviderIdType,
  BrowserProviderInfo,
  BrowserProviderTarget,
  BrowserRecordedAction,
  BrowserScreenshot,
  BrowserScreenshotOptions,
  BrowserSessionId,
  BrowserTransition,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserRuntime: BrowserRuntime
  }
}

/** Runtime selection, observation, evidence, and teardown bounds. */
export interface Config {
  /** Explicit provider id; omission auto-selects exactly one available provider. */
  readonly provider?: string
  /** Maximum page-text characters retained in each observation. */
  readonly maxTextChars?: number
  /** Maximum transition records retained in process memory. */
  readonly maxTransitionsInMemory?: number
  /** Maximum time allowed for a shutdown checkpoint before provider close proceeds. */
  readonly cleanupTimeoutMs?: number
  /** Age at which a stored checkpoint is dropped; `0` retains it indefinitely. */
  readonly checkpointTtlMs?: number
  /** Maximum stored checkpoints; the oldest beyond this are dropped. */
  readonly maxCheckpoints?: number
}

interface ResolvedConfig {
  readonly provider?: BrowserProviderIdType
  readonly maxTextChars: number
  readonly maxTransitionsInMemory: number
  readonly cleanupTimeoutMs: number
  readonly checkpointTtlMs: number
  readonly maxCheckpoints: number
}

interface EnvironmentSlot {
  readonly owner: object
  readonly sessionId: BrowserSessionId
  readonly environmentId: BrowserEnvironmentId
  readonly persistence: BrowserPersistence
  readonly requestedProviderId?: BrowserProviderIdType
  readonly requiredCapabilities: readonly BrowserCapability[]
  readonly opening: AbortController
  ready: Promise<ActiveEnvironment>
  providerId?: BrowserProviderIdType
  refs: number
  pendingAcquires: number
  closing?: Promise<void>
}

interface BoundElement {
  readonly view: BrowserElement
  readonly provider: BrowserProviderTarget
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-runtime'

/** Runtime service configuration schema. */
export const Config: z<Config> = z.object({
  provider: z.string(),
  maxTextChars: z.number().default(60_000),
  maxTransitionsInMemory: z.number().default(500),
  cleanupTimeoutMs: z.number().default(10_000),
  checkpointTtlMs: z.number().default(0),
  maxCheckpoints: z.number().default(100),
})

const EMPTY_CAPABILITIES: BrowserProviderCapabilities = {
  checkpoint: false,
  screenshot: false,
  extraction: false,
  multiplePages: false,
  attachExisting: false,
  persistentProfile: false,
  networkEvents: false,
}

/** Stateful browser environment service registered as `ctx.browserRuntime`. */
export class BrowserRuntime extends Service {
  static Config = Config

  private readonly config: ResolvedConfig
  private readonly providers = new Map<BrowserProviderIdType, BrowserProvider>()
  private readonly slots = new Map<object, EnvironmentSlot>()
  private readonly checkpoints = new Map<BrowserSessionId, BrowserCheckpointRecord>()
  /** Per-session commit tails; a cancelled waiter cannot expose a gap before its predecessor settles. */
  private readonly checkpointTransactions = new Map<BrowserSessionId, Promise<void>>()
  private readonly transitions: BrowserTransitionRecord[] = []
  private metadataDomain: Domain<typeof browserRuntimeDomainSpec> | undefined
  private awaitMetadataBinding: () => Promise<void> = () => Promise.resolve()
  private state: 'active' | 'closing' | 'closed' = 'active'

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'browserRuntime')
    this.config = resolveConfig(config)

    const storageFiber = ctx.inject(['storageDomain'], async (storageCtx: Context) => {
      const domain = await storageCtx.storageDomain.open(browserRuntimeDomainSpec)
      for (const [sessionId, checkpoint] of domain.table('checkpoints').entries()) {
        this.checkpoints.set(sessionId, checkpoint)
      }
      this.metadataDomain = domain
      await this.pruneCheckpoints()
      storageCtx.effect(() => async () => {
        if (this.metadataDomain === domain) this.metadataDomain = undefined
        await domain.close()
      }, 'browserRuntime.metadataDomain()')
    })
    this.awaitMetadataBinding = async () => {
      if (ctx.get('storageDomain') !== undefined) await storageFiber.await()
    }

    ctx.effect(() => async () => {
      await this.disposeRuntime()
      await storageFiber.dispose()
    }, 'browserRuntime.teardown()')
  }

  /**
   * Register one provider. Registration is effect-scoped; disposing it first
   * removes the provider from selection, then settles selection/opening work,
   * closes its environments, and finally disposes provider-wide resources.
   * @param provider - provider implementation keyed by its opaque id.
   * @returns asynchronous disposer that reaches provider quiescence.
   */
  registerProvider(provider: BrowserProvider): () => Promise<void> {
    if (this.providers.has(provider.id)) {
      throw new BrowserRuntimeError(
        `a browser provider with id "${provider.id}" is already registered`,
        'BROWSER_DUPLICATE_PROVIDER',
      )
    }
    if (provider.capabilities.checkpoint) requireCheckpointProvider(provider)
    return this.ctx.effect(function* (this: BrowserRuntime) {
      this.providers.set(provider.id, provider)
      yield () => this.removeProvider(provider)
    }.bind(this), 'browserRuntime.registerProvider()')
  }

  /**
   * Resolve and acquire one owner environment. Concurrent calls for the same
   * exact owner share setup and receive independent leases; different owners
   * never share state. Caller cancellation rejects only that caller's wait;
   * the owner slot retains setup ownership while another caller remains.
   * @param request - owner, durable session identity, policy, and cancellation.
   * @returns a holder capability over the active environment.
   */
  async acquire(request: BrowserAcquireRequest): Promise<BrowserEnvironmentLease> {
    this.assertActive()
    request.signal?.throwIfAborted()
    await this.awaitMetadataBinding()
    this.assertActive()
    request.signal?.throwIfAborted()
    let slot = this.slots.get(request.owner)
    if (slot === undefined) {
      const environmentId = BrowserEnvironmentId(`browser-${randomUUID()}`)
      const requestedProviderId = request.providerId ?? this.config.provider
      slot = {
        owner: request.owner,
        sessionId: request.sessionId,
        environmentId,
        persistence: request.persistence,
        ...(requestedProviderId === undefined ? {} : { requestedProviderId }),
        requiredCapabilities: [...new Set(request.requiredCapabilities ?? [])],
        opening: new AbortController(),
        ready: Promise.resolve(undefined as never),
        refs: 0,
        pendingAcquires: 0,
      }
      this.slots.set(request.owner, slot)
      slot.ready = this.openEnvironment(slot)
      void slot.ready.catch(() => {
        if (this.slots.get(request.owner) === slot) this.slots.delete(request.owner)
      })
    } else {
      this.assertCompatibleOwnerRequest(slot, request)
      if (slot.closing !== undefined) {
        throw new BrowserRuntimeError('browser environment is closing', 'BROWSER_ENVIRONMENT_CLOSED')
      }
    }

    slot.pendingAcquires += 1
    try {
      const environment = await waitWithSignal(slot.ready, request.signal)
      assertCapabilities(environment.provider.capabilities, request.requiredCapabilities ?? [])
      slot.refs += 1
      return this.createLease(slot, environment)
    } finally {
      slot.pendingAcquires -= 1
      if (slot.pendingAcquires === 0 && slot.refs === 0) void this.closeSlot(slot).catch(error => {
        this.ctx.logger.warn(`browser environment cleanup failed: ${String(error)}`)
      })
    }
  }

  /** List registered providers and their current availability. */
  async listProviders(): Promise<readonly BrowserProviderInfo[]> {
    return Promise.all([...this.providers.values()].map(async provider => ({
      id: provider.id,
      capabilities: provider.capabilities,
      available: await providerAvailable(provider),
    })))
  }

  /** Return the current checkpoint index record for a session, if any. */
  checkpointFor(sessionId: BrowserSessionId): BrowserCheckpointRecord | undefined {
    return this.checkpoints.get(sessionId)
  }

  /** Every indexed checkpoint, newest first. */
  listCheckpoints(): readonly BrowserCheckpointRecord[] {
    return [...this.checkpoints.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /**
   * Drop checkpoints past the configured age or count, oldest first.
   *
   * A checkpoint for a live session is never dropped: its environment still
   * owns the payload. Payload deletion failures are logged rather than thrown,
   * because the index entry is already gone and retrying it would deadlock the
   * caller behind a Provider that cannot delete.
   * @returns the sessions whose checkpoints were removed.
   */
  async pruneCheckpoints(): Promise<readonly BrowserSessionId[]> {
    const live = new Set([...this.slots.values()].map(slot => slot.sessionId))
    const stored = [...this.checkpoints.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    const candidates = stored.filter(record => !live.has(record.sessionId))
    const cutoff = this.config.checkpointTtlMs === 0
      ? undefined
      : Date.now() - this.config.checkpointTtlMs
    const expired = cutoff === undefined
      ? []
      : candidates.filter(record => Date.parse(record.createdAt) < cutoff)
    // A live session's checkpoint counts against the limit but is never the one
    // dropped: its environment still owns the payload.
    const overLimit = stored.length - expired.length - this.config.maxCheckpoints
    const overflow = candidates
      .filter(record => !expired.includes(record))
      .slice(0, Math.max(overLimit, 0))
    const removed: BrowserSessionId[] = []
    for (const record of [...expired, ...overflow]) {
      try {
        await this.destroyCheckpoint(record.sessionId)
        removed.push(record.sessionId)
      } catch (error: unknown) {
        this.ctx.logger.warn(`browser checkpoint prune failed for "${record.sessionId}": ${String(error)}`)
      }
    }
    return removed
  }

  /**
   * Return retained transition metadata for one session in creation order.
   * Durable compact-index rows are merged with the bounded in-memory records.
   */
  listTransitions(sessionId: BrowserSessionId): readonly BrowserTransitionRecord[] {
    const merged = new Map<BrowserTransitionId, BrowserTransitionRecord>(
      this.metadataDomain === undefined
        ? []
        : this.metadataDomain.table('transitions').entries(),
    )
    for (const transition of this.transitions) merged.set(transition.id, transition)
    return [...merged.values()].filter(transition => transition.sessionId === sessionId)
  }

  /**
   * Delete one indexed checkpoint and its provider payload. A live environment
   * for the session must be released first.
   * @param sessionId - durable session checkpoint to remove.
   */
  async destroyCheckpoint(sessionId: BrowserSessionId): Promise<void> {
    if ([...this.slots.values()].some(slot => slot.sessionId === sessionId)) {
      throw new BrowserRuntimeError(
        `cannot destroy checkpoint for live browser session "${sessionId}"`,
        'BROWSER_OWNER_CONFLICT',
      )
    }
    const checkpoint = this.checkpoints.get(sessionId)
    if (checkpoint === undefined) return
    const provider = this.providers.get(checkpoint.providerId)
    if (provider === undefined) {
      throw new BrowserRuntimeError(
        `checkpoint provider "${checkpoint.providerId}" is not registered`,
        'BROWSER_PROVIDER_CONFIGURED_MISSING',
      )
    }
    if (this.metadataDomain !== undefined) await this.metadataDomain.table('checkpoints').delete(sessionId)
    this.checkpoints.delete(sessionId)
    await requireCheckpointProvider(provider).destroyCheckpoint(checkpoint.ref)
  }

  /** Remove one index entry whose provider payload no longer exists. */
  private async forgetCheckpoint(
    sessionId: BrowserSessionId,
    record: BrowserCheckpointRecord,
  ): Promise<void> {
    if (this.checkpoints.get(sessionId) !== record) return
    this.checkpoints.delete(sessionId)
    if (this.metadataDomain === undefined) return
    try {
      await this.metadataDomain.table('checkpoints').delete(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`browser checkpoint index cleanup failed for "${sessionId}": ${String(error)}`)
    }
  }

  private async openEnvironment(slot: EnvironmentSlot): Promise<ActiveEnvironment> {
    const signal = slot.opening.signal
    signal.throwIfAborted()
    const checkpoint = slot.persistence === 'resume' ? this.checkpoints.get(slot.sessionId) : undefined
    const provider = await this.resolveProvider(slot, checkpoint)
    signal.throwIfAborted()
    slot.providerId = provider.id
    assertCapabilities(provider.capabilities, slot.requiredCapabilities)
    if (slot.persistence === 'resume' && !provider.capabilities.checkpoint) {
      throw new BrowserRuntimeError(
        `browser provider "${provider.id}" does not support resume checkpoints`,
        'BROWSER_CAPABILITY_UNSUPPORTED',
      )
    }

    if (checkpoint !== undefined
      && provider.version !== undefined
      && checkpoint.providerVersion !== undefined
      && checkpoint.providerVersion !== provider.version) {
      throw new BrowserRuntimeError(
        `checkpoint for session "${slot.sessionId}" was written by browser provider "${provider.id}" `
        + `version ${checkpoint.providerVersion}, not the running ${provider.version}; `
        + 'destroy the checkpoint to start a fresh environment',
        'BROWSER_CHECKPOINT_VERSION_MISMATCH',
      )
    }

    let restored = checkpoint
    const generation = restored === undefined ? 1 : restored.generation + 1
    let backend: BrowserProviderEnvironment
    if (restored === undefined) {
      backend = await provider.open({ environmentId: slot.environmentId, sessionId: slot.sessionId, signal })
    } else {
      try {
        backend = await requireCheckpointProvider(provider).restore({
          environmentId: slot.environmentId,
          sessionId: slot.sessionId,
          signal,
          checkpoint: restored,
        })
      } catch (error: unknown) {
        // A payload cleared out of band leaves an index entry pointing at
        // nothing. Dropping the entry and opening fresh beats failing every
        // acquire for a session whose stored state no longer exists.
        if (!(error instanceof BrowserProviderCheckpointMissingError)) throw error
        this.ctx.logger.warn(
          `browser checkpoint payload for session "${slot.sessionId}" is gone; opening a fresh environment`,
        )
        await this.forgetCheckpoint(slot.sessionId, restored)
        restored = undefined
        signal.throwIfAborted()
        backend = await provider.open({ environmentId: slot.environmentId, sessionId: slot.sessionId, signal })
      }
    }
    if (provider.capabilities.checkpoint && backend.checkpoint === undefined) {
      const capabilityFailure = new BrowserRuntimeError(
        `browser provider "${provider.id}" returned an environment without checkpoint()`,
        'BROWSER_CHECKPOINT_UNAVAILABLE',
      )
      try {
        await backend.close()
      } catch (cleanupFailure: unknown) {
        throw new AggregateError(
          [capabilityFailure, cleanupFailure],
          `browser provider "${provider.id}" environment validation and cleanup failed`,
        )
      }
      throw capabilityFailure
    }
    if (slot.closing !== undefined || this.state !== 'active') {
      await backend.close()
      throw new BrowserRuntimeError('browser environment is closing', 'BROWSER_ENVIRONMENT_CLOSED')
    }
    return new ActiveEnvironment(this, slot, provider, backend, restored === undefined ? 1 : generation)
  }

  private async resolveProvider(
    slot: EnvironmentSlot,
    checkpoint: BrowserCheckpointRecord | undefined,
  ): Promise<BrowserProvider> {
    const requestedId = slot.requestedProviderId
    const checkpointId = checkpoint?.providerId
    if (requestedId !== undefined && checkpointId !== undefined && requestedId !== checkpointId) {
      throw new BrowserRuntimeError(
        `checkpoint belongs to provider "${checkpointId}", not requested provider "${requestedId}"`,
        'BROWSER_CHECKPOINT_PROVIDER_MISMATCH',
      )
    }
    const exactId = requestedId ?? checkpointId
    if (exactId !== undefined) {
      const provider = this.providers.get(exactId)
      if (provider === undefined) {
        throw new BrowserRuntimeError(
          `configured browser provider "${exactId}" is not registered`,
          'BROWSER_PROVIDER_CONFIGURED_MISSING',
        )
      }
      slot.providerId = provider.id
      const available = await providerAvailable(provider)
      slot.opening.signal.throwIfAborted()
      if (this.providers.get(exactId) !== provider) {
        throw new BrowserRuntimeError(
          `configured browser provider "${exactId}" is not registered`,
          'BROWSER_PROVIDER_CONFIGURED_MISSING',
        )
      }
      if (!available) {
        throw new BrowserRuntimeError(
          withProviderRemedy(`configured browser provider "${exactId}" is unavailable`, await providerRemedy(provider)),
          'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE',
        )
      }
      return provider
    }

    let candidates: readonly BrowserProvider[]
    let available: BrowserProvider[]
    do {
      candidates = [...this.providers.values()]
      available = []
      for (const provider of candidates) {
        slot.providerId = provider.id
        if (await providerAvailable(provider)) available.push(provider)
        slot.opening.signal.throwIfAborted()
      }
    } while (!sameProviderSnapshot(this.providers, candidates))
    if (available.length === 0) {
      delete slot.providerId
      const remedies: string[] = []
      for (const provider of candidates) {
        const remedy = await providerRemedy(provider)
        if (remedy !== undefined) remedies.push(`${provider.id}: ${remedy}`)
      }
      throw new BrowserRuntimeError(
        withProviderRemedy('no browser provider is available', remedies.join('\n') || undefined),
        'BROWSER_PROVIDER_UNAVAILABLE',
      )
    }
    if (available.length > 1) {
      delete slot.providerId
      throw new BrowserRuntimeError(
        `multiple browser providers are available: ${available.map(provider => provider.id).join(', ')}`,
        'BROWSER_PROVIDER_AMBIGUOUS',
      )
    }
    const selected = available[0] as BrowserProvider
    slot.providerId = selected.id
    return selected
  }

  private createLease(slot: EnvironmentSlot, environment: ActiveEnvironment): BrowserEnvironmentLease {
    let released = false
    return {
      environmentId: slot.environmentId,
      providerId: environment.provider.id,
      generation: environment.generation,
      observe: options => environment.observe(options),
      act: (action, signal) => environment.act(action, signal),
      screenshot: options => environment.screenshot(options),
      extract: request => environment.extract(request),
      checkpoint: signal => environment.checkpoint(signal),
      release: async () => {
        if (released) return
        released = true
        slot.refs -= 1
        if (slot.refs === 0 && slot.pendingAcquires === 0) await this.closeSlot(slot)
      },
    }
  }

  private closeSlot(slot: EnvironmentSlot): Promise<void> {
    slot.closing ??= (async () => {
      slot.opening.abort(new BrowserRuntimeError(
        'browser environment is closing',
        'BROWSER_ENVIRONMENT_CLOSED',
      ))
      try {
        let environment: ActiveEnvironment
        try {
          environment = await slot.ready
        } catch (error: unknown) {
          if (!isAbortFailure(slot.opening.signal, error)) throw error
          return
        }
        await environment.shutdown(slot.persistence)
      } finally {
        if (this.slots.get(slot.owner) === slot) this.slots.delete(slot.owner)
      }
    })()
    return slot.closing
  }

  private async removeProvider(provider: BrowserProvider): Promise<void> {
    if (this.providers.get(provider.id) !== provider) return
    this.providers.delete(provider.id)
    const owned = [...this.slots.values()].filter(slot => slot.providerId === provider.id)
    const settled = await Promise.allSettled(owned.map(slot => this.closeSlot(slot)))
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (provider.dispose !== undefined) {
      try {
        await provider.dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `browser provider "${provider.id}" cleanup failed`)
  }

  private assertCompatibleOwnerRequest(slot: EnvironmentSlot, request: BrowserAcquireRequest): void {
    const requestedProviderId = request.providerId ?? this.config.provider
    if (slot.sessionId !== request.sessionId
      || slot.persistence !== request.persistence
      || slot.requestedProviderId !== requestedProviderId) {
      throw new BrowserRuntimeError(
        'the browser owner already has an environment with different acquisition settings',
        'BROWSER_OWNER_CONFLICT',
      )
    }
  }

  private async saveCheckpoint(
    slot: EnvironmentSlot,
    provider: BrowserProvider,
    generation: number,
    backend: BrowserProviderEnvironment,
    signal: AbortSignal,
  ): Promise<BrowserCheckpointRecord> {
    if (backend.checkpoint === undefined) {
      throw new BrowserRuntimeError(
        `browser provider "${provider.id}" cannot create checkpoints`,
        'BROWSER_CHECKPOINT_UNAVAILABLE',
      )
    }
    const createCheckpoint = backend.checkpoint.bind(backend)
    const checkpointProvider = requireCheckpointProvider(provider)
    return this.runCheckpointTransaction(slot.sessionId, signal, async () => {
      const previous = this.checkpoints.get(slot.sessionId)
      if (previous !== undefined && previous.providerId !== provider.id) {
        throw new BrowserRuntimeError(
          `checkpoint belongs to provider "${previous.providerId}", not provider "${provider.id}"`,
          'BROWSER_CHECKPOINT_PROVIDER_MISMATCH',
        )
      }
      const payload = await createCheckpoint(signal)
      const record: BrowserCheckpointRecord = {
        sessionId: slot.sessionId,
        environmentId: slot.environmentId,
        generation,
        providerId: provider.id,
        ...(provider.version === undefined ? {} : { providerVersion: provider.version }),
        ref: BrowserCheckpointRef(payload.ref),
        coverage: [...payload.coverage],
        createdAt: new Date().toISOString(),
      }
      this.checkpoints.set(slot.sessionId, record)
      try {
        if (this.metadataDomain !== undefined) {
          await this.metadataDomain.table('checkpoints').put(slot.sessionId, record)
        }
      } catch (error: unknown) {
        if (previous === undefined) this.checkpoints.delete(slot.sessionId)
        else this.checkpoints.set(slot.sessionId, previous)
        const persistenceFailure = new BrowserRuntimeError(
          'browser checkpoint metadata could not be persisted',
          'BROWSER_CHECKPOINT_METADATA_FAILED',
          { cause: error },
        )
        try {
          await checkpointProvider.destroyCheckpoint(record.ref)
        } catch (rollbackError: unknown) {
          throw new AggregateError(
            [persistenceFailure, rollbackError],
            'browser checkpoint metadata commit and provider payload rollback failed',
          )
        }
        throw persistenceFailure
      }
      if (previous !== undefined && previous.ref !== record.ref && previous.providerId === provider.id) {
        try {
          await checkpointProvider.destroyCheckpoint(previous.ref)
        } catch (error: unknown) {
          this.ctx.logger.warn(`old browser checkpoint cleanup failed: ${String(error)}`)
        }
      }
      return record
    })
  }

  private async runCheckpointTransaction<T>(
    sessionId: BrowserSessionId,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.checkpointTransactions.get(sessionId) ?? Promise.resolve()
    let release = () => {}
    const turn = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => turn, () => turn)
    this.checkpointTransactions.set(sessionId, tail)
    void tail.then(() => {
      if (this.checkpointTransactions.get(sessionId) === tail) {
        this.checkpointTransactions.delete(sessionId)
      }
    })
    try {
      await waitWithSignal(previous, signal)
      signal.throwIfAborted()
      return await operation()
    } finally {
      release()
    }
  }

  private async saveTransition(transition: BrowserTransition): Promise<void> {
    const record = transitionRecord(transition)
    this.transitions.push(record)
    if (this.transitions.length > this.config.maxTransitionsInMemory) this.transitions.shift()
    if (this.metadataDomain === undefined) return
    try {
      await this.metadataDomain.table('transitions').put(record.id, record)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `browser transition "${record.id}" compact index write failed; retained in memory: ${String(error)}`,
      )
    }
  }

  private async disposeRuntime(): Promise<void> {
    if (this.state !== 'active') return
    this.state = 'closing'
    const settled = await Promise.allSettled([...this.slots.values()].map(slot => this.closeSlot(slot)))
    this.state = 'closed'
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'browser runtime cleanup failed')
  }

  private assertActive(): void {
    if (this.state !== 'active') {
      throw new BrowserRuntimeError('browser runtime is closing', 'BROWSER_ENVIRONMENT_CLOSED')
    }
  }

  /** @internal */
  observationTextLimit(requested?: number): number {
    if (requested === undefined || !Number.isInteger(requested) || requested < 1) return this.config.maxTextChars
    return Math.min(requested, this.config.maxTextChars)
  }

  /** @internal */
  cleanupTimeout(): number {
    return this.config.cleanupTimeoutMs
  }

  /** @internal */
  persistTransition(transition: BrowserTransition): Promise<void> {
    return this.saveTransition(transition)
  }

  /** @internal */
  persistCheckpoint(
    slot: EnvironmentSlot,
    provider: BrowserProvider,
    generation: number,
    backend: BrowserProviderEnvironment,
    signal: AbortSignal,
  ): Promise<BrowserCheckpointRecord> {
    return this.saveCheckpoint(slot, provider, generation, backend, signal)
  }
}

/** One active environment behind every lease for an owner. */
class ActiveEnvironment {
  readonly generation: number
  readonly provider: BrowserProvider
  private readonly queue = new SerialExecutor()
  private revision = 0
  private latest: BrowserObservation | undefined
  private latestElements = new Map<BrowserElementRef, BoundElement>()
  private shutdownPromise: Promise<void> | undefined

  constructor(
    private readonly runtime: BrowserRuntime,
    private readonly slot: EnvironmentSlot,
    provider: BrowserProvider,
    private readonly backend: BrowserProviderEnvironment,
    generation: number,
  ) {
    this.provider = provider
    this.generation = generation
  }

  observe(options: BrowserObserveOptions = {}): Promise<BrowserObservation> {
    return this.queue.run(operationSignal => this.observeNow(operationSignal, options), options.signal)
  }

  act(action: BrowserAction, signal?: AbortSignal): Promise<BrowserTransition> {
    return this.queue.run(operationSignal => this.actNow(action, operationSignal), signal)
  }

  screenshot(options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshot> {
    return this.queue.run(async (signal) => {
      assertCapabilities(this.provider.capabilities, ['screenshot'])
      const observation = this.latest ?? await this.observeNow(signal)
      let data: Uint8Array
      try {
        data = await this.backend.screenshot({ fullPage: options.fullPage ?? false, signal })
      } catch (error: unknown) {
        if (signal.aborted) signal.throwIfAborted()
        if (error instanceof BrowserProviderPolicyError) {
          throw new BrowserRuntimeError(error.message, 'BROWSER_POLICY_DENIED', { cause: error })
        }
        throw error
      }
      return {
        environmentId: this.slot.environmentId,
        observationId: observation.id,
        url: observation.url,
        title: observation.title,
        data,
      }
    }, options.signal)
  }

  checkpoint(signal?: AbortSignal): Promise<BrowserCheckpointRecord> {
    return this.queue.run(operationSignal => this.runtime.persistCheckpoint(
      this.slot,
      this.provider,
      this.generation,
      this.backend,
      operationSignal,
    ), signal)
  }

  shutdown(persistence: BrowserPersistence): Promise<void> {
    this.shutdownPromise ??= this.runShutdown(persistence)
    return this.shutdownPromise
  }

  private async observeNow(
    signal: AbortSignal,
    options: BrowserObserveOptions = {},
  ): Promise<BrowserObservation> {
    const providerObservation = await this.backend.observe({
      maxTextChars: this.runtime.observationTextLimit(options.maxTextChars),
      ...(options.maxElements === undefined ? {} : { maxElements: options.maxElements }),
      signal,
    })
    this.revision += 1
    const bindings = new Map<BrowserElementRef, BoundElement>()
    const groupRefs = new Map<string, BrowserElementGroupRef>()
    const groupMembers = new Map<BrowserElementGroupRef, { label: string; elements: BrowserElementRef[] }>()
    const elements = providerObservation.elements.map((element, index) => {
      const ref = BrowserElementRef(`e${index + 1}`)
      let group: BrowserElementGroupRef | undefined
      if (element.groupKey !== undefined) {
        group = groupRefs.get(element.groupKey)
        if (group === undefined) {
          group = BrowserElementGroupRef(`g${groupRefs.size + 1}`)
          groupRefs.set(element.groupKey, group)
          groupMembers.set(group, { label: element.groupLabel ?? '', elements: [] })
        }
        groupMembers.get(group)?.elements.push(ref)
      }
      const view: BrowserElement = {
        ref,
        kind: element.kind,
        name: element.name,
        disabled: element.disabled,
        ...(element.inputType === undefined ? {} : { inputType: element.inputType }),
        section: element.section,
        priority: element.priority,
        pagination: element.pagination,
        ...(group === undefined ? {} : { group }),
        ...(element.groupLabel === undefined ? {} : { groupLabel: element.groupLabel }),
      }
      bindings.set(ref, {
        view,
        provider: { target: element.target, fingerprint: element.fingerprint },
      })
      return view
    })
    const groups: BrowserElementGroup[] = [...groupMembers].map(([ref, members]) => ({
      ref,
      label: members.label,
      elements: members.elements,
    }))
    const digest = observationDigest({
      url: providerObservation.url,
      title: providerObservation.title,
      text: providerObservation.text,
      elements,
    })
    const observation: BrowserObservation = {
      id: BrowserObservationId(`observation-${randomUUID()}`),
      environmentId: this.slot.environmentId,
      generation: this.generation,
      pageId: providerObservation.pageId,
      revision: this.revision,
      url: providerObservation.url,
      title: providerObservation.title,
      text: providerObservation.text,
      truncated: providerObservation.truncated,
      totalTextChars: providerObservation.totalTextChars,
      elements,
      groups,
      elementsTruncated: providerObservation.elementsTruncated,
      totalElements: providerObservation.totalElements,
      digest,
    }
    this.latest = observation
    this.latestElements = bindings
    return observation
  }

  private async actNow(action: BrowserAction, signal: AbortSignal): Promise<BrowserTransition> {
    const before = this.latest ?? await this.observeNow(signal)
    const providerAction = this.resolveAction(action, before)
    const recorded = recordedAction(action)
    const startedAt = new Date().toISOString()
    const admittedAt = performance.now()
    let actionSettledAt = admittedAt
    let observationStartedAt = admittedAt
    let after: BrowserObservation | undefined
    let actionCompleted = false
    let failure: unknown
    try {
      await this.backend.act(providerAction, signal)
      actionCompleted = true
      actionSettledAt = performance.now()
      observationStartedAt = actionSettledAt
      after = await this.observeNow(signal)
    } catch (error: unknown) {
      failure = error
      actionSettledAt = actionCompleted ? actionSettledAt : performance.now()
      observationStartedAt = performance.now()
      if (!signal.aborted) {
        try {
          after = await this.observeNow(signal)
        } catch (_postFailureObservationError) {
          // The original provider failure remains authoritative; transition evidence records no after state.
        }
      }
    }
    const finishedAtMs = performance.now()

    const outcome = failure === undefined ? 'succeeded' : actionCompleted ? 'unknown' : 'failed'
    const transition: BrowserTransition = {
      id: BrowserTransitionId(`transition-${randomUUID()}`),
      sessionId: this.slot.sessionId,
      environmentId: this.slot.environmentId,
      providerId: this.provider.id,
      generation: this.generation,
      action: recorded,
      outcome,
      before,
      ...(after === undefined ? {} : { after }),
      startedAt,
      finishedAt: new Date().toISOString(),
      metrics: {
        durationMs: Math.round(finishedAtMs - admittedAt),
        actionMs: Math.round(actionSettledAt - admittedAt),
        observationMs: Math.round(finishedAtMs - observationStartedAt),
        textChars: after?.text.length ?? 0,
        elementCount: after?.elements.length ?? 0,
        textTruncated: after?.truncated ?? false,
        elementsTruncated: after?.elementsTruncated ?? false,
      },
      ...(failure === undefined ? {} : { error: errorEvidence(failure) }),
    }
    await this.runtime.persistTransition(transition)
    if (failure !== undefined) {
      if (signal.aborted) signal.throwIfAborted()
      throw translateProviderFailure(failure, transition.id, actionCompleted)
    }
    return transition
  }

  private resolveAction(action: BrowserAction, before: BrowserObservation): BrowserProviderAction {
    if (action.type === 'navigate') return { type: 'navigate', url: assertNavigableUrl(action.url) }
    if (action.type === 'history') return { type: 'history', direction: action.direction }
    if (action.type === 'reload') return { type: 'reload' }

    if (action.type === 'scroll') {
      const pages = assertScrollPages(action.pages)
      if (action.to !== 'element') return { type: 'scroll', to: action.to, pages }
      return { type: 'scroll', to: 'element', pages, target: this.resolveElement(action, before).provider }
    }
    if (action.type === 'wait') {
      const timeout = action.timeoutMs === undefined ? {} : { timeoutMs: assertPositive(action.timeoutMs, 'timeoutMs') }
      if (action.until !== 'element-visible' && action.until !== 'element-hidden') {
        return { type: 'wait', until: action.until, ...timeout }
      }
      return { type: 'wait', until: action.until, target: this.resolveElement(action, before).provider, ...timeout }
    }
    if (action.type === 'press' && action.elementRef === undefined) {
      return { type: 'press', key: action.key }
    }

    const element = this.resolveElement(action, before)
    switch (action.type) {
      case 'click': return { type: 'click', target: element.provider }
      case 'press': return { type: 'press', target: element.provider, key: action.key }
      case 'check': return { type: 'check', target: element.provider, checked: action.checked }
      case 'select': {
        if (action.values.length === 0) {
          throw new BrowserRuntimeError('browser_select requires at least one value', 'BROWSER_INVALID_ARGUMENT')
        }
        return { type: 'select', target: element.provider, values: [...action.values] }
      }
      case 'fill-credential': return { type: 'fill', target: element.provider, value: action.value }
      case 'fill': {
        if (element.view.inputType?.toLowerCase() === 'password') {
          throw new BrowserRuntimeError(
            'browser_fill refuses password inputs; tool arguments are retained in the session log. '
            + 'Use browser_fill_credential, which injects the secret outside the model path',
            'BROWSER_PASSWORD_INPUT_FORBIDDEN',
          )
        }
        return { type: 'fill', target: element.provider, value: action.value }
      }
    }
  }

  /**
   * Validate an observation-scoped element reference against the latest
   * observation. A reference from any earlier observation is stale even when
   * the page did not change, because the model has not seen the current page.
   */
  private resolveElement(
    action: { readonly observationId?: BrowserObservationId; readonly elementRef?: BrowserElementRef },
    before: BrowserObservation,
  ): BoundElement {
    if (action.elementRef === undefined) {
      throw new BrowserRuntimeError('this browser action requires an element reference', 'BROWSER_INVALID_ARGUMENT')
    }
    if (action.observationId === undefined) {
      throw new BrowserRuntimeError(
        'this browser action requires the latest observation id',
        'BROWSER_OBSERVATION_REQUIRED',
      )
    }
    if (action.observationId !== before.id) {
      throw new BrowserRuntimeError(
        `observation "${action.observationId}" is stale; observe the page again`,
        'BROWSER_STALE_REFERENCE',
      )
    }
    const element = this.latestElements.get(action.elementRef)
    if (element === undefined) {
      throw new BrowserRuntimeError(
        `element "${action.elementRef}" does not belong to the latest observation`,
        'BROWSER_STALE_REFERENCE',
      )
    }
    return element
  }

  extract(request: BrowserExtractRequest): Promise<BrowserExtraction> {
    return this.queue.run(async (signal) => {
      assertCapabilities(this.provider.capabilities, ['extraction'])
      const extract = this.backend.extract
      if (extract === undefined) {
        throw new BrowserRuntimeError(
          `browser provider "${this.provider.id}" advertises extraction without implementing extract()`,
          'BROWSER_CAPABILITY_UNSUPPORTED',
        )
      }
      const before = this.latest ?? await this.observeNow(signal)
      const region = request.regionRef === undefined
        ? undefined
        : this.resolveElement({ ...request, elementRef: request.regionRef }, before).provider
      try {
        return await extract.call(this.backend, {
          kind: request.kind,
          ...(region === undefined ? {} : { region }),
          limit: assertPositive(request.limit ?? 100, 'limit'),
          maxTextChars: assertPositive(request.maxTextChars ?? 2_000, 'maxTextChars'),
          signal,
        })
      } catch (error: unknown) {
        if (signal.aborted) signal.throwIfAborted()
        if (error instanceof BrowserRuntimeError) throw error
        if (error instanceof BrowserProviderTargetStaleError) {
          throw new BrowserRuntimeError(error.message, 'BROWSER_STALE_REFERENCE', { cause: error })
        }
        if (error instanceof BrowserProviderPolicyError) {
          throw new BrowserRuntimeError(error.message, 'BROWSER_POLICY_DENIED', { cause: error })
        }
        throw new BrowserRuntimeError(
          `browser extraction failed: ${String(error)}`,
          'BROWSER_ACTION_FAILED',
          { cause: error },
        )
      }
    }, request.signal)
  }

  private async runShutdown(persistence: BrowserPersistence): Promise<void> {
    this.queue.close()
    await this.queue.drain()
    const failures: unknown[] = []
    if (persistence === 'resume') {
      try {
        await this.runtime.persistCheckpoint(
          this.slot,
          this.provider,
          this.generation,
          this.backend,
          AbortSignal.timeout(this.runtime.cleanupTimeout()),
        )
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    try {
      await this.backend.close()
    } catch (error: unknown) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `browser environment "${this.slot.environmentId}" cleanup failed`)
    }
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const maxTextChars = config.maxTextChars ?? 60_000
  const maxTransitionsInMemory = config.maxTransitionsInMemory ?? 500
  const cleanupTimeoutMs = config.cleanupTimeoutMs ?? 10_000
  const maxCheckpoints = config.maxCheckpoints ?? 100
  const checkpointTtlMs = config.checkpointTtlMs ?? 0
  for (const [key, value] of Object.entries({
    maxTextChars,
    maxTransitionsInMemory,
    cleanupTimeoutMs,
    maxCheckpoints,
  })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`browser-runtime: ${key} must be a positive integer`)
  }
  if (!Number.isInteger(checkpointTtlMs) || checkpointTtlMs < 0) {
    throw new Error('browser-runtime: checkpointTtlMs must be a non-negative integer')
  }
  return {
    ...(config.provider === undefined ? {} : { provider: BrowserProviderId(config.provider) }),
    maxTextChars,
    maxTransitionsInMemory,
    cleanupTimeoutMs,
    checkpointTtlMs,
    maxCheckpoints,
  }
}

function requiredCapability(capabilities: BrowserProviderCapabilities, capability: BrowserCapability): boolean {
  switch (capability) {
    case 'checkpoint': return capabilities.checkpoint
    case 'screenshot': return capabilities.screenshot
    case 'extraction': return capabilities.extraction
    case 'multiple-pages': return capabilities.multiplePages
    case 'attach-existing': return capabilities.attachExisting
    case 'persistent-profile': return capabilities.persistentProfile
    case 'network-events': return capabilities.networkEvents
  }
}

function assertCapabilities(capabilities: BrowserProviderCapabilities, required: readonly BrowserCapability[]): void {
  const missing = required.filter(capability => !requiredCapability(capabilities, capability))
  if (missing.length > 0) {
    throw new BrowserRuntimeError(
      `browser provider does not support required capabilities: ${missing.join(', ')}`,
      'BROWSER_CAPABILITY_UNSUPPORTED',
    )
  }
}

type CheckpointProvider = BrowserProvider & Required<Pick<BrowserProvider, 'restore' | 'destroyCheckpoint'>>

function requireCheckpointProvider(provider: BrowserProvider): CheckpointProvider {
  if (!provider.capabilities.checkpoint
    || provider.restore === undefined
    || provider.destroyCheckpoint === undefined) {
    throw new BrowserRuntimeError(
      `browser provider "${provider.id}" must implement restore() and destroyCheckpoint() when checkpoint is advertised`,
      'BROWSER_CHECKPOINT_UNAVAILABLE',
    )
  }
  return provider as CheckpointProvider
}

async function providerAvailable(provider: BrowserProvider): Promise<boolean> {
  try {
    return await provider.available()
  } catch (_providerAvailabilityFailure) {
    return false
  }
}

/** Read a provider's operator remedy without letting a broken provider mask the selection failure. */
async function providerRemedy(provider: BrowserProvider): Promise<string | undefined> {
  if (provider.unavailableReason === undefined) return undefined
  try {
    const reason = await provider.unavailableReason()
    return reason === undefined || reason === '' ? undefined : reason
  } catch (_providerDiagnosticFailure) {
    return undefined
  }
}

function withProviderRemedy(message: string, remedy: string | undefined): string {
  return remedy === undefined ? message : `${message}\n${remedy}`
}

function sameProviderSnapshot(
  providers: ReadonlyMap<BrowserProviderIdType, BrowserProvider>,
  snapshot: readonly BrowserProvider[],
): boolean {
  return providers.size === snapshot.length
    && snapshot.every(provider => providers.get(provider.id) === provider)
}

function isAbortFailure(signal: AbortSignal, error: unknown): boolean {
  if (!signal.aborted) return false
  if (error === signal.reason) return true
  return typeof error === 'object'
    && error !== null
    && (('name' in error && error.name === 'AbortError') || ('code' in error && error.code === 'ABORT_ERR'))
}

function observationDigest(input: {
  url: string
  title: string
  text: string
  elements: readonly BrowserElement[]
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

/**
 * Project an action into the evidence retained for it.
 *
 * Secret material never reaches this record: an ordinary fill keeps only its
 * length, and a credential fill keeps only the reference it was resolved from.
 */
function recordedAction(action: BrowserAction): BrowserRecordedAction {
  switch (action.type) {
    case 'navigate': return { type: 'navigate', url: action.url }
    case 'click': return { type: 'click', elementRef: action.elementRef }
    case 'history': return { type: 'history', direction: action.direction }
    case 'reload': return { type: 'reload' }
    case 'press': return {
      type: 'press',
      key: action.key,
      ...(action.elementRef === undefined ? {} : { elementRef: action.elementRef }),
    }
    case 'select': return { type: 'select', elementRef: action.elementRef, values: [...action.values] }
    case 'check': return { type: 'check', elementRef: action.elementRef, checked: action.checked }
    case 'scroll': return {
      type: 'scroll',
      to: action.to,
      ...(action.pages === undefined ? {} : { pages: action.pages }),
      ...(action.elementRef === undefined ? {} : { elementRef: action.elementRef }),
    }
    case 'wait': return {
      type: 'wait',
      until: action.until,
      ...(action.elementRef === undefined ? {} : { elementRef: action.elementRef }),
      ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
    }
    case 'fill-credential': return {
      type: 'fill-credential',
      elementRef: action.elementRef,
      credentialRef: action.credentialRef,
      value: '[REDACTED]',
    }
    case 'fill': return {
      type: 'fill',
      elementRef: action.elementRef,
      value: '[REDACTED]',
      valueLength: action.value.length,
    }
  }
}

/** Reject a navigation URL the Provider must never be asked to open. */
function assertNavigableUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch (error: unknown) {
    throw new BrowserRuntimeError(`invalid browser URL: ${rawUrl}`, 'BROWSER_INVALID_URL', { cause: error })
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== '' || parsed.password !== '') {
    throw new BrowserRuntimeError(
      'browser navigation requires an HTTP(S) URL without embedded credentials',
      'BROWSER_INVALID_URL',
    )
  }
  return rawUrl
}

function assertScrollPages(pages: number | undefined): number {
  if (pages === undefined) return 1
  if (!Number.isFinite(pages) || pages <= 0 || pages > 20) {
    throw new BrowserRuntimeError('browser_scroll pages must be between 0 and 20', 'BROWSER_INVALID_ARGUMENT')
  }
  return pages
}

function assertPositive(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new BrowserRuntimeError(`browser ${field} must be a positive integer`, 'BROWSER_INVALID_ARGUMENT')
  }
  return value
}

function translateProviderFailure(
  error: unknown,
  transitionId: BrowserTransitionId,
  actionCompleted: boolean,
): BrowserRuntimeError {
  if (error instanceof BrowserRuntimeError) return error
  if (error instanceof BrowserProviderTargetStaleError) {
    return new BrowserRuntimeError(
      `${error.message}; transition ${transitionId}`,
      'BROWSER_STALE_REFERENCE',
      { cause: error },
    )
  }
  if (error instanceof BrowserProviderPolicyError) {
    return new BrowserRuntimeError(
      `${error.message}; transition ${transitionId}`,
      'BROWSER_POLICY_DENIED',
      { cause: error },
    )
  }
  return new BrowserRuntimeError(
    `browser action ${actionCompleted ? 'completed but its after-state was not observed' : 'failed'}; transition ${transitionId}`,
    actionCompleted ? 'BROWSER_ACTION_EVIDENCE_FAILED' : 'BROWSER_ACTION_FAILED',
    { cause: error },
  )
}

export { EMPTY_CAPABILITIES }
