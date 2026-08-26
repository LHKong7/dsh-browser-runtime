import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type {
  BrowserCheckpointRecord,
  BrowserSessionId,
  BrowserTransition,
  BrowserTransitionId,
} from './types.ts'

const checkpointSchema = z.object({
  sessionId: z.string(),
  environmentId: z.string(),
  generation: z.number().int().nonnegative(),
  providerId: z.string(),
  ref: z.string(),
  coverage: z.array(z.enum(['cookies', 'local-storage'])),
  createdAt: z.string(),
})

const observationEvidenceSchema = z.object({
  id: z.string(),
  digest: z.string(),
  url: z.string(),
  revision: z.number().int().positive(),
})

const transitionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  environmentId: z.string(),
  providerId: z.string(),
  generation: z.number().int().nonnegative(),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('navigate'), url: z.string() }),
    z.object({ type: z.literal('click'), elementRef: z.string() }),
    z.object({
      type: z.literal('fill'),
      elementRef: z.string(),
      value: z.literal('[REDACTED]'),
      valueLength: z.number().int().nonnegative(),
    }),
  ]),
  outcome: z.enum(['succeeded', 'failed', 'unknown']),
  before: observationEvidenceSchema,
  after: observationEvidenceSchema.optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  error: z.object({ name: z.string(), message: z.string(), code: z.string().optional() }).optional(),
})

/** Durable metadata owned by the runtime; provider payload bytes remain provider-private. */
export const browserRuntimeDomainSpec = defineDomain({
  name: 'browser_runtime',
  version: 1,
  tables: {
    checkpoints: domainTable<BrowserSessionId, BrowserCheckpointRecord>(checkpointSchema as unknown as z.ZodType<BrowserCheckpointRecord>),
    transitions: domainTable<BrowserTransitionId, BrowserTransitionRecord>(transitionSchema as unknown as z.ZodType<BrowserTransitionRecord>),
  },
})

/** Compact durable transition record without page text or provider targets. */
export interface BrowserTransitionRecord {
  readonly id: BrowserTransition['id']
  readonly sessionId: BrowserTransition['sessionId']
  readonly environmentId: BrowserTransition['environmentId']
  readonly providerId: BrowserTransition['providerId']
  readonly generation: number
  readonly action: BrowserTransition['action']
  readonly outcome: BrowserTransition['outcome']
  readonly before: ObservationEvidence
  readonly after?: ObservationEvidence
  readonly startedAt: string
  readonly finishedAt: string
  readonly error?: BrowserTransition['error']
}

interface ObservationEvidence {
  readonly id: BrowserTransition['before']['id']
  readonly digest: string
  readonly url: string
  readonly revision: number
}

/** Remove model-visible text and element targets from durable transition metadata. */
export function transitionRecord(transition: BrowserTransition): BrowserTransitionRecord {
  const project = (observation: BrowserTransition['before']): ObservationEvidence => ({
    id: observation.id,
    digest: observation.digest,
    url: observation.url,
    revision: observation.revision,
  })
  return {
    id: transition.id,
    sessionId: transition.sessionId,
    environmentId: transition.environmentId,
    providerId: transition.providerId,
    generation: transition.generation,
    action: transition.action,
    outcome: transition.outcome,
    before: project(transition.before),
    ...(transition.after === undefined ? {} : { after: project(transition.after) }),
    startedAt: transition.startedAt,
    finishedAt: transition.finishedAt,
    ...(transition.error === undefined ? {} : { error: transition.error }),
  }
}
