import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import BrowserRuntime, {
  BrowserProviderId,
  BrowserRuntimeError,
  BrowserSessionId,
} from 'dsh-browser-runtime'
import { FakeBrowserProvider } from './fake-provider.ts'

const signal = new AbortController().signal

async function harness(provider = new FakeBrowserProvider()) {
  const ctx = new Context()
  const runtimeFiber = await ctx.plugin(BrowserRuntime)
  const unregister = ctx.browserRuntime.registerProvider(provider)
  return { ctx, runtimeFiber, provider, unregister }
}

describe('BrowserRuntime provider selection and ownership', () => {
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
