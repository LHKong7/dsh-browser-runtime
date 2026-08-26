/** Public identities, requests, results, and provider interfaces for browser environments. */

type Brand<T, Name extends string> = T & { readonly __brand: Name }

/** Opaque provider registry identity. */
export type BrowserProviderId = Brand<string, 'BrowserProviderId'>
/** Opaque runtime environment identity. */
export type BrowserEnvironmentId = Brand<string, 'BrowserEnvironmentId'>
/** Opaque page identity inside one environment generation. */
export type BrowserPageId = Brand<string, 'BrowserPageId'>
/** Opaque observation identity. */
export type BrowserObservationId = Brand<string, 'BrowserObservationId'>
/** Observation-local model-facing element identity. */
export type BrowserElementRef = Brand<string, 'BrowserElementRef'>
/** Opaque transition identity. */
export type BrowserTransitionId = Brand<string, 'BrowserTransitionId'>
/** Opaque durable checkpoint reference. */
export type BrowserCheckpointRef = Brand<string, 'BrowserCheckpointRef'>
/** Durable session identity supplied by the caller. */
export type BrowserSessionId = Brand<string, 'BrowserSessionId'>

/** Brand a validated provider id. */
export const BrowserProviderId = (value: string): BrowserProviderId => value as BrowserProviderId
/** Brand a runtime-minted environment id. */
export const BrowserEnvironmentId = (value: string): BrowserEnvironmentId => value as BrowserEnvironmentId
/** Brand a provider page id. */
export const BrowserPageId = (value: string): BrowserPageId => value as BrowserPageId
/** Brand a runtime-minted observation id. */
export const BrowserObservationId = (value: string): BrowserObservationId => value as BrowserObservationId
/** Brand an observation-local element ref. */
export const BrowserElementRef = (value: string): BrowserElementRef => value as BrowserElementRef
/** Brand a runtime-minted transition id. */
export const BrowserTransitionId = (value: string): BrowserTransitionId => value as BrowserTransitionId
/** Brand a provider checkpoint ref. */
export const BrowserCheckpointRef = (value: string): BrowserCheckpointRef => value as BrowserCheckpointRef
/** Brand a caller-owned session id. */
export const BrowserSessionId = (value: string): BrowserSessionId => value as BrowserSessionId

/** Capabilities a provider can truthfully advertise. */
export type BrowserCapability =
  | 'checkpoint'
  | 'screenshot'
  | 'multiple-pages'
  | 'attach-existing'
  | 'persistent-profile'
  | 'network-events'

/** Provider capability declaration. Unsupported requests fail before acquisition. */
export interface BrowserProviderCapabilities {
  readonly checkpoint: boolean
  readonly screenshot: boolean
  readonly multiplePages: boolean
  readonly attachExisting: boolean
  readonly persistentProfile: boolean
  readonly networkEvents: boolean
}

/** State retention requested for one owner environment. */
export type BrowserPersistence = 'ephemeral' | 'resume'

/** Acquire one owner-scoped browser environment. */
export interface BrowserAcquireRequest {
  /** Exact object whose identity owns and shares the environment. */
  readonly owner: object
  /** Durable identity used to index checkpoints. */
  readonly sessionId: BrowserSessionId
  /** Explicit provider id; omission uses runtime configuration or unambiguous selection. */
  readonly providerId?: BrowserProviderId
  /** Whether the last release checkpoints browser storage before closing. */
  readonly persistence: BrowserPersistence
  /** Provider features the caller requires. */
  readonly requiredCapabilities?: readonly BrowserCapability[]
  /** Caller cancellation for acquisition. */
  readonly signal?: AbortSignal
}

/** One visible or interactive element in an observation. */
export interface BrowserElement {
  readonly ref: BrowserElementRef
  readonly kind: string
  readonly name: string
  readonly disabled: boolean
  readonly inputType?: string
}

/** Model-safe snapshot of the single page owned by an environment. */
export interface BrowserObservation {
  readonly id: BrowserObservationId
  readonly environmentId: BrowserEnvironmentId
  readonly generation: number
  readonly pageId: BrowserPageId
  readonly revision: number
  readonly url: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
  readonly elements: readonly BrowserElement[]
  readonly digest: string
}

/** Navigation accepted by an environment. Only HTTP(S) URLs are valid. */
export interface BrowserNavigateAction {
  readonly type: 'navigate'
  readonly url: string
}

/** Click one element from the latest observation. */
export interface BrowserClickAction {
  readonly type: 'click'
  readonly observationId: BrowserObservationId
  readonly elementRef: BrowserElementRef
}

/** Fill one non-password element from the latest observation. */
export interface BrowserFillAction {
  readonly type: 'fill'
  readonly observationId: BrowserObservationId
  readonly elementRef: BrowserElementRef
  readonly value: string
}

/** Mutating operations accepted by a browser environment lease. */
export type BrowserAction = BrowserNavigateAction | BrowserClickAction | BrowserFillAction

/** Redacted action retained in transition evidence. */
export type BrowserRecordedAction =
  | BrowserNavigateAction
  | Omit<BrowserClickAction, 'observationId'>
  | (Omit<BrowserFillAction, 'observationId' | 'value'> & {
    readonly value: '[REDACTED]'
    readonly valueLength: number
  })

/** Outcome of an attempted browser state transition. */
export type BrowserTransitionOutcome = 'succeeded' | 'failed' | 'unknown'

/** Before/after evidence for one admitted browser action. */
export interface BrowserTransition {
  readonly id: BrowserTransitionId
  readonly sessionId: BrowserSessionId
  readonly environmentId: BrowserEnvironmentId
  readonly providerId: BrowserProviderId
  readonly generation: number
  readonly action: BrowserRecordedAction
  readonly outcome: BrowserTransitionOutcome
  readonly before: BrowserObservation
  readonly after?: BrowserObservation
  readonly startedAt: string
  readonly finishedAt: string
  readonly error?: { readonly name: string; readonly message: string; readonly code?: string }
}

/** Browser state included in v0.1 checkpoints. */
export type BrowserCheckpointCoverage = 'cookies' | 'local-storage'

/** Provider-produced checkpoint payload reference. */
export interface BrowserProviderCheckpoint {
  readonly ref: BrowserCheckpointRef
  readonly coverage: readonly BrowserCheckpointCoverage[]
}

/** Runtime checkpoint index record. */
export interface BrowserCheckpointRecord {
  readonly sessionId: BrowserSessionId
  readonly environmentId: BrowserEnvironmentId
  readonly generation: number
  readonly providerId: BrowserProviderId
  readonly ref: BrowserCheckpointRef
  readonly coverage: readonly BrowserCheckpointCoverage[]
  readonly createdAt: string
}

/** PNG evidence captured from the environment's single page. */
export interface BrowserScreenshot {
  readonly environmentId: BrowserEnvironmentId
  readonly observationId: BrowserObservationId
  readonly url: string
  readonly title: string
  readonly data: Uint8Array
}

/** Options for screenshot capture. */
export interface BrowserScreenshotOptions {
  readonly fullPage?: boolean
  readonly signal?: AbortSignal
}

/** Holder capability for one shared owner environment. */
export interface BrowserEnvironmentLease {
  readonly environmentId: BrowserEnvironmentId
  readonly providerId: BrowserProviderId
  readonly generation: number
  /** Observe the current page and invalidate older element refs. */
  observe(signal?: AbortSignal): Promise<BrowserObservation>
  /** Perform one serialized action and return its transition evidence. */
  act(action: BrowserAction, signal?: AbortSignal): Promise<BrowserTransition>
  /** Capture a PNG without exposing a host output path. */
  screenshot(options?: BrowserScreenshotOptions): Promise<BrowserScreenshot>
  /** Persist the provider-supported browser state without closing the environment. */
  checkpoint(signal?: AbortSignal): Promise<BrowserCheckpointRecord>
  /** Release this holder; the last release checkpoints when configured and closes the environment. */
  release(): Promise<void>
}

/** Runtime request passed to a provider opening a fresh environment. */
export interface BrowserProviderOpenRequest {
  readonly environmentId: BrowserEnvironmentId
  readonly sessionId: BrowserSessionId
  readonly signal: AbortSignal
}

/** Runtime request passed to a provider restoring an environment. */
export interface BrowserProviderRestoreRequest extends BrowserProviderOpenRequest {
  readonly checkpoint: BrowserCheckpointRecord
}

/** Provider-side element record; `target` never crosses the runtime API. */
export interface BrowserProviderElement {
  readonly kind: string
  readonly name: string
  readonly disabled: boolean
  readonly inputType?: string
  readonly fingerprint: string
  readonly target: unknown
}

/** Provider-side page observation before runtime ids and digest are assigned. */
export interface BrowserProviderObservation {
  readonly pageId: BrowserPageId
  readonly url: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
  readonly elements: readonly BrowserProviderElement[]
}

/** Provider observation bounds owned by the runtime configuration. */
export interface BrowserProviderObserveRequest {
  readonly maxTextChars: number
  readonly signal: AbortSignal
}

/** Runtime-validated opaque target passed back to the provider. */
export interface BrowserProviderTarget {
  readonly target: unknown
  readonly fingerprint: string
}

/** Provider operation after runtime reference validation. */
export type BrowserProviderAction =
  | BrowserNavigateAction
  | { readonly type: 'click'; readonly target: BrowserProviderTarget }
  | { readonly type: 'fill'; readonly target: BrowserProviderTarget; readonly value: string }

/** Provider implementation for one open environment. */
export interface BrowserProviderEnvironment {
  /** Produce a bounded model-safe page observation. */
  observe(request: BrowserProviderObserveRequest): Promise<BrowserProviderObservation>
  /** Perform one provider action. */
  act(action: BrowserProviderAction, signal: AbortSignal): Promise<void>
  /** Capture a PNG. */
  screenshot(options: { readonly fullPage: boolean; readonly signal: AbortSignal }): Promise<Uint8Array>
  /** Persist provider state when checkpoint capability is advertised. */
  checkpoint?(signal: AbortSignal): Promise<BrowserProviderCheckpoint>
  /** Close every resource owned by this environment. Idempotent. */
  close(): Promise<void>
}

/** Browser backend registered with the runtime. */
export interface BrowserProvider {
  readonly id: BrowserProviderId
  readonly capabilities: BrowserProviderCapabilities
  /** Report whether this process can open an environment. */
  available(): boolean | Promise<boolean>
  /** Open a fresh environment; the provider retains cleanup responsibility until fulfillment. */
  open(request: BrowserProviderOpenRequest): Promise<BrowserProviderEnvironment>
  /** Restore an environment when checkpoint capability is advertised. */
  restore?(request: BrowserProviderRestoreRequest): Promise<BrowserProviderEnvironment>
  /** Delete provider payload for one no-longer-indexed checkpoint. */
  destroyCheckpoint?(ref: BrowserCheckpointRef): Promise<void>
  /** Close provider-wide resources after all owned environments drain. */
  dispose?(): Promise<void>
}

/** Summary of one registered provider. */
export interface BrowserProviderInfo {
  readonly id: BrowserProviderId
  readonly capabilities: BrowserProviderCapabilities
  readonly available: boolean
}
