import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BrowserRuntime, { BrowserSessionId } from 'dsh-browser-runtime'
import { FakeBrowserProvider } from './fake-provider.ts'
import { FailFirstCheckpointWriteBackend, RejectWritesBackend } from './reject-writes-backend.ts'

interface DurableHarness {
  readonly ctx: Context
  readonly provider: FakeBrowserProvider
  readonly unregister: () => Promise<void>
  dispose(): Promise<void>
}

interface RejectWritesHarness {
  readonly ctx: Context
  readonly provider: FakeBrowserProvider
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

async function rejectWritesHarness(
  provider = new FakeBrowserProvider(),
  initialTables: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
): Promise<RejectWritesHarness> {
  return metadataHarness(provider, new RejectWritesBackend(initialTables))
}

async function metadataHarness(
  provider: FakeBrowserProvider,
  backend: StorageBackend,
): Promise<RejectWritesHarness> {
  const ctx = new Context()
  const storageFiber = await ctx.plugin(Storage)
  const backendPlugin = Object.assign((backendCtx: Context) => {
    const unregister = backendCtx.storage.backend.register('test-metadata', backend)
    backendCtx.effect(() => async () => {
      unregister()
      await backend.close()
    })
    backendCtx.provide(storageBackendServiceKey('test-metadata'), backend)
  }, { inject: ['storage'] })
  const backendFiber = await ctx.plugin(backendPlugin)
  const domainFiber = await ctx.plugin(StorageDomain, { backend: 'test-metadata' })
  const runtimeFiber = await ctx.plugin(BrowserRuntime, { provider: 'fake' })
  const unregisterProvider = ctx.browserRuntime.registerProvider(provider)
  return {
    ctx,
    provider,
    async dispose() {
      await unregisterProvider()
      await runtimeFiber.dispose()
      await domainFiber.dispose()
      await backendFiber.dispose()
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

  it('removes a new provider payload when checkpoint metadata cannot commit', async () => {
    const harness = await rejectWritesHarness()
    const sessionId = BrowserSessionId('failed-checkpoint-commit')
    const lease = await harness.ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'resume', providerId: harness.provider.id,
    })

    const releaseError: unknown = await lease.release().catch((error: unknown) => error)
    expect(releaseError).toBeInstanceOf(AggregateError)
    expect((releaseError as AggregateError).errors).toMatchObject([{
      code: 'BROWSER_CHECKPOINT_METADATA_FAILED',
    }])
    expect(harness.ctx.browserRuntime.checkpointFor(sessionId)).toBeUndefined()
    expect(harness.provider.destroyed).toEqual(['fake-checkpoint-1'])

    await harness.dispose()
  })

  it('serializes same-session checkpoint rollback with the next commit', async () => {
    const backend = new FailFirstCheckpointWriteBackend()
    const provider = new FakeBrowserProvider()
    const harness = await metadataHarness(provider, backend)
    const sessionId = BrowserSessionId('concurrent-checkpoint-rollback')
    const first = await harness.ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'resume', providerId: provider.id,
    })
    const second = await harness.ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'resume', providerId: provider.id,
    })

    const releases = await Promise.allSettled([first.release(), second.release()])
    expect(releases.map(result => result.status)).toEqual(['rejected', 'fulfilled'])
    const checkpoint = harness.ctx.browserRuntime.checkpointFor(sessionId)
    expect(checkpoint?.ref).toBe('fake-checkpoint-2')
    expect(backend.record('checkpoints', sessionId)).toEqual(checkpoint)
    expect(provider.destroyed).toEqual(['fake-checkpoint-1'])

    await harness.dispose()
  })

  it('retains a successful action when the compact transition index write fails', async () => {
    const sessionId = BrowserSessionId('failed-transition-index')
    const priorTransition = {
      id: 'transition-prior',
      sessionId,
      environmentId: 'browser-prior',
      providerId: 'fake',
      generation: 1,
      action: { type: 'navigate', url: 'https://prior.test/' },
      outcome: 'succeeded',
      before: { id: 'observation-prior-before', digest: 'before', url: 'about:blank', revision: 1 },
      after: { id: 'observation-prior-after', digest: 'after', url: 'https://prior.test/', revision: 2 },
      startedAt: '2026-08-27T00:00:00.000Z',
      finishedAt: '2026-08-27T00:00:01.000Z',
    }
    const harness = await rejectWritesHarness(new FakeBrowserProvider(), {
      transitions: { [priorTransition.id]: priorTransition },
    })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const lease = await harness.ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'ephemeral', providerId: harness.provider.id,
    })

    const transition = await lease.act({ type: 'navigate', url: 'https://committed.test/' })
    expect(transition.outcome).toBe('succeeded')
    expect(harness.provider.environments[0]?.url).toBe('https://committed.test/')
    expect(harness.ctx.browserRuntime.listTransitions(sessionId)).toMatchObject([
      { id: priorTransition.id, outcome: 'succeeded' },
      { id: transition.id, outcome: 'succeeded' },
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('compact index write failed'))

    await lease.release()
    await harness.dispose()
  })

  it('preserves the provider failure when the compact transition index write also fails', async () => {
    const providerFailure = new Error('injected provider action failure')
    const harness = await rejectWritesHarness(new FakeBrowserProvider({ actionError: providerFailure }))
    const sessionId = BrowserSessionId('provider-and-index-failure')
    const lease = await harness.ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'ephemeral', providerId: harness.provider.id,
    })

    await expect(lease.act({ type: 'navigate', url: 'https://failed.test/' })).rejects.toMatchObject({
      code: 'BROWSER_ACTION_FAILED',
      cause: providerFailure,
    })
    expect(harness.ctx.browserRuntime.listTransitions(sessionId)).toMatchObject([{
      outcome: 'failed',
      error: { message: providerFailure.message },
    }])

    await lease.release()
    await harness.dispose()
  })

  it('preserves caller cancellation when the compact transition index write also fails', async () => {
    const harness = await rejectWritesHarness(new FakeBrowserProvider({ actionDelayMs: 200 }))
    const sessionId = BrowserSessionId('cancellation-and-index-failure')
    const lease = await harness.ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'ephemeral', providerId: harness.provider.id,
    })
    const controller = new AbortController()
    const cancellation = new Error('caller cancelled browser action')
    const action = lease.act({ type: 'navigate', url: 'https://cancelled.test/' }, controller.signal)
    await vi.waitFor(() => { expect(harness.provider.activeActions).toBe(1) })
    controller.abort(cancellation)

    await expect(action).rejects.toBe(cancellation)
    expect(harness.ctx.browserRuntime.listTransitions(sessionId)).toMatchObject([{
      outcome: 'failed',
    }])

    await lease.release()
    await harness.dispose()
  })
})
