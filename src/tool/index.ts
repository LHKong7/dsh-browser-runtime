/** Model-facing browser tools over `ctx.browserRuntime`; no provider imports. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { browserFailureLine, classifyBrowserFailure, BrowserRuntimeError } from '../runtime/error.ts'
import {
  BROWSER_EXTRACTION_FIELDS,
  BROWSER_KEYS,
  BrowserElementRef,
  BrowserObservationId,
  BrowserProviderId,
  BrowserSessionId,
} from '../runtime/types.ts'
import type {
  BrowserAction,
  BrowserEnvironmentLease,
  BrowserExtractionKind,
  BrowserKey,
  BrowserObservation,
  BrowserPersistence,
  BrowserScrollTarget,
  BrowserTransition,
  BrowserWaitCondition,
} from '../runtime/types.ts'
import type {} from '../runtime/runtime.ts'
import { waitWithSignal } from '../runtime/serial.ts'
import { credentialChannelEnabled, resolveCredential, resolveCredentialConfig } from './credentials.ts'
import type { CredentialConfig, ResolvedCredentialConfig } from './credentials.ts'
import {
  formatObservation,
  formatTransition,
  nextOffsets,
  observationBudget,
  observationValue,
  OBSERVATION_MODES,
  screenshotContent,
  transitionValue,
} from './format.ts'
import type { ObservationBudget, ObservationMode, ObservationOffsets, ObservationValue } from './format.ts'

/** Cordis plugin name. */
export const name = 'tool-browser'
/** Services required by the browser tool suite. */
export const inject = ['tools', 'browserRuntime', 'systemPrompt', 'attachments']

/** Browser tool provider, persistence, observation, and timeout policy. */
export interface Config {
  /** Provider requested for every Agent environment. */
  readonly provider?: string
  /** Retain cookies/localStorage on last release or discard all state. */
  readonly persistence?: BrowserPersistence
  /** Cooperative timeout attached to every browser tool definition. */
  readonly timeoutMs?: number
  /** Observation mode used when a call does not name one. */
  readonly observeMode?: ObservationMode
  /** Hard cap on page-text characters in one tool response. */
  readonly maxTextChars?: number
  /** Hard cap on interactive elements in one tool response. */
  readonly maxElements?: number
  /** Secret-entry channel policy for `browser_fill_credential`. */
  readonly credentials?: CredentialConfig
}

interface ResolvedConfig {
  readonly provider?: ReturnType<typeof BrowserProviderId>
  readonly persistence: BrowserPersistence
  readonly timeoutMs: number
  readonly observeMode: ObservationMode
  readonly maxTextChars: number
  readonly maxElements: number
  readonly credentials: ResolvedCredentialConfig
}

/** Tool plugin configuration schema. */
export const Config: z<Config> = z.object({
  provider: z.string(),
  persistence: z.union(['ephemeral', 'resume'] as const).default('ephemeral'),
  timeoutMs: z.number().default(30_000),
  observeMode: z.union(['summary', 'interactive', 'document'] as const).default('summary'),
  maxTextChars: z.number().default(12_000),
  maxElements: z.number().default(100),
  credentials: z.object({
    refs: z.dict(z.string()).default({}),
    requireApproval: z.boolean().default(true),
  }),
})

const elementSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    ref: { type: 'string' as const, required: true },
    kind: { type: 'string' as const, required: true },
    name: { type: 'string' as const, required: true },
    disabled: { type: 'boolean' as const, required: true },
    input_type: { type: 'string' as const },
    section: { type: 'string' as const, required: true },
    priority: { type: 'integer' as const, required: true },
    pagination: { type: 'boolean' as const, required: true },
    group: { type: 'string' as const },
    group_label: { type: 'string' as const },
  },
} as const

const groupSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    ref: { type: 'string' as const, required: true },
    label: { type: 'string' as const, required: true },
    elements: { type: 'array' as const, required: true, items: { type: 'string' as const } },
  },
} as const

const observationSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true },
    environment_id: { type: 'string' as const, required: true },
    generation: { type: 'integer' as const, required: true },
    page_id: { type: 'string' as const, required: true },
    revision: { type: 'integer' as const, required: true },
    url: { type: 'string' as const, required: true },
    title: { type: 'string' as const, required: true },
    mode: { type: 'string' as const, required: true, enum: OBSERVATION_MODES },
    text: { type: 'string' as const, required: true },
    text_offset: { type: 'integer' as const, required: true },
    text_truncated: { type: 'boolean' as const, required: true },
    total_text_chars: { type: 'integer' as const, required: true },
    elements: { type: 'array' as const, required: true, items: elementSchema },
    groups: { type: 'array' as const, required: true, items: groupSchema },
    element_offset: { type: 'integer' as const, required: true },
    elements_truncated: { type: 'boolean' as const, required: true },
    total_elements: { type: 'integer' as const, required: true },
    continuation: { type: 'string' as const },
    digest: { type: 'string' as const, required: true },
  },
} as const

const transitionSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true },
    outcome: { type: 'string' as const, required: true, enum: ['succeeded', 'failed', 'unknown'] },
    before_observation_id: { type: 'string' as const, required: true },
    after_observation_id: { type: 'string' as const, required: true },
    metrics: {
      type: 'object' as const,
      required: true as const,
      additionalProperties: false,
      properties: {
        duration_ms: { type: 'integer' as const, required: true },
        action_ms: { type: 'integer' as const, required: true },
        observation_ms: { type: 'integer' as const, required: true },
        text_chars: { type: 'integer' as const, required: true },
        element_count: { type: 'integer' as const, required: true },
        text_truncated: { type: 'boolean' as const, required: true },
        elements_truncated: { type: 'boolean' as const, required: true },
      },
    },
  },
} as const

const actionResultSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    transition: { ...transitionSchema, required: true as const },
    observation: { ...observationSchema, required: true as const },
  },
} as const

const observationResultSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: { observation: { ...observationSchema, required: true as const } },
} as const

const extractionSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    kind: { type: 'string' as const, required: true, enum: ['list', 'table', 'links', 'article'] },
    url: { type: 'string' as const, required: true },
    observation_id: { type: 'string' as const, required: true },
    columns: { type: 'array' as const, required: true, items: { type: 'string' as const } },
    rows: {
      type: 'array' as const,
      required: true as const,
      items: { type: 'object' as const, additionalProperties: true },
    },
    total: { type: 'integer' as const, required: true },
    truncated: { type: 'boolean' as const, required: true },
  },
} as const

const attachmentSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' as const, required: true },
    mediaType: { type: 'string' as const, required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' as const, required: true },
    width: { type: 'integer' as const, required: true },
    height: { type: 'integer' as const, required: true },
    name: { type: 'string' as const },
    originalDimensions: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        width: { type: 'integer' as const, required: true },
        height: { type: 'integer' as const, required: true },
      },
    },
  },
} as const

const observationArgs = {
  mode: {
    type: 'string' as const,
    enum: OBSERVATION_MODES,
    description:
      'summary: lead text plus controls, navigation, pagination, and record titles. '
      + 'interactive: every ranked element and no page text. '
      + 'document: article text with only the controls needed to keep reading.',
  },
  max_text_chars: { type: 'integer' as const, description: 'Page-text characters in this response.' },
  max_elements: { type: 'integer' as const, description: 'Interactive elements in this response.' },
} as const

const targetArgs = {
  observation_id: { type: 'string' as const, required: true as const, description: 'Latest observation id.' },
  element_ref: {
    type: 'string' as const,
    required: true as const,
    description: 'Element ref such as e1 from that observation.',
  },
} as const

/** Where a continuation resumes, and the budget it resumes under. */
interface ObservationPager {
  readonly observation: BrowserObservation
  readonly budget: ObservationBudget
  readonly offsets: ObservationOffsets
  readonly cursor: string
}

/** One Agent-scoped lease registered for both Agent and tool-plugin teardown. */
class AgentBrowserBinding {
  private readonly controller = new AbortController()
  private leasePromise: Promise<BrowserEnvironmentLease> | undefined
  private lease: BrowserEnvironmentLease | undefined
  private leaseCleanup: Promise<void> | undefined
  private disposal: Promise<void> | undefined
  private disposed = false
  private cursorSequence = 0
  /** Latest observation and where a continuation resumes inside it. */
  pager: ObservationPager | undefined
  /** URL of the last observation, reported in failure evidence. */
  lastUrl: string | undefined
  /** Set when a failed call discarded the lease, so the next call rebuilds it. */
  leaseRebuilt = false

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly config: ResolvedConfig,
    private readonly onDispose: () => void,
  ) {
    agent.ctx.effect(() => async () => this.dispose(), 'toolBrowser.agentBinding()')
  }

  /** Mint the next continuation token for this Agent. */
  nextCursor(): string {
    this.cursorSequence += 1
    return `cursor-${this.cursorSequence}`
  }

  async get(signal: AbortSignal): Promise<BrowserEnvironmentLease> {
    if (this.disposed) throw new Error('browser tool binding is disposed')
    signal.throwIfAborted()
    if (this.leaseCleanup !== undefined) await waitWithSignal(this.leaseCleanup, signal)
    if (this.disposed) throw new Error('browser tool binding is disposed')
    if (this.lease !== undefined) return this.lease
    if (this.leasePromise === undefined) {
      const requiredCapabilities = this.config.persistence === 'resume'
        ? ['screenshot', 'checkpoint'] as const
        : ['screenshot'] as const
      this.leasePromise = this.ctx.browserRuntime.acquire({
        owner: this.agent,
        sessionId: BrowserSessionId(String(this.agent.id)),
        persistence: this.config.persistence,
        requiredCapabilities,
        signal: this.controller.signal,
        ...(this.config.provider === undefined ? {} : { providerId: this.config.provider }),
      }).then((lease) => {
        this.lease = lease
        return lease
      }).catch((error: unknown) => {
        this.leasePromise = undefined
        throw error
      })
    }
    return waitWithSignal(this.leasePromise, signal)
  }

  async use<T>(
    signal: AbortSignal,
    operation: (lease: BrowserEnvironmentLease) => Promise<T>,
  ): Promise<T> {
    const lease = await this.get(signal)
    this.leaseRebuilt = false
    try {
      return await operation(lease)
    } catch (error: unknown) {
      if (signal.aborted) {
        await this.invalidate(lease)
        this.leaseRebuilt = true
      }
      throw error
    }
  }

  private invalidate(lease: BrowserEnvironmentLease): Promise<void> {
    if (this.lease !== lease) return this.leaseCleanup ?? Promise.resolve()
    this.lease = undefined
    this.leasePromise = undefined
    this.pager = undefined
    this.leaseCleanup = lease.release().catch((error: unknown) => {
      this.ctx.logger.warn(`cancelled browser lease cleanup failed: ${String(error)}`)
    })
    return this.leaseCleanup
  }

  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.disposed = true
      this.pager = undefined
      this.controller.abort(new Error('browser tool binding is disposing'))
      if (this.leaseCleanup !== undefined) await this.leaseCleanup
      let lease = this.lease
      if (lease === undefined && this.leasePromise !== undefined) {
        try { lease = await this.leasePromise } catch (_acquisitionFailure) {
          // Acquisition owns rollback; no lease was published to this binding.
        }
      }
      if (lease !== undefined) await lease.release()
      this.onDispose()
    })()
    return this.disposal
  }
}

/** Lease cache keyed by exact live Agent objects. */
class AgentBrowserBindings {
  private readonly bindings = new WeakMap<Agent, AgentBrowserBinding>()
  private readonly live = new Set<AgentBrowserBinding>()

  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig) {}

  /** Resolve the binding for one Agent, creating it on first use. */
  for(agent: Agent | undefined): AgentBrowserBinding {
    if (agent === undefined) throw new Error('browser tools require an Agent-owned execution')
    let binding = this.bindings.get(agent)
    if (binding === undefined) {
      binding = new AgentBrowserBinding(this.ctx, agent, this.config, () => {
        this.live.delete(binding as AgentBrowserBinding)
        this.bindings.delete(agent)
      })
      this.bindings.set(agent, binding)
      this.live.add(binding)
    }
    return binding
  }

  /**
   * Run one operation on an Agent's lease, enriching any failure with routable
   * recovery guidance. Nothing is retried here: a click that failed may still
   * have navigated, so repeating it could act on a page the model never saw.
   */
  async use<T>(
    agent: Agent | undefined,
    signal: AbortSignal,
    operation: (lease: BrowserEnvironmentLease, binding: AgentBrowserBinding) => Promise<T>,
  ): Promise<T> {
    const binding = this.for(agent)
    try {
      return await binding.use(signal, lease => operation(lease, binding))
    } catch (error: unknown) {
      throw enrichFailure(error, binding)
    }
  }

  async dispose(): Promise<void> {
    const settled = await Promise.allSettled([...this.live].map(binding => binding.dispose()))
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'browser tool bindings cleanup failed')
  }
}

/** Append machine-routable recovery guidance to a browser tool failure. */
function enrichFailure(error: unknown, binding: AgentBrowserBinding): unknown {
  if (!(error instanceof BrowserRuntimeError)) return error
  const evidence = classifyBrowserFailure(error, {
    ...(binding.lastUrl === undefined ? {} : { url: binding.lastUrl }),
    leaseRebuilt: binding.leaseRebuilt,
  })
  if (!evidence.observationValid) binding.pager = undefined
  return new BrowserRuntimeError(
    `${error.message}\n${browserFailureLine(evidence)}`,
    error.code,
    { cause: error },
  )
}

function resolveConfig(config: Config): ResolvedConfig {
  const timeoutMs = config.timeoutMs ?? 30_000
  const maxTextChars = config.maxTextChars ?? 12_000
  const maxElements = config.maxElements ?? 100
  for (const [key, value] of Object.entries({ timeoutMs, maxTextChars, maxElements })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`tool-browser: ${key} must be a positive integer`)
  }
  return {
    ...(config.provider === undefined ? {} : { provider: BrowserProviderId(config.provider) }),
    persistence: config.persistence ?? 'ephemeral',
    timeoutMs,
    observeMode: config.observeMode ?? 'summary',
    maxTextChars,
    maxElements,
    credentials: resolveCredentialConfig(config.credentials),
  }
}

/**
 * Project one observation page and remember where a continuation resumes.
 *
 * Every tool that produces an observation replaces the pager, so a continuation
 * can only ever read the newest observation.
 */
function publishObservation(
  binding: AgentBrowserBinding,
  observation: BrowserObservation,
  budget: ObservationBudget,
  offsets: ObservationOffsets = { text: 0, elements: 0 },
): ObservationValue {
  binding.lastUrl = observation.url
  const next = nextOffsets(observation, budget, offsets)
  if (next === undefined) {
    binding.pager = undefined
    return observationValue(observation, budget, offsets)
  }
  const cursor = binding.nextCursor()
  binding.pager = { observation, budget, offsets: next, cursor }
  return observationValue(observation, budget, offsets, cursor)
}

function actionValue(
  binding: AgentBrowserBinding,
  transition: BrowserTransition,
  budget: ObservationBudget,
): { transition: ReturnType<typeof transitionValue>; observation: ObservationValue } {
  if (transition.after === undefined) throw new Error(`transition ${transition.id} has no after observation`)
  return {
    transition: transitionValue(transition),
    observation: publishObservation(binding, transition.after, budget),
  }
}

function actionContent(value: ReturnType<typeof actionValue>): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: `${formatTransition(value.transition)}\n\n${formatObservation(value.observation)}` }]
}

function extractionContent(value: {
  kind: string
  columns: string[]
  rows: Record<string, unknown>[]
  total: number
  truncated: boolean
}): { type: 'text'; text: string }[] {
  const header = value.truncated
    ? `Extracted ${value.rows.length} of ${value.total} ${value.kind} records (truncated)`
    : `Extracted ${value.rows.length} ${value.kind} records`
  const body = value.rows.map((row, index) => (
    `${index}. ${value.columns.map(column => `${column}=${String(row[column] ?? '')}`).join(' | ')}`
  ))
  return [{ type: 'text', text: [header, ...body].join('\n') }]
}

/** Register the browser tool suite and its prompt guidance. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const bindings = new AgentBrowserBindings(ctx, resolved)
  ctx.effect(() => async () => bindings.dispose(), 'toolBrowser.bindings()')
  const credentialsEnabled = credentialChannelEnabled(ctx, resolved.credentials)

  ctx.systemPrompt.section({
    name: 'tool:browser-runtime',
    order: 112,
    text: [
      'Use browser_open to navigate, then act only on element refs from the latest browser observation.',
      'Observations are ranked: controls, navigation, and pagination come before repeated per-record links,'
      + ' and a truncated observation says so. Read more of one observation with browser_observe_next'
      + ' rather than re-observing, and switch mode (summary, interactive, document) instead of raising limits.',
      'Re-observe after any stale-reference error; failures carry code, recommended_action, and retryable fields.',
      'The browser suits interactive pages. For hundreds or thousands of static records prefer an official API'
      + ' or a direct fetch over paging through the browser; browser_extract_* is for a page already open.',
      credentialsEnabled
        ? 'browser_fill is not a secret-entry channel: tool arguments are retained in the session log, and password'
          + ' fields are rejected. Use browser_fill_credential, which names a stored credential the model never sees.'
        : 'browser_fill is not a secret-entry channel: tool arguments are retained in the session log, and password'
          + ' fields are rejected. No credential channel is configured in this deployment.',
    ].join(' '),
  })

  /** Budget for a tool that carries observation arguments. */
  const budgetFor = (args: {
    mode?: string
    max_text_chars?: number
    max_elements?: number
  }): ObservationBudget => observationBudget(
    (args.mode as ObservationMode | undefined) ?? resolved.observeMode,
    {
      ...(args.max_text_chars === undefined ? {} : { maxTextChars: args.max_text_chars }),
      ...(args.max_elements === undefined ? {} : { maxElements: args.max_elements }),
    },
    { maxTextChars: resolved.maxTextChars, maxElements: resolved.maxElements },
  )

  const defaultBudget = (): ObservationBudget => budgetFor({})

  /** Register one tool whose body performs a single browser action. */
  const action = (definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    build: (args: never) => BrowserAction
  }): void => {
    ctx.tools.register(defineTool({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters as never,
      output: { schema: actionResultSchema, render: (_args, value) => actionContent(value) },
      timeoutMs: resolved.timeoutMs,
      async execute(args, exec) {
        return bindings.use(exec.agent, exec.signal, async (lease, binding) => (
          actionValue(binding, await lease.act(definition.build(args as never), exec.signal), defaultBudget())
        ))
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open an HTTP(S) URL in this Agent\'s isolated browser environment and return a new observation.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute HTTP(S) URL without embedded credentials.' },
      ...observationArgs,
    },
    output: { schema: actionResultSchema, render: (_args, value) => actionContent(value) },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      return bindings.use(exec.agent, exec.signal, async (lease, binding) => (
        actionValue(binding, await lease.act({ type: 'navigate', url: args.url }, exec.signal), budgetFor(args))
      ))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_observe',
    description:
      'Observe the current page and return fresh element refs. Older refs become stale. '
      + 'Choose a mode instead of raising limits when a page is large.',
    parameters: observationArgs,
    output: {
      schema: observationResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatObservation(value.observation) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const budget = budgetFor(args)
      return bindings.use(exec.agent, exec.signal, async (lease, binding) => ({
        observation: publishObservation(
          binding,
          await lease.observe({
            maxTextChars: resolved.maxTextChars,
            maxElements: resolved.maxElements,
            signal: exec.signal,
          }),
          budget,
        ),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_observe_next',
    description:
      'Read the next page of the newest observation without re-observing, so element refs stay valid. '
      + 'Pass the continuation token the previous response returned.',
    parameters: {
      continuation: {
        type: 'string',
        required: true,
        description: 'Continuation token from the previous observation response.',
      },
    },
    output: {
      schema: observationResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatObservation(value.observation) }],
    },
    timeoutMs: resolved.timeoutMs,
    execute(args, exec) {
      const binding = bindings.for(exec.agent)
      try {
        const pager = binding.pager
        if (pager === undefined) {
          throw new BrowserRuntimeError(
            'no browser observation is open for continuation; observe the page again',
            'BROWSER_CONTINUATION_EXHAUSTED',
          )
        }
        if (pager.cursor !== args.continuation) {
          throw new BrowserRuntimeError(
            `continuation "${args.continuation}" is not the open cursor "${pager.cursor}"; `
            + 'a newer observation replaced it',
            'BROWSER_OBSERVATION_SUPERSEDED',
          )
        }
        return Promise.resolve({
          observation: publishObservation(binding, pager.observation, pager.budget, pager.offsets),
        })
      } catch (error: unknown) {
        throw enrichFailure(error, binding)
      }
    },
  }))

  action({
    name: 'browser_click',
    description: 'Click an element from the latest browser observation.',
    parameters: targetArgs,
    build: (args: { observation_id: string; element_ref: string }) => ({
      type: 'click',
      observationId: BrowserObservationId(args.observation_id),
      elementRef: BrowserElementRef(args.element_ref),
    }),
  })

  action({
    name: 'browser_fill',
    description: 'Fill a non-password field from the latest browser observation. Never pass secrets.',
    parameters: {
      ...targetArgs,
      value: {
        type: 'string',
        required: true,
        description: 'Non-secret text. This argument is retained in the session log.',
      },
    },
    build: (args: { observation_id: string; element_ref: string; value: string }) => ({
      type: 'fill',
      observationId: BrowserObservationId(args.observation_id),
      elementRef: BrowserElementRef(args.element_ref),
      value: args.value,
    }),
  })

  action({
    name: 'browser_press',
    description:
      'Send one key to an element from the latest observation, or to the focused element when no ref is given.',
    parameters: {
      key: { type: 'string', required: true, enum: BROWSER_KEYS, description: 'Key to send.' },
      observation_id: { type: 'string', description: 'Latest observation id; required with element_ref.' },
      element_ref: { type: 'string', description: 'Element to focus before the key.' },
    },
    build: (args: { key: BrowserKey; observation_id?: string; element_ref?: string }) => ({
      type: 'press',
      key: args.key,
      ...(args.observation_id === undefined ? {} : { observationId: BrowserObservationId(args.observation_id) }),
      ...(args.element_ref === undefined ? {} : { elementRef: BrowserElementRef(args.element_ref) }),
    }),
  })

  action({
    name: 'browser_select',
    description: 'Choose options in a select element from the latest browser observation.',
    parameters: {
      ...targetArgs,
      values: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Option values or visible labels. More than one requires a multiple-select.',
      },
    },
    build: (args: { observation_id: string; element_ref: string; values: string[] }) => ({
      type: 'select',
      observationId: BrowserObservationId(args.observation_id),
      elementRef: BrowserElementRef(args.element_ref),
      values: args.values,
    }),
  })

  action({
    name: 'browser_check',
    description: 'Set the checked state of a checkbox or radio from the latest browser observation.',
    parameters: {
      ...targetArgs,
      checked: { type: 'boolean', required: true, description: 'Desired checked state.' },
    },
    build: (args: { observation_id: string; element_ref: string; checked: boolean }) => ({
      type: 'check',
      observationId: BrowserObservationId(args.observation_id),
      elementRef: BrowserElementRef(args.element_ref),
      checked: args.checked,
    }),
  })

  action({
    name: 'browser_scroll',
    description: 'Scroll the page by viewport multiples, to an end, or to an element from the latest observation.',
    parameters: {
      to: {
        type: 'string',
        required: true,
        enum: ['up', 'down', 'top', 'bottom', 'element'],
        description: 'Scroll destination.',
      },
      pages: { type: 'number', description: 'Viewport multiples for up and down; defaults to 1.' },
      observation_id: { type: 'string', description: 'Latest observation id; required when to is element.' },
      element_ref: { type: 'string', description: 'Element to bring into view.' },
    },
    build: (args: { to: BrowserScrollTarget; pages?: number; observation_id?: string; element_ref?: string }) => ({
      type: 'scroll',
      to: args.to,
      ...(args.pages === undefined ? {} : { pages: args.pages }),
      ...(args.observation_id === undefined ? {} : { observationId: BrowserObservationId(args.observation_id) }),
      ...(args.element_ref === undefined ? {} : { elementRef: BrowserElementRef(args.element_ref) }),
    }),
  })

  action({
    name: 'browser_back',
    description: 'Go back one entry in this environment\'s own session history.',
    parameters: {},
    build: () => ({ type: 'history', direction: 'back' }),
  })

  action({
    name: 'browser_forward',
    description: 'Go forward one entry in this environment\'s own session history.',
    parameters: {},
    build: () => ({ type: 'history', direction: 'forward' }),
  })

  action({
    name: 'browser_reload',
    description: 'Reload the current page.',
    parameters: {},
    build: () => ({ type: 'reload' }),
  })

  action({
    name: 'browser_wait',
    description:
      'Wait for a page or element state, then return a fresh observation. '
      + 'Use this after an action that updates the page asynchronously.',
    parameters: {
      until: {
        type: 'string',
        required: true,
        enum: ['load', 'network-idle', 'element-visible', 'element-hidden'],
        description: 'Condition to wait for.',
      },
      observation_id: { type: 'string', description: 'Latest observation id; required for element conditions.' },
      element_ref: { type: 'string', description: 'Element the condition applies to.' },
      timeout_ms: { type: 'integer', description: 'Upper bound; the Provider still clamps to its own timeout.' },
    },
    build: (args: {
      until: BrowserWaitCondition
      observation_id?: string
      element_ref?: string
      timeout_ms?: number
    }) => ({
      type: 'wait',
      until: args.until,
      ...(args.observation_id === undefined ? {} : { observationId: BrowserObservationId(args.observation_id) }),
      ...(args.element_ref === undefined ? {} : { elementRef: BrowserElementRef(args.element_ref) }),
      ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
    }),
  })

  if (credentialsEnabled) {
    ctx.tools.register(defineTool({
      name: 'browser_fill_credential',
      description:
        'Fill a field with a stored credential named by reference. The plaintext is injected outside the model '
        + 'path and never appears in tool arguments, transition evidence, or the session log.',
      parameters: {
        ...targetArgs,
        credential_ref: {
          type: 'string',
          required: true,
          description: 'Name of a configured credential. Never pass the secret itself.',
        },
      },
      output: { schema: actionResultSchema, render: (_args, value) => actionContent(value) },
      timeoutMs: resolved.timeoutMs,
      async execute(args, exec) {
        const binding = bindings.for(exec.agent)
        const value = await resolveCredential(ctx, resolved.credentials, {
          ref: args.credential_ref,
          agent: requireAgent(exec.agent),
          ...(exec.callId === undefined ? {} : { callId: exec.callId }),
          signal: exec.signal,
        }).catch((error: unknown) => { throw enrichFailure(error, binding) })
        return bindings.use(exec.agent, exec.signal, async (lease, agentBinding) => actionValue(
          agentBinding,
          await lease.act({
            type: 'fill-credential',
            observationId: BrowserObservationId(args.observation_id),
            elementRef: BrowserElementRef(args.element_ref),
            credentialRef: args.credential_ref,
            value,
          }, exec.signal),
          defaultBudget(),
        ))
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture the current page as a durable PNG attachment.',
    parameters: {
      full_page: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          observation_id: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          attachment: { ...attachmentSchema, required: true },
        },
      },
      render: (_args, value) => screenshotContent(value),
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const screenshot = await bindings.use(exec.agent, exec.signal, lease => (
        lease.screenshot({ fullPage: args.full_page ?? false, signal: exec.signal })
      ))
      const attachment = await ctx.attachments.saveImage({
        data: screenshot.data,
        mediaType: 'image/png',
        name: 'browser-screenshot.png',
      })
      return {
        observation_id: screenshot.observationId,
        url: screenshot.url,
        title: screenshot.title,
        attachment,
      }
    },
  }))

  for (const kind of ['list', 'table', 'links', 'article'] as const) {
    registerExtraction(ctx, bindings, resolved, kind)
  }
}

const EXTRACTION_DESCRIPTIONS: Readonly<Record<BrowserExtractionKind, string>> = {
  list: 'Extract the repeating records of a region as rows with index, title, url, and text.',
  table: 'Extract a table as rows keyed by its header cells.',
  links: 'Extract the links of a region as rows with text, url, and title.',
  article: 'Extract the main article of the page as title, byline, and text.',
}

function registerExtraction(
  ctx: Context,
  bindings: AgentBrowserBindings,
  resolved: ResolvedConfig,
  kind: BrowserExtractionKind,
): void {
  ctx.tools.register(defineTool({
    name: `browser_extract_${kind}`,
    description:
      `${EXTRACTION_DESCRIPTIONS[kind]} Works on a semantic region of the page already open; it accepts no `
      + 'selector and runs no model-supplied JavaScript. For hundreds of static records, prefer an official API.',
    parameters: {
      observation_id: { type: 'string', description: 'Latest observation id; required with region_ref.' },
      region_ref: {
        type: 'string',
        description: 'Element ref whose region bounds the extraction; omit to extract from the page.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: `Fields to keep. Available for ${kind}: ${BROWSER_EXTRACTION_FIELDS[kind].join(', ')}`
          + `${kind === 'table' ? ' plus the table\'s own header cells' : ''}.`,
      },
      limit: { type: 'integer', description: 'Maximum records to return; defaults to 100.' },
      max_text_chars: { type: 'integer', description: 'Maximum characters per record field; defaults to 2000.' },
    },
    output: { schema: extractionSchema, render: (_args, value) => extractionContent(value) },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      return bindings.use(exec.agent, exec.signal, async (lease, binding) => {
        const extraction = await lease.extract({
          kind,
          ...(args.observation_id === undefined
            ? {}
            : { observationId: BrowserObservationId(args.observation_id) }),
          ...(args.region_ref === undefined ? {} : { regionRef: BrowserElementRef(args.region_ref) }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.max_text_chars === undefined ? {} : { maxTextChars: args.max_text_chars }),
          signal: exec.signal,
        })
        const columns = selectColumns(extraction.columns, args.fields)
        return {
          kind,
          url: binding.lastUrl ?? '',
          observation_id: args.observation_id ?? '',
          columns,
          rows: extraction.rows.map(row => Object.fromEntries(
            columns.map(column => [column, row[column] ?? '']),
          )),
          total: extraction.total,
          truncated: extraction.truncated,
        }
      })
    },
  }))
}

/** Narrow extraction columns to the requested fields, rejecting unknown names. */
function selectColumns(available: readonly string[], requested: string[] | undefined): string[] {
  if (requested === undefined || requested.length === 0) return [...available]
  const unknown = requested.filter(field => !available.includes(field))
  if (unknown.length > 0) {
    throw new BrowserRuntimeError(
      `unknown extraction fields: ${unknown.join(', ')}; this region offers ${available.join(', ')}`,
      'BROWSER_INVALID_ARGUMENT',
    )
  }
  return requested
}

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('browser tools require an Agent-owned execution')
  return agent
}

export { BrowserCredentialStore } from './credentials.ts'
export type { CredentialConfig } from './credentials.ts'
export {
  formatObservation,
  formatTransition,
  observationBudget,
  observationValue,
  transitionValue,
  OBSERVATION_MODES,
} from './format.ts'
export type { ObservationMode, ObservationValue, TransitionValue } from './format.ts'
