/** Browser environment Service Definition and provider-neutral runtime. @module dsh-browser-runtime */

export { BrowserRuntimeError, BrowserProviderPolicyError, BrowserProviderTargetStaleError } from './runtime/error.ts'
export type { BrowserRuntimeErrorCode } from './runtime/error.ts'
export { browserRuntimeDomainSpec } from './runtime/metadata.ts'
export type { BrowserTransitionRecord } from './runtime/metadata.ts'
export {
  BrowserCheckpointRef,
  BrowserElementRef,
  BrowserEnvironmentId,
  BrowserObservationId,
  BrowserPageId,
  BrowserProviderId,
  BrowserSessionId,
  BrowserTransitionId,
} from './runtime/types.ts'
export type {
  BrowserAcquireRequest,
  BrowserAction,
  BrowserCapability,
  BrowserCheckpointCoverage,
  BrowserCheckpointRecord,
  BrowserClickAction,
  BrowserElement,
  BrowserElementRef as BrowserElementRefType,
  BrowserEnvironmentId as BrowserEnvironmentIdType,
  BrowserEnvironmentLease,
  BrowserFillAction,
  BrowserNavigateAction,
  BrowserObservation,
  BrowserObservationId as BrowserObservationIdType,
  BrowserPageId as BrowserPageIdType,
  BrowserPersistence,
  BrowserProvider,
  BrowserProviderAction,
  BrowserProviderCapabilities,
  BrowserProviderCheckpoint,
  BrowserProviderElement,
  BrowserProviderEnvironment,
  BrowserProviderId as BrowserProviderIdType,
  BrowserProviderInfo,
  BrowserProviderObservation,
  BrowserProviderObserveRequest,
  BrowserProviderOpenRequest,
  BrowserProviderRestoreRequest,
  BrowserProviderTarget,
  BrowserRecordedAction,
  BrowserScreenshot,
  BrowserScreenshotOptions,
  BrowserSessionId as BrowserSessionIdType,
  BrowserTransition,
  BrowserTransitionId as BrowserTransitionIdType,
  BrowserTransitionOutcome,
} from './runtime/types.ts'
export { BrowserRuntime, Config, EMPTY_CAPABILITIES, name } from './runtime/runtime.ts'
export type { Config as BrowserRuntimeConfig } from './runtime/runtime.ts'
export { BrowserRuntime as default } from './runtime/runtime.ts'
