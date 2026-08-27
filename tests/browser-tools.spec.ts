import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserCredentialStore } from 'dsh-browser-runtime/tools'
import type { ObservationValue } from 'dsh-browser-runtime/tools'
import { toolHarness } from './tool-harness.ts'
import type { ToolHarness } from './tool-harness.ts'

interface ObservationResult {
  observation: ObservationValue
}

interface ActionResult {
  transition: {
    id: string
    outcome: string
    metrics: {
      duration_ms: number
      action_ms: number
      observation_ms: number
      text_chars: number
      element_count: number
      text_truncated: boolean
      elements_truncated: boolean
    }
  }
  observation: ObservationValue
}

interface ExtractionResult {
  kind: string
  columns: string[]
  rows: Record<string, string>[]
  total: number
  truncated: boolean
}

let harness: ToolHarness

afterEach(async () => {
  await harness.dispose()
})

async function observe(mode?: string, extra: Record<string, unknown> = {}): Promise<ObservationValue> {
  const result = await harness.call('browser_observe', {
    ...(mode === undefined ? {} : { mode }),
    ...extra,
  })
  expect(result.isError).toBe(false)
  return (result.value as unknown as ObservationResult).observation
}

describe('observation modes and ranking', () => {
  beforeEach(async () => {
    harness = await toolHarness()
  })

  it('defaults to summary and keeps controls, pagination, and record titles', async () => {
    const observation = await observe()
    expect(observation.mode).toBe('summary')
    const priorities = observation.elements.map(element => element.priority)
    expect(priorities.every(priority => priority <= 3)).toBe(true)
    expect(observation.elements.some(element => element.pagination)).toBe(true)
    // The two priority-5 per-record links stay out of the summary budget.
    expect(observation.elements.map(element => element.name)).not.toContain('Jane Author')
    expect(observation.total_elements).toBe(7)
  })

  it('returns every ranked element and no page text in interactive mode', async () => {
    const observation = await observe('interactive')
    expect(observation.mode).toBe('interactive')
    expect(observation.text).toBe('')
    expect(observation.elements).toHaveLength(7)
    expect(observation.elements.map(element => element.name)).toContain('Jane Author')
  })

  it('returns page text with only reading controls in document mode', async () => {
    await harness.call('browser_open', { url: 'https://example.test/' })
    const observation = await observe('document')
    expect(observation.mode).toBe('document')
    expect(observation.text).toContain('Page at https://example.test/')
    expect(observation.elements.every(element => element.priority <= 2)).toBe(true)
  })

  it('collapses repeated per-record links into records', async () => {
    const observation = await observe('interactive')
    const records = new Map(observation.groups.map(group => [group.label, group]))
    expect([...records.keys()]).toEqual(['A paper about browsers', 'Another paper'])
    const paper = records.get('A paper about browsers')
    expect(paper?.elements).toHaveLength(2)
    const refs = new Set(paper?.elements)
    const names = observation.elements
      .filter(element => refs.has(element.ref))
      .map(element => element.name)
    expect(names).toEqual(['A paper about browsers', 'Download PDF'])
  })

  it('honours explicit per-call budgets under the configured caps', async () => {
    const observation = await observe('interactive', { max_elements: 2 })
    expect(observation.elements).toHaveLength(2)
    expect(observation.elements_truncated).toBe(true)
    expect(observation.continuation).toBeTypeOf('string')
  })
})

describe('observation pagination', () => {
  beforeEach(async () => {
    harness = await toolHarness({ config: { observeMode: 'interactive' } })
  })

  it('reads the rest of one observation without invalidating its refs', async () => {
    const first = await observe('interactive', { max_elements: 3 })
    expect(first.elements).toHaveLength(3)
    expect(first.element_offset).toBe(0)
    const continuation = first.continuation
    expect(continuation).toBeTypeOf('string')

    const next = await harness.call('browser_observe_next', { continuation })
    expect(next.isError).toBe(false)
    const second = (next.value as unknown as ObservationResult).observation
    expect(second.id).toBe(first.id)
    expect(second.element_offset).toBe(3)
    expect(second.elements.map(element => element.ref)).not.toEqual(first.elements.map(element => element.ref))

    // Refs from the paged observation still act, because nothing re-observed.
    const clicked = await harness.call('browser_click', {
      observation_id: first.id,
      element_ref: first.elements[0]?.ref,
    })
    expect(clicked.isError).toBe(false)
  })

  it('exhausts the continuation at the end of the observation', async () => {
    const first = await observe('interactive', { max_elements: 4 })
    const next = await harness.call('browser_observe_next', { continuation: first.continuation })
    const second = (next.value as unknown as ObservationResult).observation
    expect(second.continuation).toBeUndefined()

    const beyond = await harness.call('browser_observe_next', { continuation: 'cursor-1' })
    expect(beyond.isError).toBe(true)
    expect(beyond.error?.info?.code).toBe('BROWSER_CONTINUATION_EXHAUSTED')
  })

  it('rejects a continuation a newer observation replaced', async () => {
    const first = await observe('interactive', { max_elements: 2 })
    await observe('interactive', { max_elements: 2 })
    const stale = await harness.call('browser_observe_next', { continuation: first.continuation })
    expect(stale.isError).toBe(true)
    expect(stale.error?.info?.code).toBe('BROWSER_OBSERVATION_SUPERSEDED')
    expect(stale.error?.message).toContain('recommended_action=browser_observe')
  })
})

describe('interaction tools', () => {
  beforeEach(async () => {
    harness = await toolHarness()
  })

  async function target(): Promise<{ observationId: string; ref: string }> {
    const observation = await observe('interactive')
    return { observationId: observation.id, ref: observation.elements[1]?.ref as string }
  }

  it('presses an allowlisted key on an observed element', async () => {
    const { observationId, ref } = await target()
    const result = await harness.call('browser_press', {
      key: 'Enter',
      observation_id: observationId,
      element_ref: ref,
    })
    expect(result.isError).toBe(false)
    expect((result.value as unknown as ActionResult).observation.text).toContain('Pressed Enter')
  })

  it('presses a key without an element reference', async () => {
    const result = await harness.call('browser_press', { key: 'Escape' })
    expect(result.isError).toBe(false)
  })

  it('rejects a key outside the allowlist before dispatch', async () => {
    const result = await harness.call('browser_press', { key: 'Control+A' })
    expect(result.isError).toBe(true)
  })

  it('selects, checks, scrolls, waits, and moves through history', async () => {
    // Every action mints a new observation, so each element-addressed call
    // re-observes first rather than reusing a reference the action invalidated.
    const calls: ((id: string, ref: string) => [string, Record<string, unknown>])[] = [
      (id, ref) => ['browser_select', { observation_id: id, element_ref: ref, values: ['one'] }],
      (id, ref) => ['browser_check', { observation_id: id, element_ref: ref, checked: true }],
      (id, ref) => ['browser_scroll', { to: 'element', observation_id: id, element_ref: ref }],
      () => ['browser_scroll', { to: 'down', pages: 2 }],
      () => ['browser_wait', { until: 'network-idle' }],
      () => ['browser_reload', {}],
      () => ['browser_back', {}],
      () => ['browser_forward', {}],
    ]
    for (const build of calls) {
      const { observationId, ref } = await target()
      const [name, args] = build(observationId, ref)
      const result = await harness.call(name, args)
      expect(result.isError, `${name} failed: ${result.error?.message}`).toBe(false)
    }
  })

  it('rejects an empty select value list', async () => {
    const { observationId, ref } = await target()
    const result = await harness.call('browser_select', {
      observation_id: observationId,
      element_ref: ref,
      values: [],
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('BROWSER_INVALID_ARGUMENT')
  })

  it('requires an observation id alongside an element reference', async () => {
    const { ref } = await target()
    const result = await harness.call('browser_press', { key: 'Enter', element_ref: ref })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('BROWSER_OBSERVATION_REQUIRED')
  })
})

describe('transition metrics and failure evidence', () => {
  beforeEach(async () => {
    harness = await toolHarness()
  })

  it('reports timing and output size with every action', async () => {
    const result = await harness.call('browser_open', { url: 'https://example.test/' })
    expect(result.isError).toBe(false)
    const metrics = (result.value as unknown as ActionResult).transition.metrics
    expect(metrics.duration_ms).toBeGreaterThanOrEqual(0)
    expect(metrics.action_ms).toBeLessThanOrEqual(metrics.duration_ms)
    expect(metrics.observation_ms).toBeLessThanOrEqual(metrics.duration_ms)
    expect(metrics.text_chars).toBe('Page at https://example.test/'.length)
    expect(metrics.element_count).toBe(7)
    expect(metrics.text_truncated).toBe(false)
    expect(metrics.elements_truncated).toBe(false)
  })

  it('routes a stale reference to a re-observation without retrying', async () => {
    const first = await observe('interactive')
    await observe('interactive')
    const result = await harness.call('browser_click', {
      observation_id: first.id,
      element_ref: first.elements[0]?.ref,
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('BROWSER_STALE_REFERENCE')
    expect(result.error?.message).toContain('code=BROWSER_STALE_REFERENCE')
    expect(result.error?.message).toContain('observation=invalid')
    expect(result.error?.message).toContain('lease=intact')
    expect(result.error?.message).toContain('recommended_action=browser_observe')
    expect(result.error?.message).toContain('retryable=false')
  })

  it('reports the last known page URL in failure evidence', async () => {
    const opened = await harness.call('browser_open', { url: 'https://evidence.test/' })
    expect(opened.isError).toBe(false)
    const result = await harness.call('browser_click', {
      observation_id: 'observation-not-real',
      element_ref: 'e1',
    })
    expect(result.error?.message).toContain('url=https://evidence.test/')
  })

  it('points a password refusal at the credential channel', async () => {
    const observation = await observe('interactive')
    const password = observation.elements.find(element => element.input_type === 'password')
    const result = await harness.call('browser_fill', {
      observation_id: observation.id,
      element_ref: password?.ref,
      value: 'not-a-real-secret',
    })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('recommended_action=browser_fill_credential')
    expect(result.error?.message).toContain('retryable=false')
  })
})

describe('two Agents sharing one tool suite', () => {
  beforeEach(async () => {
    harness = await toolHarness({ config: { observeMode: 'interactive' } })
  })

  it('gives each Agent its own environment and rejects the other\'s references', async () => {
    const second = harness.addAgent('second-agent')

    const [openedFirst, openedSecond] = await Promise.all([
      harness.call('browser_open', { url: 'https://first.test/' }),
      second.call('browser_open', { url: 'https://second.test/' }),
    ])
    expect(openedFirst.isError, openedFirst.error?.message).toBe(false)
    expect(openedSecond.isError, openedSecond.error?.message).toBe(false)

    const first = (openedFirst.value as unknown as ActionResult).observation
    const other = (openedSecond.value as unknown as ActionResult).observation
    expect(first.environment_id).not.toBe(other.environment_id)
    expect(first.url).toBe('https://first.test/')
    expect(other.url).toBe('https://second.test/')
    expect(harness.provider.opens).toBe(2)

    // An observation minted for one Agent is not addressable from the other.
    const crossed = await second.call('browser_click', {
      observation_id: first.id,
      element_ref: first.elements[0]?.ref,
    })
    expect(crossed.isError).toBe(true)
    expect(crossed.error?.info?.code).toBe('BROWSER_STALE_REFERENCE')

    // Each Agent's own reference still acts against its own page.
    const own = await second.call('browser_click', {
      observation_id: other.id,
      element_ref: other.elements[0]?.ref,
    })
    expect(own.isError, own.error?.message).toBe(false)
  })

  it('releases only the disposed Agent\'s environment', async () => {
    const second = harness.addAgent('disposable-agent')
    await harness.call('browser_open', { url: 'https://kept.test/' })
    await second.call('browser_open', { url: 'https://dropped.test/' })
    expect(harness.provider.opens).toBe(2)

    await second.ctx.fiber.dispose()
    expect(harness.provider.environments.filter(environment => environment.closes > 0)).toHaveLength(1)

    const still = await harness.call('browser_observe', {})
    expect(still.isError, still.error?.message).toBe(false)
    expect(harness.provider.opens).toBe(2)
  })
})

describe('structured extraction', () => {
  beforeEach(async () => {
    harness = await toolHarness()
  })

  it('extracts records from a region of the latest observation', async () => {
    const observation = await observe('interactive')
    const record = observation.elements.find(element => element.group !== undefined)
    const result = await harness.call('browser_extract_list', {
      observation_id: observation.id,
      region_ref: record?.ref,
      limit: 10,
    })
    expect(result.isError).toBe(false)
    const value = result.value as unknown as ExtractionResult
    expect(value.kind).toBe('list')
    expect(value.columns).toEqual(['index', 'title', 'url', 'text'])
    expect(value.rows).toHaveLength(3)
    expect(value.total).toBe(3)
    expect(value.truncated).toBe(false)
  })

  it('narrows rows to the requested fields', async () => {
    const result = await harness.call('browser_extract_links', { fields: ['title', 'url'] })
    expect(result.isError).toBe(false)
    const value = result.value as unknown as ExtractionResult
    expect(value.columns).toEqual(['title', 'url'])
    expect(Object.keys(value.rows[0] ?? {})).toEqual(['title', 'url'])
  })

  it('rejects an unknown field instead of returning an empty column', async () => {
    const result = await harness.call('browser_extract_table', { fields: ['nonexistent'] })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('BROWSER_INVALID_ARGUMENT')
    expect(result.error?.message).toContain('this region offers')
  })

  it('rejects a region reference from a superseded observation', async () => {
    const first = await observe('interactive')
    await observe('interactive')
    const result = await harness.call('browser_extract_list', {
      observation_id: first.id,
      region_ref: first.elements[0]?.ref,
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('BROWSER_STALE_REFERENCE')
  })
})

class EnvCredentials extends BrowserCredentialStore {
  constructor(ctx: Context) {
    super(ctx, 'browserCredentials')
  }

  list(): Promise<readonly string[]> {
    return Promise.resolve(['service-account'])
  }

  resolve(ref: string): Promise<string> {
    return Promise.resolve(`resolved-${ref}`)
  }
}

class AllowApproval extends Service {
  outcome = 'allowed-once'
  asked: unknown[] = []

  constructor(ctx: Context) {
    super(ctx, 'approval')
  }

  request(input: unknown): Promise<string> {
    this.asked.push(input)
    return Promise.resolve(this.outcome)
  }
}

describe('the credential channel', () => {
  it('is absent when no credential source is configured', async () => {
    harness = await toolHarness()
    expect(harness.ctx.tools.schemas().map(schema => schema.name)).not.toContain('browser_fill_credential')
  })

  it('fills from a configured reference and keeps the secret out of the arguments', async () => {
    let approval: AllowApproval | undefined
    harness = await toolHarness({
      config: { credentials: { refs: { 'ci-token': 'DSH_BROWSER_TEST_SECRET' } } },
      prepare: (ctx) => { approval = new AllowApproval(ctx) },
    })
    process.env.DSH_BROWSER_TEST_SECRET = 'super-secret-value'
    try {
      const observation = await observe('interactive')
      const field = observation.elements.find(element => element.input_type === 'text')
      const result = await harness.call('browser_fill_credential', {
        observation_id: observation.id,
        element_ref: field?.ref,
        credential_ref: 'ci-token',
      })
      expect(result.isError, result.error?.message).toBe(false)
      expect(approval?.asked).toHaveLength(1)
      const value = result.value as unknown as ActionResult
      expect(JSON.stringify(value)).not.toContain('super-secret-value')
      expect(value.observation.text).toBe(`Filled ${'super-secret-value'.length} characters`)
    } finally {
      delete process.env.DSH_BROWSER_TEST_SECRET
    }
  })

  it('resolves through a mounted credential service', async () => {
    harness = await toolHarness({
      config: { credentials: { requireApproval: false } },
      prepare: (ctx) => { new EnvCredentials(ctx) },
    })
    const observation = await observe('interactive')
    const field = observation.elements.find(element => element.input_type === 'text')
    const result = await harness.call('browser_fill_credential', {
      observation_id: observation.id,
      element_ref: field?.ref,
      credential_ref: 'service-account',
    })
    expect(result.isError, result.error?.message).toBe(false)
    expect((result.value as unknown as ActionResult).observation.text)
      .toBe(`Filled ${'resolved-service-account'.length} characters`)
  })

  it('denies a fill the approval service refused', async () => {
    let approval: AllowApproval | undefined
    harness = await toolHarness({
      config: { credentials: { refs: { 'ci-token': 'DSH_BROWSER_TEST_SECRET' } } },
      prepare: (ctx) => { approval = new AllowApproval(ctx) },
    })
    if (approval !== undefined) approval.outcome = 'denied'
    const observation = await observe('interactive')
    const result = await harness.call('browser_fill_credential', {
      observation_id: observation.id,
      element_ref: observation.elements[1]?.ref,
      credential_ref: 'ci-token',
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('BROWSER_CREDENTIAL_DENIED')
  })

  it('fails closed when approval is required and no approval service is mounted', async () => {
    harness = await toolHarness({
      config: { credentials: { refs: { 'ci-token': 'DSH_BROWSER_TEST_SECRET' } } },
    })
    const observation = await observe('interactive')
    const result = await harness.call('browser_fill_credential', {
      observation_id: observation.id,
      element_ref: observation.elements[1]?.ref,
      credential_ref: 'ci-token',
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('BROWSER_CREDENTIAL_DENIED')
  })

  it('names the configured references when the model asks for an unknown one', async () => {
    harness = await toolHarness({
      config: { credentials: { refs: { 'ci-token': 'DSH_BROWSER_TEST_SECRET' }, requireApproval: false } },
    })
    const observation = await observe('interactive')
    const result = await harness.call('browser_fill_credential', {
      observation_id: observation.id,
      element_ref: observation.elements[1]?.ref,
      credential_ref: 'other',
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('BROWSER_CREDENTIAL_UNAVAILABLE')
    expect(result.error?.message).toContain('configured: ci-token')
  })
})
