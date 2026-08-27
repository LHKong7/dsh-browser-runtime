/** Public identities, requests, results, and provider interfaces for browser environments. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque provider registry identity. */
export type BrowserProviderId = Branded<'BrowserProviderId'>
/** Opaque runtime environment identity. */
export type BrowserEnvironmentId = Branded<'BrowserEnvironmentId'>
/** Opaque page identity inside one environment generation. */
export type BrowserPageId = Branded<'BrowserPageId'>
/** Opaque observation identity. */
export type BrowserObservationId = Branded<'BrowserObservationId'>
/** Observation-local model-facing element identity. */
export type BrowserElementRef = Branded<'BrowserElementRef'>
/** Opaque transition identity. */
export type BrowserTransitionId = Branded<'BrowserTransitionId'>
/** Opaque durable checkpoint reference. */
export type BrowserCheckpointRef = Branded<'BrowserCheckpointRef'>
/** Durable session identity supplied by the caller. */
export type BrowserSessionId = Branded<'BrowserSessionId'>

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
  | 'extraction'
  | 'multiple-pages'
  | 'attach-existing'
  | 'persistent-profile'
  | 'network-events'

/** Provider capability declaration. Unsupported requests fail before acquisition. */
export interface BrowserProviderCapabilities {
  readonly checkpoint: boolean
  readonly screenshot: boolean
  /** Whether `extract()` is implemented. */
  readonly extraction: boolean
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
  /** Cancel this acquisition wait without cancelling another compatible waiter. */
  readonly signal?: AbortSignal
}

/** Landmark region an observed element belongs to. */
export type BrowserElementSection =
  | 'search'
  | 'form'
  | 'navigation'
  | 'banner'
  | 'main'
  | 'record'
  | 'complementary'
  | 'contentinfo'
  | 'unknown'

/** Observation-local identity of one repeating page record. */
export type BrowserElementGroupRef = Branded<'BrowserElementGroupRef'>
/** Brand a runtime-minted element group ref. */
export const BrowserElementGroupRef = (value: string): BrowserElementGroupRef => value as BrowserElementGroupRef

/** One visible or interactive element in an observation. */
export interface BrowserElement {
  readonly ref: BrowserElementRef
  readonly kind: string
  readonly name: string
  readonly disabled: boolean
  readonly inputType?: string
  /** Landmark the element sits in; `record` marks one entry of a repeating list. */
  readonly section: BrowserElementSection
  /** Semantic tier from 1 (controls and pagination) to 5 (repeated record links). */
  readonly priority: number
  /** Whether the element moves between pages of a paged listing. */
  readonly pagination: boolean
  /** Observation-local record this element belongs to, when it belongs to one. */
  readonly group?: BrowserElementGroupRef
  /** Title of that record. */
  readonly groupLabel?: string
}

/** One repeating page record and the elements observed inside it. */
export interface BrowserElementGroup {
  readonly ref: BrowserElementGroupRef
  readonly label: string
  readonly elements: readonly BrowserElementRef[]
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
  /** Whether page text held more than this observation retained. */
  readonly truncated: boolean
  /** Characters the page held before the observation budget applied. */
  readonly totalTextChars: number
  readonly elements: readonly BrowserElement[]
  /** Repeating records, in first-appearance order. */
  readonly groups: readonly BrowserElementGroup[]
  /** Whether the page held more interactive elements than this observation retained. */
  readonly elementsTruncated: boolean
  /** Visible interactive elements the page held before the observation budget applied. */
  readonly totalElements: number
  readonly digest: string
}

/** Per-call observation budgets and cancellation. */
export interface BrowserObserveOptions {
  /** Page-text characters to retain; clamped to the Runtime configuration. */
  readonly maxTextChars?: number
  /** Interactive elements to retain; clamped to the Provider configuration. */
  readonly maxElements?: number
  /** Cancel this observation. */
  readonly signal?: AbortSignal
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

/** Fill one non-password element with a value the model never sees. */
export interface BrowserCredentialFillAction {
  readonly type: 'fill-credential'
  readonly observationId: BrowserObservationId
  readonly elementRef: BrowserElementRef
  /** Identity of the stored secret; the plaintext is resolved outside the model path. */
  readonly credentialRef: string
  /** Resolved plaintext. Never logged, never recorded, never returned. */
  readonly value: string
}

/**
 * Keys the Provider accepts.
 *
 * An allowlist rather than free-form key syntax: arbitrary key strings reach
 * browser and operating-system chords that the single-page policy cannot reason
 * about.
 */
export type BrowserKey =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'Backspace'
  | 'Delete'
  | 'Space'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'

/** Every key the Provider accepts, in schema order. */
export const BROWSER_KEYS: readonly BrowserKey[] = [
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]

/** Send one allowlisted key to an observed element or to the focused element. */
export interface BrowserPressAction {
  readonly type: 'press'
  readonly key: BrowserKey
  /** Latest observation id; required when `elementRef` is present. */
  readonly observationId?: BrowserObservationId
  /** Element to focus first; omitted sends the key to whatever holds focus. */
  readonly elementRef?: BrowserElementRef
}

/** Choose options in an observed `select` element. */
export interface BrowserSelectAction {
  readonly type: 'select'
  readonly observationId: BrowserObservationId
  readonly elementRef: BrowserElementRef
  /** Option values or labels; more than one requires a multiple-select. */
  readonly values: readonly string[]
}

/** Set the checked state of an observed checkbox or radio. */
export interface BrowserCheckAction {
  readonly type: 'check'
  readonly observationId: BrowserObservationId
  readonly elementRef: BrowserElementRef
  readonly checked: boolean
}

/** Where a scroll moves the page. */
export type BrowserScrollTarget = 'up' | 'down' | 'top' | 'bottom' | 'element'

/** Scroll the page by viewport multiples, to an end, or to an observed element. */
export interface BrowserScrollAction {
  readonly type: 'scroll'
  readonly to: BrowserScrollTarget
  /** Viewport multiples for `up` and `down`; ignored otherwise. */
  readonly pages?: number
  /** Latest observation id; required when `to` is `element`. */
  readonly observationId?: BrowserObservationId
  readonly elementRef?: BrowserElementRef
}

/** Move through the environment's own session history. */
export interface BrowserHistoryAction {
  readonly type: 'history'
  readonly direction: 'back' | 'forward'
}

/** Reload the current page. */
export interface BrowserReloadAction {
  readonly type: 'reload'
}

/** Page or element state a wait blocks on. */
export type BrowserWaitCondition = 'load' | 'network-idle' | 'element-visible' | 'element-hidden'

/** Wait for a page or element state before the next observation. */
export interface BrowserWaitAction {
  readonly type: 'wait'
  readonly until: BrowserWaitCondition
  /** Latest observation id; required for the element conditions. */
  readonly observationId?: BrowserObservationId
  readonly elementRef?: BrowserElementRef
  /** Upper bound for the wait; the Provider still clamps to its own timeout. */
  readonly timeoutMs?: number
}

/** Mutating operations accepted by a browser environment lease. */
export type BrowserAction =
  | BrowserNavigateAction
  | BrowserClickAction
  | BrowserFillAction
  | BrowserCredentialFillAction
  | BrowserPressAction
  | BrowserSelectAction
  | BrowserCheckAction
  | BrowserScrollAction
  | BrowserHistoryAction
  | BrowserReloadAction
  | BrowserWaitAction

/** Redacted action retained in transition evidence. */
export type BrowserRecordedAction =
  | BrowserNavigateAction
  | Omit<BrowserClickAction, 'observationId'>
  | (Omit<BrowserFillAction, 'observationId' | 'value'> & {
    readonly value: '[REDACTED]'
    readonly valueLength: number
  })
  | {
    readonly type: 'fill-credential'
    readonly elementRef: BrowserElementRef
    readonly credentialRef: string
    readonly value: '[REDACTED]'
  }
  | Omit<BrowserPressAction, 'observationId'>
  | Omit<BrowserSelectAction, 'observationId'>
  | Omit<BrowserCheckAction, 'observationId'>
  | Omit<BrowserScrollAction, 'observationId'>
  | BrowserHistoryAction
  | BrowserReloadAction
  | Omit<BrowserWaitAction, 'observationId'>

/** Outcome of an attempted browser state transition. */
export type BrowserTransitionOutcome = 'succeeded' | 'failed' | 'unknown'

/** Timing and output-size evidence for one admitted action. */
export interface BrowserTransitionMetrics {
  /** Wall time from admission to the settled transition. */
  readonly durationMs: number
  /** Wall time inside the Provider action itself; navigation time for `navigate`. */
  readonly actionMs: number
  /** Wall time spent producing the after observation. */
  readonly observationMs: number
  /** Characters of page text the after observation retained. */
  readonly textChars: number
  /** Interactive elements the after observation retained. */
  readonly elementCount: number
  /** Whether page text held more than the after observation retained. */
  readonly textTruncated: boolean
  /** Whether the page held more interactive elements than were retained. */
  readonly elementsTruncated: boolean
}

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
  readonly metrics: BrowserTransitionMetrics
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
  /**
   * Provider build that wrote the payload. A restore refuses a payload from a
   * different build, because the payload format is provider-private.
   * Absent only on records written before this package tracked it.
   */
  readonly providerVersion?: string
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

/** Structured extraction request made through a lease. */
export interface BrowserExtractRequest {
  readonly kind: BrowserExtractionKind
  /** Latest observation id; required when `regionRef` is present. */
  readonly observationId?: BrowserObservationId
  /** Element from the latest observation whose region bounds the extraction. */
  readonly regionRef?: BrowserElementRef
  /** Maximum records to return. */
  readonly limit?: number
  /** Maximum characters of text per record. */
  readonly maxTextChars?: number
  readonly signal?: AbortSignal
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
  observe(options?: BrowserObserveOptions): Promise<BrowserObservation>
  /**
   * Perform one serialized action and return its transition evidence.
   * Auxiliary compact-index failures are logged without changing the action result.
   */
  act(action: BrowserAction, signal?: AbortSignal): Promise<BrowserTransition>
  /** Capture a PNG without exposing a host output path; Provider resource limits reject with `BROWSER_POLICY_DENIED`. */
  screenshot(options?: BrowserScreenshotOptions): Promise<BrowserScreenshot>
  /**
   * Extract structured content from the current page without model-supplied
   * JavaScript or selectors. A region is addressed by an element ref from the
   * latest observation.
   */
  extract(request: BrowserExtractRequest): Promise<BrowserExtraction>
  /**
   * Persist provider-supported state without closing the environment.
   * Checkpoints sharing a session id commit serially across owner environments.
   * Cancelling a queued call does not let a later checkpoint bypass active work.
   * A Provider cannot replace another Provider's checkpoint for the session.
   */
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
  /** Landmark the element sits in. */
  readonly section: BrowserElementSection
  /** Semantic tier from 1 (controls and pagination) to 5 (repeated record links). */
  readonly priority: number
  /** Whether the element moves between pages of a paged listing. */
  readonly pagination: boolean
  /** Provider-stable identity of the repeating record that owns this element. */
  readonly groupKey?: string
  /** Title of that record. */
  readonly groupLabel?: string
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
  /** Characters the page held before the observation budget applied. */
  readonly totalTextChars: number
  /** Elements ordered by semantic priority, then document order. */
  readonly elements: readonly BrowserProviderElement[]
  /** Whether the page held more visible interactive elements than were returned. */
  readonly elementsTruncated: boolean
  /** Visible interactive elements the page held before the element budget applied. */
  readonly totalElements: number
}

/** Provider observation bounds owned by the runtime configuration. */
export interface BrowserProviderObserveRequest {
  readonly maxTextChars: number
  /** Element budget for this call; the Provider still clamps to its own limit. */
  readonly maxElements?: number
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
  | { readonly type: 'press'; readonly target?: BrowserProviderTarget; readonly key: BrowserKey }
  | { readonly type: 'select'; readonly target: BrowserProviderTarget; readonly values: readonly string[] }
  | { readonly type: 'check'; readonly target: BrowserProviderTarget; readonly checked: boolean }
  | {
    readonly type: 'scroll'
    readonly to: BrowserScrollTarget
    readonly pages: number
    readonly target?: BrowserProviderTarget
  }
  | { readonly type: 'history'; readonly direction: 'back' | 'forward' }
  | { readonly type: 'reload' }
  | {
    readonly type: 'wait'
    readonly until: BrowserWaitCondition
    readonly target?: BrowserProviderTarget
    readonly timeoutMs?: number
  }

/** Structured page content a Provider can extract without running model JavaScript. */
export type BrowserExtractionKind = 'list' | 'table' | 'links' | 'article'

/** Fields each extraction kind can return, in schema order. */
export const BROWSER_EXTRACTION_FIELDS: Readonly<Record<BrowserExtractionKind, readonly string[]>> = {
  list: ['index', 'title', 'url', 'text'],
  table: ['index'],
  links: ['index', 'text', 'url', 'title'],
  article: ['title', 'byline', 'text'],
}

/** One extracted record; every value is page text or a resolved absolute URL. */
export type BrowserExtractionRow = Readonly<Record<string, string>>

/** Runtime request passed to a Provider extracting structured content. */
export interface BrowserProviderExtractRequest {
  readonly kind: BrowserExtractionKind
  /** Region to extract inside; omitted extracts from the document. */
  readonly region?: BrowserProviderTarget
  readonly limit: number
  readonly maxTextChars: number
  readonly signal: AbortSignal
}

/** Structured content one extraction produced. */
export interface BrowserExtraction {
  readonly kind: BrowserExtractionKind
  /** Column names in row order; table extraction derives them from the header. */
  readonly columns: readonly string[]
  readonly rows: readonly BrowserExtractionRow[]
  /** Records the region held before the limit applied. */
  readonly total: number
  readonly truncated: boolean
}

/** Provider implementation for one open environment. */
export interface BrowserProviderEnvironment {
  /** Produce a bounded model-safe page observation. */
  observe(request: BrowserProviderObserveRequest): Promise<BrowserProviderObservation>
  /** Perform one provider action. */
  act(action: BrowserProviderAction, signal: AbortSignal): Promise<void>
  /** Extract structured content; required when the Provider advertises extraction. */
  extract?(request: BrowserProviderExtractRequest): Promise<BrowserExtraction>
  /** Capture a PNG. */
  screenshot(options: { readonly fullPage: boolean; readonly signal: AbortSignal }): Promise<Uint8Array>
  /** Persist provider state; required when the Provider advertises checkpoint capability. */
  checkpoint?(signal: AbortSignal): Promise<BrowserProviderCheckpoint>
  /** Close every resource owned by this environment. Idempotent. */
  close(): Promise<void>
}

/** Browser backend registered with the runtime. */
export interface BrowserProvider {
  readonly id: BrowserProviderId
  readonly capabilities: BrowserProviderCapabilities
  /**
   * Build identity of this provider, recorded with each checkpoint so a restore
   * can refuse a payload written by an incompatible build.
   */
  readonly version?: string
  /** Report whether this process can open an environment. */
  available(): boolean | Promise<boolean>
  /**
   * Explain why `available()` is false and how an operator fixes it.
   * Selection failures quote this instead of a bare "unavailable".
   */
  unavailableReason?(): string | undefined | Promise<string | undefined>
  /** Open a fresh environment; the provider retains cleanup responsibility until fulfillment. */
  open(request: BrowserProviderOpenRequest): Promise<BrowserProviderEnvironment>
  /** Restore an environment; required when checkpoint capability is advertised. */
  restore?(request: BrowserProviderRestoreRequest): Promise<BrowserProviderEnvironment>
  /** Delete provider payload; required when checkpoint capability is advertised. */
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
