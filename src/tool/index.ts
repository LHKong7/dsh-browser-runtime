/** Model-facing browser tools over `ctx.browserRuntime`; no provider imports. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  BrowserElementRef,
  BrowserObservationId,
  BrowserProviderId,
  BrowserSessionId,
} from '../runtime/types.ts'
import type {
  BrowserEnvironmentLease,
  BrowserPersistence,
  BrowserTransition,
} from '../runtime/types.ts'
import type {} from '../runtime/runtime.ts'
import { waitWithSignal } from '../runtime/serial.ts'
import { formatObservation, observationValue, screenshotContent } from './format.ts'

/** Cordis plugin name. */
export const name = 'tool-browser'
/** Services required by the browser tool suite. */
export const inject = ['tools', 'browserRuntime', 'systemPrompt', 'attachments']

/** Browser tool provider, persistence, and timeout policy. */
export interface Config {
  /** Provider requested for every Agent environment. */
  readonly provider?: string
  /** Retain cookies/localStorage on last release or discard all state. */
  readonly persistence?: BrowserPersistence
  /** Cooperative timeout attached to every browser tool definition. */
  readonly timeoutMs?: number
}

interface ResolvedConfig {
  readonly provider?: ReturnType<typeof BrowserProviderId>
  readonly persistence: BrowserPersistence
  readonly timeoutMs: number
}

/** Tool plugin configuration schema. */
export const Config: z<Config> = z.object({
  provider: z.string(),
  persistence: z.union(['ephemeral', 'resume'] as const).default('ephemeral'),
  timeoutMs: z.number().default(30_000),
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
    text: { type: 'string' as const, required: true },
    truncated: { type: 'boolean' as const, required: true },
    digest: { type: 'string' as const, required: true },
    elements: { type: 'array' as const, required: true, items: elementSchema },
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

/** One Agent-scoped lease registered for both Agent and tool-plugin teardown. */
class AgentBrowserBinding {
  private readonly controller = new AbortController()
  private leasePromise: Promise<BrowserEnvironmentLease> | undefined
  private lease: BrowserEnvironmentLease | undefined
  private leaseCleanup: Promise<void> | undefined
  private disposal: Promise<void> | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly config: ResolvedConfig,
    private readonly onDispose: () => void,
  ) {
    agent.ctx.effect(() => async () => this.dispose(), 'toolBrowser.agentBinding()')
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
    try {
      return await operation(lease)
    } catch (error: unknown) {
      if (signal.aborted) await this.invalidate(lease)
      throw error
    }
  }

  private invalidate(lease: BrowserEnvironmentLease): Promise<void> {
    if (this.lease !== lease) return this.leaseCleanup ?? Promise.resolve()
    this.lease = undefined
    this.leasePromise = undefined
    this.leaseCleanup = lease.release().catch((error: unknown) => {
      this.ctx.logger.warn(`cancelled browser lease cleanup failed: ${String(error)}`)
    })
    return this.leaseCleanup
  }

  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.disposed = true
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

  use<T>(
    agent: Agent | undefined,
    signal: AbortSignal,
    operation: (lease: BrowserEnvironmentLease) => Promise<T>,
  ): Promise<T> {
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
    return binding.use(signal, operation)
  }

  async dispose(): Promise<void> {
    const settled = await Promise.allSettled([...this.live].map(binding => binding.dispose()))
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'browser tool bindings cleanup failed')
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const timeoutMs = config.timeoutMs ?? 30_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('tool-browser: timeoutMs must be a positive integer')
  }
  return {
    ...(config.provider === undefined ? {} : { provider: BrowserProviderId(config.provider) }),
    persistence: config.persistence ?? 'ephemeral',
    timeoutMs,
  }
}

function successfulAction(transition: BrowserTransition): {
  transition: {
    id: string
    outcome: 'succeeded' | 'failed' | 'unknown'
    before_observation_id: string
    after_observation_id: string
  }
  observation: ReturnType<typeof observationValue>
} {
  if (transition.after === undefined) throw new Error(`transition ${transition.id} has no after observation`)
  return {
    transition: {
      id: transition.id,
      outcome: transition.outcome,
      before_observation_id: transition.before.id,
      after_observation_id: transition.after.id,
    },
    observation: observationValue(transition.after),
  }
}

function actionContent(value: ReturnType<typeof successfulAction>): { type: 'text'; text: string }[] {
  return [{
    type: 'text',
    text: `Transition ${value.transition.id}: ${value.transition.outcome}\n\n${formatObservation(value.observation)}`,
  }]
}

/** Register the five v0.1 browser tools and their prompt guidance. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const bindings = new AgentBrowserBindings(ctx, resolved)
  ctx.effect(() => async () => bindings.dispose(), 'toolBrowser.bindings()')
  ctx.systemPrompt.section({
    name: 'tool:browser-runtime',
    order: 112,
    text: 'Use browser_open to navigate, then act only on element refs from the latest browser observation. Re-observe after any stale-reference error. browser_fill is not a secret-entry channel: tool arguments are retained in the session log, and password fields are rejected.',
  })

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open an HTTP(S) URL in this Agent\'s isolated browser environment and return a new observation.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute HTTP(S) URL without embedded credentials.' },
    },
    output: { schema: actionResultSchema, render: (_args, value) => actionContent(value) },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      return bindings.use(exec.agent, exec.signal, async lease => (
        successfulAction(await lease.act({ type: 'navigate', url: args.url }, exec.signal))
      ))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_observe',
    description: 'Observe the current page and return fresh element refs. Older refs become stale.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { observation: { ...observationSchema, required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: formatObservation(value.observation) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(_args, exec) {
      return bindings.use(exec.agent, exec.signal, async lease => ({
        observation: observationValue(await lease.observe(exec.signal)),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element from the latest browser observation.',
    parameters: {
      observation_id: { type: 'string', required: true, description: 'Latest observation id.' },
      element_ref: { type: 'string', required: true, description: 'Element ref such as e1 from that observation.' },
    },
    output: { schema: actionResultSchema, render: (_args, value) => actionContent(value) },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      return bindings.use(exec.agent, exec.signal, async lease => (
        successfulAction(await lease.act({
          type: 'click',
          observationId: BrowserObservationId(args.observation_id),
          elementRef: BrowserElementRef(args.element_ref),
        }, exec.signal))
      ))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_fill',
    description: 'Fill a non-password field from the latest browser observation. Never pass secrets.',
    parameters: {
      observation_id: { type: 'string', required: true, description: 'Latest observation id.' },
      element_ref: { type: 'string', required: true, description: 'Non-password input ref from that observation.' },
      value: { type: 'string', required: true, description: 'Non-secret text. This argument is retained in the session log.' },
    },
    output: { schema: actionResultSchema, render: (_args, value) => actionContent(value) },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      return bindings.use(exec.agent, exec.signal, async lease => (
        successfulAction(await lease.act({
          type: 'fill',
          observationId: BrowserObservationId(args.observation_id),
          elementRef: BrowserElementRef(args.element_ref),
          value: args.value,
        }, exec.signal))
      ))
    },
  }))

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
}

export { formatObservation, observationValue } from './format.ts'
export type { ObservationValue } from './format.ts'
