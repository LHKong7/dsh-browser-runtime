/** Browser runtime failure taxonomy. */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable browser runtime error codes surfaced through DSH tool failures. */
export type BrowserRuntimeErrorCode =
  | 'BROWSER_DUPLICATE_PROVIDER'
  | 'BROWSER_PROVIDER_CONFIGURED_MISSING'
  | 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE'
  | 'BROWSER_PROVIDER_UNAVAILABLE'
  | 'BROWSER_PROVIDER_AMBIGUOUS'
  | 'BROWSER_CAPABILITY_UNSUPPORTED'
  | 'BROWSER_OWNER_CONFLICT'
  | 'BROWSER_ENVIRONMENT_CLOSED'
  | 'BROWSER_OBSERVATION_REQUIRED'
  | 'BROWSER_STALE_REFERENCE'
  | 'BROWSER_PASSWORD_INPUT_FORBIDDEN'
  | 'BROWSER_CHECKPOINT_UNAVAILABLE'
  | 'BROWSER_CHECKPOINT_PROVIDER_MISMATCH'
  | 'BROWSER_CHECKPOINT_VERSION_MISMATCH'
  | 'BROWSER_INVALID_URL'
  | 'BROWSER_INVALID_ARGUMENT'
  | 'BROWSER_OBSERVATION_SUPERSEDED'
  | 'BROWSER_CONTINUATION_EXHAUSTED'
  | 'BROWSER_CREDENTIAL_UNAVAILABLE'
  | 'BROWSER_CREDENTIAL_DENIED'
  | 'BROWSER_POLICY_DENIED'
  | 'BROWSER_ACTION_FAILED'
  | 'BROWSER_ACTION_EVIDENCE_FAILED'
  | 'BROWSER_CHECKPOINT_METADATA_FAILED'

/** Error with a stable code and optional cause for provider and tool integration. */
export class BrowserRuntimeError extends HarnessError {
  /** Stable machine-readable failure code. */
  declare readonly code: BrowserRuntimeErrorCode

  /**
   * @param message - caller-facing failure description.
   * @param code - stable browser failure code.
   * @param options - optional underlying failure.
   */
  constructor(message: string, code: BrowserRuntimeErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'BrowserRuntimeError'
  }
}

/** Provider signal that a previously observed opaque target no longer matches the page. */
export class BrowserProviderTargetStaleError extends Error {
  constructor(message = 'the observed browser element changed before the action') {
    super(message)
    this.name = 'BrowserProviderTargetStaleError'
  }
}

/** Provider signal that a checkpoint payload no longer exists on disk. */
export class BrowserProviderCheckpointMissingError extends Error {
  constructor(message = 'the browser checkpoint payload no longer exists') {
    super(message)
    this.name = 'BrowserProviderCheckpointMissingError'
  }
}

/** Provider signal that network or browser policy rejected an operation. */
export class BrowserProviderPolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserProviderPolicyError'
  }
}

/** Read a stable code from a thrown value when one is present. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/** Convert a thrown value to transition-safe error evidence. */
export function errorEvidence(error: unknown): { name: string; message: string; code?: string } {
  const name = error instanceof Error ? error.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  const code = errorCode(error)
  return { name, message, ...(code === undefined ? {} : { code }) }
}

/**
 * Recovery guidance a model can route on without parsing prose.
 *
 * The Provider never silently retries an action: a click that failed may still
 * have navigated, so repeating it could act on a page the model has not seen.
 * These fields say what the caller should do instead.
 */
export interface BrowserFailureEvidence {
  /** Stable failure code, mirroring `BrowserRuntimeError.code` when present. */
  readonly code: string
  /** URL of the page as the last successful observation saw it. */
  readonly url?: string
  /** Whether element refs from the latest observation are still addressable. */
  readonly observationValid: boolean
  /** Whether the environment lease was discarded and will be rebuilt. */
  readonly leaseRebuilt: boolean
  /** Tool the caller should run next, when one recovers the situation. */
  readonly recommendedAction?: string
  /** Whether repeating the identical call is safe and could succeed. */
  readonly retryable: boolean
}

interface FailureClassification {
  readonly observationValid: boolean
  readonly recommendedAction?: string
  readonly retryable: boolean
}

const FAILURE_CLASSIFICATION: Readonly<Record<string, FailureClassification>> = {
  BROWSER_STALE_REFERENCE: { observationValid: false, recommendedAction: 'browser_observe', retryable: false },
  BROWSER_OBSERVATION_REQUIRED: { observationValid: false, recommendedAction: 'browser_observe', retryable: false },
  BROWSER_OBSERVATION_SUPERSEDED: { observationValid: false, recommendedAction: 'browser_observe', retryable: false },
  BROWSER_CONTINUATION_EXHAUSTED: { observationValid: true, recommendedAction: 'browser_observe', retryable: false },
  BROWSER_PASSWORD_INPUT_FORBIDDEN: {
    observationValid: true,
    recommendedAction: 'browser_fill_credential',
    retryable: false,
  },
  BROWSER_CREDENTIAL_UNAVAILABLE: { observationValid: true, retryable: false },
  BROWSER_CREDENTIAL_DENIED: { observationValid: true, retryable: false },
  BROWSER_POLICY_DENIED: { observationValid: true, retryable: false },
  BROWSER_INVALID_URL: { observationValid: true, retryable: false },
  BROWSER_INVALID_ARGUMENT: { observationValid: true, retryable: false },
  // The action ran; only its after-state is unknown, so repeating it could act twice.
  BROWSER_ACTION_EVIDENCE_FAILED: { observationValid: false, recommendedAction: 'browser_observe', retryable: false },
  BROWSER_ACTION_FAILED: { observationValid: false, recommendedAction: 'browser_observe', retryable: true },
  BROWSER_ENVIRONMENT_CLOSED: { observationValid: false, recommendedAction: 'browser_observe', retryable: true },
  BROWSER_CAPABILITY_UNSUPPORTED: { observationValid: true, retryable: false },
  BROWSER_OWNER_CONFLICT: { observationValid: true, retryable: false },
  BROWSER_PROVIDER_UNAVAILABLE: { observationValid: true, retryable: false },
  BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE: { observationValid: true, retryable: false },
  BROWSER_PROVIDER_CONFIGURED_MISSING: { observationValid: true, retryable: false },
  BROWSER_PROVIDER_AMBIGUOUS: { observationValid: true, retryable: false },
  BROWSER_CHECKPOINT_VERSION_MISMATCH: { observationValid: true, retryable: false },
  BROWSER_CHECKPOINT_PROVIDER_MISMATCH: { observationValid: true, retryable: false },
  BROWSER_CHECKPOINT_UNAVAILABLE: { observationValid: true, retryable: false },
}

/**
 * Classify a thrown browser failure into routable recovery guidance.
 * @param error - the value a lease operation threw.
 * @param context - what the tool layer knows about the environment right now.
 * @returns evidence naming the code, page, validity, and next step.
 */
export function classifyBrowserFailure(
  error: unknown,
  context: { readonly url?: string; readonly leaseRebuilt: boolean },
): BrowserFailureEvidence {
  const code = errorCode(error) ?? 'BROWSER_ACTION_FAILED'
  const classification = FAILURE_CLASSIFICATION[code]
    ?? { observationValid: false, recommendedAction: 'browser_observe', retryable: false }
  return {
    code,
    ...(context.url === undefined ? {} : { url: context.url }),
    observationValid: context.leaseRebuilt ? false : classification.observationValid,
    leaseRebuilt: context.leaseRebuilt,
    ...(classification.recommendedAction === undefined
      ? {}
      : { recommendedAction: classification.recommendedAction }),
    retryable: classification.retryable,
  }
}

/**
 * Render failure evidence as one machine-parsable line appended to a message.
 * @param evidence - the classified failure.
 * @returns a `key=value` line in stable field order.
 */
export function browserFailureLine(evidence: BrowserFailureEvidence): string {
  const fields = [
    `code=${evidence.code}`,
    ...(evidence.url === undefined ? [] : [`url=${evidence.url}`]),
    `observation=${evidence.observationValid ? 'valid' : 'invalid'}`,
    `lease=${evidence.leaseRebuilt ? 'rebuilt' : 'intact'}`,
    ...(evidence.recommendedAction === undefined ? [] : [`recommended_action=${evidence.recommendedAction}`]),
    `retryable=${evidence.retryable}`,
  ]
  return fields.join(' ')
}
