import { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import BrowserRuntime, {
  BrowserProviderId,
  BrowserRuntimeError,
  BrowserSessionId,
} from 'dsh-browser-runtime'
import type { BrowserProvider, BrowserProviderEnvironment } from 'dsh-browser-runtime'
import { FakeBrowserProvider } from './fake-provider.ts'

const signal = new AbortController().signal

async function harness(provider = new FakeBrowserProvider()) {
  const ctx = new Context()
  const runtimeFiber = await ctx.plugin(BrowserRuntime)
  const unregister = ctx.browserRuntime.registerProvider(provider)
  return { ctx, runtimeFiber, provider, unregister }
}

describe('BrowserRuntime provider selection and ownership', () => {
  it('rejects an incomplete checkpoint provider during registration', async () => {
    const ctx = new Context()
    const runtimeFiber = await ctx.plugin(BrowserRuntime)
    const provider: BrowserProvider = {
      id: BrowserProviderId('incomplete-checkpoint'),
      capabilities: {
        checkpoint: true,
        screenshot: false,
        multiplePages: false,
        attachExisting: false,
        persistentProfile: false,
        networkEvents: false,
      },
      available: () => true,
      open: () => Promise.reject(new Error('not reached')),
    }

    expect(() => ctx.browserRuntime.registerProvider(provider)).toThrowError(expect.objectContaining({
      code: 'BROWSER_CHECKPOINT_UNAVAILABLE',
    }))
    await runtimeFiber.dispose()
  })

  it('closes a checkpoint provider environment that omits checkpoint()', async () => {
    const ctx = new Context()
    const runtimeFiber = await ctx.plugin(BrowserRuntime)
    let closes = 0
    const environment: BrowserProviderEnvironment = {
      observe: () => Promise.reject(new Error('not reached')),
      act: () => Promise.reject(new Error('not reached')),
      screenshot: () => Promise.reject(new Error('not reached')),
      close: () => { closes += 1; return Promise.resolve() },
    }
    const provider: BrowserProvider = {
      id: BrowserProviderId('incomplete-environment'),
      capabilities: {
        checkpoint: true,
        screenshot: false,
        multiplePages: false,
        attachExisting: false,
        persistentProfile: false,
        networkEvents: false,
      },
      available: () => true,
      open: () => Promise.resolve(environment),
      restore: () => Promise.resolve(environment),
      destroyCheckpoint: () => Promise.resolve(),
    }
    ctx.browserRuntime.registerProvider(provider)

    await expect(ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('incomplete-environment'),
      persistence: 'ephemeral',
      providerId: provider.id,
    })).rejects.toMatchObject({ code: 'BROWSER_CHECKPOINT_UNAVAILABLE' })
    expect(closes).toBe(1)

    const cleanupFailure = new Error('rejected environment close failed')
    const brokenEnvironment: BrowserProviderEnvironment = {
      ...environment,
      close: () => Promise.reject(cleanupFailure),
    }
    const brokenProvider: BrowserProvider = {
      ...provider,
      id: BrowserProviderId('incomplete-environment-close-failure'),
      open: () => Promise.resolve(brokenEnvironment),
      restore: () => Promise.resolve(brokenEnvironment),
    }
    ctx.browserRuntime.registerProvider(brokenProvider)
    const aggregate = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('incomplete-environment-close-failure'),
      persistence: 'ephemeral',
      providerId: brokenProvider.id,
    }).then(() => undefined, error => error as AggregateError)
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect(aggregate?.errors).toEqual([
      expect.objectContaining({ code: 'BROWSER_CHECKPOINT_UNAVAILABLE' }),
      cleanupFailure,
    ])
    await runtimeFiber.dispose()
  })

  it('rejects duplicate and ambiguous providers without registration-order selection', async () => {
    const { ctx, runtimeFiber, provider } = await harness()
    expect(() => ctx.browserRuntime.registerProvider(provider)).toThrowError(BrowserRuntimeError)
    ctx.browserRuntime.registerProvider(new FakeBrowserProvider({ id: 'other' }))

    await expect(ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('ambiguous'),
      persistence: 'ephemeral',
    })).rejects.toMatchObject({ code: 'BROWSER_PROVIDER_AMBIGUOUS' })
    await runtimeFiber.dispose()
  })

  it.each([
    { selection: 'configured', configured: true },
    { selection: 'automatic', configured: false },
  ])('does not open a $selection Provider after its registration starts disposing', async ({ configured }) => {
    let releaseAvailability = () => {}
    const availabilityBarrier = new Promise<void>((resolve) => { releaseAvailability = resolve })
    const provider = new FakeBrowserProvider({ availabilityBarrier })
    const { ctx, runtimeFiber, unregister } = await harness(provider)
    const acquisition = ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId(`provider-removal-${configured ? 'configured' : 'automatic'}`),
      persistence: 'ephemeral',
      ...(configured ? { providerId: provider.id } : {}),
    })
    await vi.waitFor(() => { expect(provider.availabilityChecks).toBe(1) })

    const removal = unregister()
    await delay(10)
    const disposesBeforeAvailabilitySettled = provider.disposes
    releaseAvailability()
    const outcome = await acquisition.then(async (lease) => {
      await lease.release()
      return { status: 'fulfilled' as const }
    }, (error: unknown) => ({ status: 'rejected' as const, error }))
    await removal

    expect(disposesBeforeAvailabilitySettled).toBe(0)
    expect(outcome).toMatchObject({
      status: 'rejected',
      error: { code: 'BROWSER_ENVIRONMENT_CLOSED' },
    })
    expect(provider.opens).toBe(0)
    expect(provider.disposes).toBe(1)
    await runtimeFiber.dispose()
  })

  it('single-flights setup for one owner and closes only after the last lease', async () => {
    const { ctx, runtimeFiber, provider } = await harness()
    const owner = {}
    const request = {
      owner,
      sessionId: BrowserSessionId('same-owner'),
      persistence: 'ephemeral' as const,
      providerId: provider.id,
      signal,
    }
    const [first, second] = await Promise.all([
      ctx.browserRuntime.acquire(request),
      ctx.browserRuntime.acquire(request),
    ])

    expect(provider.opens).toBe(1)
    expect(first.environmentId).toBe(second.environmentId)
    await first.release()
    expect(provider.environments[0]?.closes).toBe(0)
    await second.release()
    expect(provider.environments[0]?.closes).toBe(1)
    await runtimeFiber.dispose()
  })

  it('keeps shared setup alive when one acquire caller cancels', async () => {
    const provider = new FakeBrowserProvider({ openDelayMs: 40 })
    const { ctx, runtimeFiber } = await harness(provider)
    const owner = {}
    const sessionId = BrowserSessionId('independent-acquire-cancellation')
    const cancelled = new AbortController()
    const first = ctx.browserRuntime.acquire({
      owner,
      sessionId,
      persistence: 'ephemeral',
      providerId: provider.id,
      signal: cancelled.signal,
    })
    const second = ctx.browserRuntime.acquire({
      owner,
      sessionId,
      persistence: 'ephemeral',
      providerId: provider.id,
    })

    await delay(5)
    cancelled.abort(new Error('first acquire cancelled'))

    await expect(first).rejects.toThrow('first acquire cancelled')
    const lease = await second
    expect(provider.opens).toBe(1)
    await lease.release()
    await runtimeFiber.dispose()
  })

  it('treats last-waiter cancellation as successful setup rollback', async () => {
    const provider = new FakeBrowserProvider({ openDelayMs: 40 })
    const { ctx, runtimeFiber } = await harness(provider)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const cancelled = new AbortController()
    const acquisition = ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('cancelled-owner-setup'),
      persistence: 'ephemeral',
      providerId: provider.id,
      signal: cancelled.signal,
    })

    await delay(5)
    cancelled.abort(new Error('only acquire cancelled'))

    await expect(acquisition).rejects.toThrow('only acquire cancelled')
    await runtimeFiber.dispose()
    expect(provider.environments).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('isolates different owner objects even when they share a session id', async () => {
    const { ctx, runtimeFiber, provider } = await harness()
    const sessionId = BrowserSessionId('shared-id')
    const [first, second] = await Promise.all([
      ctx.browserRuntime.acquire({ owner: {}, sessionId, persistence: 'ephemeral', providerId: provider.id }),
      ctx.browserRuntime.acquire({ owner: {}, sessionId, persistence: 'ephemeral', providerId: provider.id }),
    ])
    expect(first.environmentId).not.toBe(second.environmentId)
    expect(provider.opens).toBe(2)
    await Promise.all([first.release(), second.release()])
    await runtimeFiber.dispose()
  })

  it('fails a conflicting second request for the same owner', async () => {
    const { ctx, runtimeFiber, provider } = await harness()
    const owner = {}
    const lease = await ctx.browserRuntime.acquire({
      owner,
      sessionId: BrowserSessionId('first'),
      persistence: 'ephemeral',
      providerId: provider.id,
    })
    await expect(ctx.browserRuntime.acquire({
      owner,
      sessionId: BrowserSessionId('second'),
      persistence: 'ephemeral',
      providerId: provider.id,
    })).rejects.toMatchObject({ code: 'BROWSER_OWNER_CONFLICT' })
    await lease.release()
    await runtimeFiber.dispose()
  })
})

describe('BrowserRuntime observation, evidence, and concurrency', () => {
  it('rejects element refs from any observation except the latest', async () => {
    const { ctx, runtimeFiber, provider } = await harness()
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('stale'),
      persistence: 'ephemeral',
      providerId: provider.id,
    })
    const first = await lease.observe()
    await lease.observe()
    await expect(lease.act({
      type: 'click',
      observationId: first.id,
      elementRef: first.elements[0]!.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_STALE_REFERENCE' })
    await lease.release()
    await runtimeFiber.dispose()
  })

  it('serializes operations per environment while different environments overlap', async () => {
    const provider = new FakeBrowserProvider({ actionDelayMs: 20 })
    const { ctx, runtimeFiber } = await harness(provider)
    const first = await ctx.browserRuntime.acquire({
      owner: {}, sessionId: BrowserSessionId('one'), persistence: 'ephemeral', providerId: provider.id,
    })
    const second = await ctx.browserRuntime.acquire({
      owner: {}, sessionId: BrowserSessionId('two'), persistence: 'ephemeral', providerId: provider.id,
    })
    await Promise.all([
      first.act({ type: 'navigate', url: 'https://one.test/a' }),
      first.act({ type: 'navigate', url: 'https://one.test/b' }),
      second.act({ type: 'navigate', url: 'https://two.test/a' }),
    ])
    expect(provider.environments[0]?.maxActiveActions).toBe(1)
    expect(provider.maxActiveActions).toBe(2)
    await Promise.all([first.release(), second.release()])
    await runtimeFiber.dispose()
  })

  it('redacts fill values from transition evidence and rejects password fields', async () => {
    const { ctx, runtimeFiber, provider } = await harness()
    const sessionId = BrowserSessionId('evidence')
    const lease = await ctx.browserRuntime.acquire({ owner: {}, sessionId, persistence: 'ephemeral', providerId: provider.id })
    const observation = await lease.observe()
    const textInput = observation.elements.find(element => element.inputType === 'text')!
    const password = observation.elements.find(element => element.inputType === 'password')!
    await lease.act({
      type: 'fill', observationId: observation.id, elementRef: textInput.ref, value: 'not-a-secret',
    })
    const next = await lease.observe()
    await expect(lease.act({
      type: 'fill', observationId: next.id, elementRef: password.ref, value: 'secret',
    })).rejects.toMatchObject({ code: 'BROWSER_PASSWORD_INPUT_FORBIDDEN' })
    const transitions = ctx.browserRuntime.listTransitions(sessionId)
    expect(transitions).toHaveLength(1)
    expect(transitions[0]?.action).toEqual({
      type: 'fill', elementRef: textInput.ref, value: '[REDACTED]', valueLength: 12,
    })
    expect(JSON.stringify(transitions)).not.toContain('not-a-secret')
    await lease.release()
    await runtimeFiber.dispose()
  })
})

describe('BrowserRuntime checkpoint and teardown', () => {
  it('keeps same-session checkpoint ordering when a queued caller cancels', async () => {
    let releaseCheckpoint = () => {}
    const checkpointBarrier = new Promise<void>((resolve) => { releaseCheckpoint = resolve })
    const provider = new FakeBrowserProvider({ checkpointBarrier })
    const { ctx, runtimeFiber } = await harness(provider)
    const sessionId = BrowserSessionId('cancelled-checkpoint-waiter')
    const first = await ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'ephemeral', providerId: provider.id,
    })
    const second = await ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'ephemeral', providerId: provider.id,
    })
    const third = await ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'ephemeral', providerId: provider.id,
    })

    const firstCheckpoint = first.checkpoint()
    await vi.waitFor(() => {
      expect(provider.environments.reduce((count, environment) => count + environment.checkpoints, 0)).toBe(1)
    })
    const controller = new AbortController()
    const cancellation = new Error('cancelled queued checkpoint')
    const cancelledCheckpoint = second.checkpoint(controller.signal)
    await delay(5)
    controller.abort(cancellation)
    await expect(cancelledCheckpoint).rejects.toBe(cancellation)

    const thirdCheckpoint = third.checkpoint()
    await delay(10)
    expect(provider.environments.reduce((count, environment) => count + environment.checkpoints, 0)).toBe(1)
    releaseCheckpoint()
    await Promise.all([firstCheckpoint, thirdCheckpoint])
    expect(provider.environments.reduce((count, environment) => count + environment.checkpoints, 0)).toBe(2)

    await Promise.all([first.release(), second.release(), third.release()])
    await runtimeFiber.dispose()
  })

  it('rejects cross-provider checkpoint replacement before creating a payload', async () => {
    const { ctx, runtimeFiber, provider } = await harness()
    const other = new FakeBrowserProvider({ id: 'other' })
    ctx.browserRuntime.registerProvider(other)
    const sessionId = BrowserSessionId('cross-provider-checkpoint-replacement')
    const first = await ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'resume', providerId: provider.id,
    })
    const second = await ctx.browserRuntime.acquire({
      owner: {}, sessionId, persistence: 'resume', providerId: other.id,
    })

    await first.release()
    const secondRelease = await second.release().catch((error: unknown) => error)
    expect(secondRelease).toBeInstanceOf(AggregateError)
    expect((secondRelease as AggregateError).errors).toMatchObject([{
      code: 'BROWSER_CHECKPOINT_PROVIDER_MISMATCH',
    }])
    expect(ctx.browserRuntime.checkpointFor(sessionId)?.providerId).toBe(provider.id)
    expect(other.environments[0]?.checkpoints).toBe(0)
    expect(provider.destroyed).toEqual([])

    await runtimeFiber.dispose()
  })

  it('checkpoints on last release and restores with a new generation', async () => {
    const { ctx, runtimeFiber, provider } = await harness()
    const owner = {}
    const sessionId = BrowserSessionId('resume')
    const first = await ctx.browserRuntime.acquire({
      owner, sessionId, persistence: 'resume', providerId: provider.id,
    })
    expect(first.generation).toBe(1)
    await first.release()
    expect(ctx.browserRuntime.checkpointFor(sessionId)?.providerId).toBe(provider.id)

    const second = await ctx.browserRuntime.acquire({
      owner, sessionId, persistence: 'resume', providerId: provider.id,
    })
    expect(second.generation).toBe(2)
    expect(provider.restores).toBe(1)
    await second.release()
    expect(provider.destroyed).toHaveLength(1)
    await runtimeFiber.dispose()
  })

  it('attempts close after checkpoint failure and reports both cleanup failures', async () => {
    const provider = new FakeBrowserProvider({
      checkpointError: new Error('checkpoint failed'),
      closeError: new Error('close failed'),
    })
    const { ctx, runtimeFiber } = await harness(provider)
    const lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('double-failure'),
      persistence: 'resume',
      providerId: provider.id,
    })
    const error = await lease.release().then(() => undefined, value => value as AggregateError)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error?.errors).toHaveLength(2)
    expect(provider.environments[0]?.checkpoints).toBe(1)
    expect(provider.environments[0]?.closes).toBe(1)
    await runtimeFiber.dispose()
  })

  it('drains provider environments before provider-wide disposal', async () => {
    const { ctx, runtimeFiber, provider, unregister } = await harness()
    const lease = await ctx.browserRuntime.acquire({
      owner: {}, sessionId: BrowserSessionId('provider-drain'), persistence: 'ephemeral', providerId: provider.id,
    })
    await unregister()
    expect(provider.environments[0]?.closes).toBe(1)
    expect(provider.disposes).toBe(1)
    await expect(lease.observe()).rejects.toMatchObject({ code: 'BROWSER_ENVIRONMENT_CLOSED' })
    await lease.release()
    await runtimeFiber.dispose()
  })

  it('closes an unreleased environment when the runtime fiber disposes', async () => {
    const { ctx, runtimeFiber, provider } = await harness()
    await ctx.browserRuntime.acquire({
      owner: {}, sessionId: BrowserSessionId('runtime-dispose'), persistence: 'ephemeral', providerId: provider.id,
    })
    await runtimeFiber.dispose()
    expect(provider.environments[0]?.closes).toBe(1)
  })

  it('fails a checkpoint restore through a different provider', async () => {
    const { ctx, runtimeFiber, provider } = await harness()
    const owner = {}
    const sessionId = BrowserSessionId('provider-mismatch')
    const lease = await ctx.browserRuntime.acquire({ owner, sessionId, persistence: 'resume', providerId: provider.id })
    await lease.release()
    ctx.browserRuntime.registerProvider(new FakeBrowserProvider({ id: 'other' }))
    await expect(ctx.browserRuntime.acquire({
      owner,
      sessionId,
      persistence: 'resume',
      providerId: BrowserProviderId('other'),
    })).rejects.toMatchObject({ code: 'BROWSER_CHECKPOINT_PROVIDER_MISMATCH' })
    await runtimeFiber.dispose()
  })
})
