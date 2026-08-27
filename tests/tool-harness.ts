import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import BrowserRuntime from 'dsh-browser-runtime'
import * as ToolBrowser from 'dsh-browser-runtime/tools'
import { FakeBrowserProvider } from './fake-provider.ts'

const limits: ImageAttachmentLimits = {
  maxImageBytes: 1_000_000,
  maxImagesPerMessage: 10,
  maxMessageImageBytes: 10_000_000,
  maxImagePixels: 1_000_000,
  maxImageDimension: 2_000,
  mediaTypes: ['image/png'],
}

/** In-memory attachment store standing in for the host's durable one. */
export class MemoryAttachments extends AttachmentStore {
  readonly imageLimits = limits
  saves = 0

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saves += 1
    return Promise.resolve({
      attachmentId: AttachmentId(`sha256:${String(this.saves).padStart(64, '0')}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...(input.name === undefined ? {} : { name: input.name }),
    })
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    throw new Error('not used')
  }
}

/** One Agent bound to a mounted tool suite. */
export interface HarnessAgent {
  readonly ctx: Context
  readonly agent: Agent
  call(name: string, args: unknown, signal?: AbortSignal): Promise<ToolExecutionResult>
}

/** One mounted tool suite plus the Agent its calls belong to. */
export interface ToolHarness {
  readonly ctx: Context
  readonly agentCtx: Context
  readonly agent: Agent
  readonly provider: FakeBrowserProvider
  call(name: string, args: unknown, signal?: AbortSignal): Promise<ToolExecutionResult>
  /** Add a second Agent against the same suite, to check isolation. */
  addAgent(name: string): HarnessAgent
  dispose(): Promise<void>
}

/**
 * Mount the browser tool suite over the fake provider with the real
 * ToolRuntime, SystemPrompt, and an attachment store.
 * @param options - tool plugin config plus optional context preparation.
 * @returns the mounted harness.
 */
export async function toolHarness(options: {
  readonly config?: Record<string, unknown>
  readonly prepare?: (ctx: Context) => Promise<void> | void
} = {}): Promise<ToolHarness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(BrowserRuntime, { provider: 'fake' })
  const provider = new FakeBrowserProvider()
  ctx.browserRuntime.registerProvider(provider)
  new MemoryAttachments(ctx)
  await options.prepare?.(ctx)
  await ctx.plugin(ToolBrowser, { provider: 'fake', ...options.config })

  let counter = 0
  const extra: Context[] = []

  const makeAgent = (name: string): HarnessAgent => {
    const agentCtx = new Context()
    const id = SessionId(name)
    const agent = { id, ctx: agentCtx, session: { id } } as unknown as Agent
    return {
      ctx: agentCtx,
      agent,
      call(toolName, args, signal = new AbortController().signal) {
        counter += 1
        return ctx.tools.execute({
          callId: CallId(`browser-call-${counter}`),
          name: toolName,
          arguments: args,
          agent,
          signal,
        })
      },
    }
  }

  const primary = makeAgent('tool-agent')
  return {
    ctx,
    agentCtx: primary.ctx,
    agent: primary.agent,
    provider,
    call: primary.call,
    addAgent(name) {
      const created = makeAgent(name)
      extra.push(created.ctx)
      return created
    },
    async dispose() {
      for (const agentContext of extra) await agentContext.fiber.dispose()
      await primary.ctx.fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}
