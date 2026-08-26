import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BrowserRuntime, { BrowserSessionId } from 'dsh-browser-runtime'
import { FakeBrowserProvider } from './fake-provider.ts'

interface DurableHarness {
  readonly ctx: Context
  readonly provider: FakeBrowserProvider
  readonly unregister: () => Promise<void>
  dispose(): Promise<void>
}

async function durableHarness(root: string): Promise<DurableHarness> {
  const ctx = new Context()
  const storageFiber = await ctx.plugin(Storage)
  const jsonFiber = await ctx.plugin(StorageJson, { root })
  const domainFiber = await ctx.plugin(StorageDomain, { backend: 'json' })
  const runtimeFiber = await ctx.plugin(BrowserRuntime, { provider: 'fake' })
  const provider = new FakeBrowserProvider()
  const unregister = ctx.browserRuntime.registerProvider(provider)
  return {
    ctx,
    provider,
    unregister,
    async dispose() {
      await unregister()
      await runtimeFiber.dispose()
      await domainFiber.dispose()
      await jsonFiber.dispose()
      await storageFiber.dispose()
    },
  }
}

describe('storage-domain checkpoint index', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'browser-runtime-storage-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('restores a checkpoint index after the complete Cordis tree restarts', async () => {
    const sessionId = BrowserSessionId('durable-resume')
    const first = await durableHarness(root)
    const lease = await first.ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'resume', providerId: first.provider.id,
    })
    await lease.release()
    await first.dispose()
    expect(await readFile(join(root, 'browser_runtime.json'), 'utf8')).toContain('durable-resume')

    const second = await durableHarness(root)
    await vi.waitFor(() => {
      expect(second.ctx.browserRuntime.checkpointFor(sessionId)).toBeDefined()
    })
    const restored = await second.ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'resume', providerId: second.provider.id,
    })
    expect(restored.generation).toBe(2)
    expect(second.provider.restores).toBe(1)
    await restored.release()
    await second.dispose()
  })
})
