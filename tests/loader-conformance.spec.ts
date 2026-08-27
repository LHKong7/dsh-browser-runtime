import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as BrowserRuntimeEntry from 'dsh-browser-runtime'
import * as PlaywrightEntry from 'dsh-browser-runtime/playwright'
import * as ToolsEntry from 'dsh-browser-runtime/tools'

/**
 * The DSH Loader unwraps an imported module with `exports.default ?? exports`,
 * so a functional plugin that also default-exports `apply` loses `inject`,
 * `Config`, and `name`. These tests run the real Loader method over the real
 * entry-point namespaces and then mount the unwrapped plugins.
 */
const unwrapExports = Loader.prototype.unwrapExports as (exports: unknown) => unknown

const limits: ImageAttachmentLimits = {
  maxImageBytes: 1_000_000,
  maxImagesPerMessage: 10,
  maxMessageImageBytes: 10_000_000,
  maxImagePixels: 1_000_000,
  maxImageDimension: 2_000,
  mediaTypes: ['image/png'],
}

class StubAttachments extends AttachmentStore {
  readonly imageLimits = limits

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.resolve({
      attachmentId: AttachmentId(`sha256:${'0'.repeat(64)}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    })
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    throw new Error('not used')
  }
}

let ctx: Context

beforeEach(() => {
  ctx = new Context()
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('Loader.unwrapExports over the published entry points', () => {
  it('keeps the functional Provider plugin contract', () => {
    const plugin = unwrapExports(PlaywrightEntry) as Record<string, unknown>
    expect(plugin).toBe(PlaywrightEntry)
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.name).toBe('browser-playwright')
    expect(plugin.inject).toEqual(['browserRuntime'])
    expect(plugin.Config).toBeTypeOf('function')
  })

  it('keeps the functional Tools plugin contract', () => {
    const plugin = unwrapExports(ToolsEntry) as Record<string, unknown>
    expect(plugin).toBe(ToolsEntry)
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.name).toBe('tool-browser')
    expect(plugin.inject).toEqual(['tools', 'browserRuntime', 'systemPrompt', 'attachments'])
    expect(plugin.Config).toBeTypeOf('function')
  })

  it('unwraps the Service entry to a class carrying its static Config', () => {
    const plugin = unwrapExports(BrowserRuntimeEntry) as { Config?: unknown }
    expect(plugin).toBe(BrowserRuntimeEntry.BrowserRuntime)
    expect(typeof plugin).toBe('function')
    expect(plugin.Config).toBeTypeOf('function')
  })

  it('leaves a nullable module untouched', () => {
    expect(unwrapExports(undefined)).toBeUndefined()
    expect(unwrapExports(null)).toBeNull()
  })
})

describe('mounting every unwrapped entry point in a real Cordis Context', () => {
  it('activates browser-runtime, browser-playwright, and tool-browser', async () => {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    new StubAttachments(ctx)

    const runtimePlugin = unwrapExports(BrowserRuntimeEntry) as typeof BrowserRuntimeEntry.BrowserRuntime
    const providerPlugin = unwrapExports(PlaywrightEntry) as typeof PlaywrightEntry
    const toolsPlugin = unwrapExports(ToolsEntry) as typeof ToolsEntry

    const runtimeFiber = await ctx.plugin(runtimePlugin, { provider: 'playwright' })
    expect(ctx.get('browserRuntime')).toBeDefined()

    const providerFiber = await ctx.plugin(providerPlugin, { headless: true })
    const toolsFiber = await ctx.plugin(toolsPlugin, { provider: 'playwright' })

    expect(runtimeFiber.runtime?.callback).toBe(ctx.registry.resolve(runtimePlugin))
    expect(providerFiber.runtime?.callback).toBe(providerPlugin.apply)
    expect(toolsFiber.runtime?.callback).toBe(toolsPlugin.apply)

    const providers = await ctx.browserRuntime.listProviders()
    expect(providers.map(provider => provider.id)).toEqual(['playwright'])

    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('browser_')))
      .toContain('browser_open')
  })

  it('validates the Provider Config schema the Loader would have dropped', async () => {
    await ctx.plugin(unwrapExports(BrowserRuntimeEntry) as typeof BrowserRuntimeEntry.BrowserRuntime, {})
    const providerPlugin = unwrapExports(PlaywrightEntry) as typeof PlaywrightEntry
    await expect(ctx.plugin(providerPlugin, { maxElements: 'many' } as never)).rejects.toThrow()
  })
})
