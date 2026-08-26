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
import { beforeEach, describe, expect, it } from 'vitest'
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

class MemoryAttachments extends AttachmentStore {
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

interface ObservationToolValue {
  observation: {
    id: string
    elements: { ref: string; input_type?: string }[]
  }
}

let ctx: Context
let provider: FakeBrowserProvider
let agentCtx: Context
let agent: Agent
let counter: number

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(BrowserRuntime, { provider: 'fake' })
  provider = new FakeBrowserProvider()
  ctx.browserRuntime.registerProvider(provider)
  new MemoryAttachments(ctx)
  await ctx.plugin(ToolBrowser, { provider: 'fake' })
  agentCtx = new Context()
  const id = SessionId('tool-agent')
  agent = { id, ctx: agentCtx, session: { id } } as unknown as Agent
  counter = 0
})

function call(name: string, arguments_: unknown): Promise<ToolExecutionResult> {
  counter += 1
  return ctx.tools.execute({
    callId: CallId(`browser-call-${counter}`),
    name,
    arguments: arguments_,
    agent,
    signal: new AbortController().signal,
  })
}

describe('browser tools through the real ToolRuntime', () => {
  it('registers the five selector-free schemas', () => {
    const schemas = new Map(ctx.tools.schemas().map(schema => [schema.name, schema]))
    expect([...schemas.keys()].filter(name => name.startsWith('browser_')).sort()).toEqual([
      'browser_click',
      'browser_fill',
      'browser_observe',
      'browser_open',
      'browser_screenshot',
    ])
    for (const schema of schemas.values()) {
      if (!schema.name.startsWith('browser_')) continue
      expect(JSON.stringify(schema.parameters)).not.toContain('selector')
    }
  })

  it('shares one Agent environment across tools and releases it on Agent teardown', async () => {
    const opened = await call('browser_open', { url: 'https://example.test/' })
    expect(opened.isError).toBe(false)
    expect(opened.content[0]).toMatchObject({ type: 'text' })

    const observed = await call('browser_observe', {})
    expect(observed.isError).toBe(false)
    const value = observed.value as unknown as ObservationToolValue
    const button = value.observation.elements[0]!
    const clicked = await call('browser_click', {
      observation_id: value.observation.id,
      element_ref: button.ref,
    })
    expect(clicked.isError).toBe(false)

    const screenshot = await call('browser_screenshot', { full_page: true })
    expect(screenshot.isError).toBe(false)
    expect(screenshot.content.some(block => block.type === 'image')).toBe(true)
    expect(provider.opens).toBe(1)

    await agentCtx.fiber.dispose()
    expect(provider.environments[0]?.closes).toBe(1)
  })

  it('surfaces password refusal as a structured browser failure', async () => {
    const observed = await call('browser_observe', {})
    const value = observed.value as unknown as ObservationToolValue
    const password = value.observation.elements.find(element => element.input_type === 'password')!
    const result = await call('browser_fill', {
      observation_id: value.observation.id,
      element_ref: password.ref,
      value: 'secret',
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('BROWSER_PASSWORD_INPUT_FORBIDDEN')
    await agentCtx.fiber.dispose()
  })
})
