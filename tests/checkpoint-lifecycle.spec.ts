import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrowserRuntime, {
  BrowserProviderCheckpointMissingError,
  BrowserSessionId,
} from 'dsh-browser-runtime'
import type { BrowserEnvironmentLease } from 'dsh-browser-runtime'
import { FakeBrowserProvider } from './fake-provider.ts'

interface Harness {
  readonly ctx: Context
  readonly provider: FakeBrowserProvider
  dispose(): Promise<void>
}

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function open(config: Record<string, unknown> = {}, provider = new FakeBrowserProvider()): Promise<Harness> {
  const ctx = new Context()
  const runtimeFiber = await ctx.plugin(BrowserRuntime, { provider: 'fake', ...config })
  const unregister = ctx.browserRuntime.registerProvider(provider)
  harness = {
    ctx,
    provider,
    async dispose() {
      await unregister()
      await runtimeFiber.dispose()
      await ctx.fiber.dispose()
    },
  }
  return harness
}

/** Create and release one resume environment, leaving its checkpoint indexed. */
async function checkpoint(ctx: Context, sessionId: string): Promise<void> {
  const lease = await ctx.browserRuntime.acquire({
    owner: {},
    sessionId: BrowserSessionId(sessionId),
    persistence: 'resume',
  })
  await lease.act({ type: 'navigate', url: `https://${sessionId}.test/` })
  await lease.release()
}

describe('checkpoint retention', () => {
  it('lists indexed checkpoints newest first', async () => {
    const { ctx } = await open()
    await checkpoint(ctx, 'first')
    await checkpoint(ctx, 'second')
    const listed = ctx.browserRuntime.listCheckpoints()
    expect(listed).toHaveLength(2)
    const [newest, oldest] = listed
    expect((newest?.createdAt ?? '') >= (oldest?.createdAt ?? '')).toBe(true)
  })

  it('drops the oldest checkpoints beyond the configured maximum', async () => {
    const { ctx, provider } = await open({ maxCheckpoints: 2 })
    for (const session of ['a', 'b', 'c', 'd']) await checkpoint(ctx, session)

    const removed = await ctx.browserRuntime.pruneCheckpoints()
    expect(removed).toHaveLength(2)
    const remaining = ctx.browserRuntime.listCheckpoints().map(record => record.sessionId)
    expect(remaining).toHaveLength(2)
    expect(remaining).not.toContain('a')
    // The dropped payloads are destroyed, not merely unindexed.
    expect(provider.destroyed).toHaveLength(2)
  })

  it('drops checkpoints past the configured age', async () => {
    const { ctx } = await open({ checkpointTtlMs: 50 })
    await checkpoint(ctx, 'stale')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 5_000)
      expect(await ctx.browserRuntime.pruneCheckpoints()).toEqual([BrowserSessionId('stale')])
    } finally {
      vi.useRealTimers()
    }
    expect(ctx.browserRuntime.listCheckpoints()).toHaveLength(0)
  })

  it('retains everything when no age is configured', async () => {
    const { ctx } = await open({ checkpointTtlMs: 0, maxCheckpoints: 10 })
    await checkpoint(ctx, 'kept')
    expect(await ctx.browserRuntime.pruneCheckpoints()).toEqual([])
    expect(ctx.browserRuntime.listCheckpoints()).toHaveLength(1)
  })

  it('never prunes a checkpoint whose session still holds an environment', async () => {
    const { ctx } = await open({ maxCheckpoints: 1 })
    await checkpoint(ctx, 'released')
    const live: BrowserEnvironmentLease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('live'),
      persistence: 'resume',
    })
    await live.checkpoint()

    expect(await ctx.browserRuntime.pruneCheckpoints()).toEqual([BrowserSessionId('released')])
    expect(ctx.browserRuntime.checkpointFor(BrowserSessionId('live'))).toBeDefined()
    await live.release()
  })

  it('rejects a non-integer retention configuration at load time', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(BrowserRuntime, { maxCheckpoints: 0 })).rejects.toThrow(/maxCheckpoints/)
    await expect(ctx.plugin(BrowserRuntime, { checkpointTtlMs: -1 })).rejects.toThrow(/checkpointTtlMs/)
    await ctx.fiber.dispose()
  })
})

describe('checkpoint provider compatibility', () => {
  it('records the provider build that wrote the payload', async () => {
    const provider = new FakeBrowserProvider()
    Object.assign(provider, { version: '1.62.1' })
    const { ctx } = await open({}, provider)
    await checkpoint(ctx, 'versioned')
    expect(ctx.browserRuntime.checkpointFor(BrowserSessionId('versioned'))?.providerVersion).toBe('1.62.1')
  })

  it('refuses to restore a payload another provider build wrote', async () => {
    const provider = new FakeBrowserProvider()
    Object.assign(provider, { version: '1.62.1' })
    const { ctx } = await open({}, provider)
    await checkpoint(ctx, 'versioned')

    Object.assign(provider, { version: '1.63.0' })
    await expect(ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('versioned'),
      persistence: 'resume',
    })).rejects.toMatchObject({ code: 'BROWSER_CHECKPOINT_VERSION_MISMATCH' })
  })

  it('restores a payload written before provider versions were tracked', async () => {
    const provider = new FakeBrowserProvider()
    const { ctx } = await open({}, provider)
    await checkpoint(ctx, 'unversioned')
    Object.assign(provider, { version: '1.62.1' })
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('unversioned'),
      persistence: 'resume',
    })
    expect(lease.generation).toBe(2)
    await lease.release()
  })
})

describe('a checkpoint payload cleared out of band', () => {
  it('opens a fresh environment and forgets the index entry', async () => {
    const provider = new FakeBrowserProvider()
    const { ctx } = await open({}, provider)
    await checkpoint(ctx, 'cleared')
    expect(ctx.browserRuntime.checkpointFor(BrowserSessionId('cleared'))).toBeDefined()

    const restore = vi.spyOn(provider, 'restore').mockRejectedValue(new BrowserProviderCheckpointMissingError())
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('cleared'),
      persistence: 'resume',
    })
    expect(restore).toHaveBeenCalledTimes(1)
    // A fresh environment is generation 1, not a continuation of the lost one.
    expect(lease.generation).toBe(1)
    expect(ctx.browserRuntime.checkpointFor(BrowserSessionId('cleared'))).toBeUndefined()
    await lease.release()
  })

  it('still surfaces an ordinary restore failure', async () => {
    const provider = new FakeBrowserProvider()
    const { ctx } = await open({}, provider)
    await checkpoint(ctx, 'broken')
    const failure = new Error('checkpoint payload is corrupt')
    vi.spyOn(provider, 'restore').mockRejectedValue(failure)
    await expect(ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('broken'),
      persistence: 'resume',
    })).rejects.toBe(failure)
    expect(ctx.browserRuntime.checkpointFor(BrowserSessionId('broken'))).toBeDefined()
  })
})
