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
  | 'BROWSER_INVALID_URL'
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
