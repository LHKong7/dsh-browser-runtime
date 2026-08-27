/**
 * Secret-entry channel for browser forms.
 *
 * `browser_fill` cannot carry a password: DSH logs raw tool-call arguments
 * before this plugin runs, so a secret in `value` stays in the session log.
 * This module resolves a secret from a name the model supplies, so the
 * plaintext never enters a model request, a tool argument, transition
 * evidence, or the session log.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'
import { BrowserRuntimeError } from '../runtime/error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserCredentials: BrowserCredentialStore
  }
}

/**
 * Deployment-owned secret store addressed by reference.
 *
 * A deployment mounts its own implementation as `ctx.browserCredentials`; this
 * plugin falls back to its configured environment-variable mapping when none is
 * present. An implementation must never return a secret through `list()`.
 */
export abstract class BrowserCredentialStore extends Service {
  /** References this store can resolve. Names only, never values. */
  abstract list(): Promise<readonly string[]>
  /**
   * Resolve one reference to plaintext.
   * @param ref - the name the model supplied.
   * @returns the secret, which the caller must not log or return.
   */
  abstract resolve(ref: string): Promise<string>
}

/** Credential channel policy for the browser tool suite. */
export interface CredentialConfig {
  /**
   * Reference-to-environment-variable mapping used when no
   * `ctx.browserCredentials` service is mounted. The model may name only these
   * references.
   */
  readonly refs?: Readonly<Record<string, string>>
  /**
   * Require an approved `ctx.approval` request per fill. Leaving this on
   * without an approval service mounted denies every credential fill.
   */
  readonly requireApproval?: boolean
}

/** Resolved credential policy. */
export interface ResolvedCredentialConfig {
  readonly refs: Readonly<Record<string, string>>
  readonly requireApproval: boolean
}

/** Apply the credential defaults; approval is required unless disabled. */
export function resolveCredentialConfig(config: CredentialConfig = {}): ResolvedCredentialConfig {
  return {
    refs: config.refs ?? {},
    requireApproval: config.requireApproval ?? true,
  }
}

/** Whether any credential source is configured for this plugin instance. */
export function credentialChannelEnabled(
  ctx: { get(name: 'browserCredentials'): unknown },
  config: ResolvedCredentialConfig,
): boolean {
  return Object.keys(config.refs).length > 0 || ctx.get('browserCredentials') !== undefined
}

/** References a model may name, for the tool description and error messages. */
export async function listCredentialRefs(
  ctx: { get(name: 'browserCredentials'): BrowserCredentialStore | undefined },
  config: ResolvedCredentialConfig,
): Promise<readonly string[]> {
  const store = ctx.get('browserCredentials')
  const stored = store === undefined ? [] : await store.list()
  return [...new Set([...Object.keys(config.refs), ...stored])].sort()
}

/**
 * Resolve one credential reference to plaintext after policy checks.
 *
 * The returned value is handed straight to the Provider fill action and is
 * never returned to the model, recorded in transition evidence, or logged.
 * @param ctx - context used to reach the optional store and approval service.
 * @param config - resolved credential policy.
 * @param request - the reference, the requesting Agent, and the tool call.
 * @returns the plaintext secret.
 */
export async function resolveCredential(
  ctx: {
    get(name: 'browserCredentials'): BrowserCredentialStore | undefined
    get(name: 'approval'): { request(input: unknown): Promise<string> } | undefined
  },
  config: ResolvedCredentialConfig,
  request: {
    readonly ref: string
    readonly agent: Agent
    readonly callId?: CallId
    readonly signal: AbortSignal
  },
): Promise<string> {
  if (config.requireApproval) {
    const approval = ctx.get('approval')
    if (approval === undefined) {
      throw new BrowserRuntimeError(
        'browser_fill_credential requires an approval service; none is mounted',
        'BROWSER_CREDENTIAL_DENIED',
      )
    }
    const outcome = await approval.request({
      agent: request.agent,
      toolName: 'browser_fill_credential',
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      reason: `inject the stored credential "${request.ref}" into a browser form field`,
      signal: request.signal,
    })
    if (outcome !== 'allowed-once') {
      throw new BrowserRuntimeError(
        `credential "${request.ref}" was not approved for this call (${outcome})`,
        'BROWSER_CREDENTIAL_DENIED',
      )
    }
  }

  const store = ctx.get('browserCredentials')
  if (store !== undefined && (await store.list()).includes(request.ref)) {
    return nonEmpty(await store.resolve(request.ref), request.ref)
  }
  const variable = config.refs[request.ref]
  if (variable === undefined) {
    const available = await listCredentialRefs(ctx, config)
    throw new BrowserRuntimeError(
      available.length === 0
        ? `no browser credential is configured; "${request.ref}" cannot be resolved`
        : `unknown browser credential "${request.ref}"; configured: ${available.join(', ')}`,
      'BROWSER_CREDENTIAL_UNAVAILABLE',
    )
  }
  const value = process.env[variable]
  if (value === undefined) {
    throw new BrowserRuntimeError(
      `browser credential "${request.ref}" maps to an unset environment variable`,
      'BROWSER_CREDENTIAL_UNAVAILABLE',
    )
  }
  return nonEmpty(value, request.ref)
}

function nonEmpty(value: string, ref: string): string {
  if (value === '') {
    throw new BrowserRuntimeError(
      `browser credential "${ref}" resolved to an empty value`,
      'BROWSER_CREDENTIAL_UNAVAILABLE',
    )
  }
  return value
}
