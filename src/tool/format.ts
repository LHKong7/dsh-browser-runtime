/** Model-facing projection of observations, transitions, and screenshots. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BrowserObservation, BrowserTransition } from '../runtime/types.ts'

/**
 * How much of a page one observation response carries.
 *
 * `summary` answers "where am I and what can I do here": a text lead plus
 * controls, navigation, pagination, and record titles. `interactive` drops page
 * text and returns every ranked element. `document` returns the article text
 * with only the controls needed to keep reading.
 */
export type ObservationMode = 'summary' | 'interactive' | 'document'

/** Every observation mode, in schema order. */
export const OBSERVATION_MODES: readonly ObservationMode[] = ['summary', 'interactive', 'document']

interface ModeProfile {
  readonly maxTextChars: number
  readonly maxElements: number
  readonly priorities: readonly number[]
}

/**
 * Default budget per mode. Explicit tool arguments override these, and the
 * plugin configuration caps both.
 */
const MODE_PROFILES: Readonly<Record<ObservationMode, ModeProfile>> = {
  summary: { maxTextChars: 4_000, maxElements: 40, priorities: [1, 2, 3] },
  interactive: { maxTextChars: 0, maxElements: 100, priorities: [1, 2, 3, 4, 5] },
  document: { maxTextChars: 12_000, maxElements: 20, priorities: [1, 2] },
}

/** Resolved budget for one observation response. */
export interface ObservationBudget {
  readonly mode: ObservationMode
  readonly maxTextChars: number
  readonly maxElements: number
  readonly priorities: readonly number[]
}

/**
 * Resolve the budget for one observation request.
 * @param mode - requested mode, defaulting to the configured mode.
 * @param requested - explicit per-call overrides.
 * @param caps - plugin-configured hard caps.
 * @returns the budget the projection applies.
 */
export function observationBudget(
  mode: ObservationMode,
  requested: { readonly maxTextChars?: number; readonly maxElements?: number },
  caps: { readonly maxTextChars: number; readonly maxElements: number },
): ObservationBudget {
  const profile = MODE_PROFILES[mode]
  return {
    mode,
    maxTextChars: Math.min(requested.maxTextChars ?? profile.maxTextChars, caps.maxTextChars),
    maxElements: Math.min(requested.maxElements ?? profile.maxElements, caps.maxElements),
    priorities: profile.priorities,
  }
}

/** One interactive element as a tool response presents it. */
export interface ObservationElementValue {
  readonly ref: string
  readonly kind: string
  readonly name: string
  readonly disabled: boolean
  readonly input_type?: string
  readonly section: string
  readonly priority: number
  readonly pagination: boolean
  readonly group?: string
  readonly group_label?: string
}

/** One repeating page record and the element refs observed inside it. */
export interface ObservationGroupValue {
  readonly ref: string
  readonly label: string
  readonly elements: string[]
}

/** JSON projection of one page of a browser observation. */
export interface ObservationValue {
  readonly id: string
  readonly environment_id: string
  readonly generation: number
  readonly page_id: string
  readonly revision: number
  readonly url: string
  readonly title: string
  readonly mode: ObservationMode
  readonly text: string
  /** Character offset of `text` inside the observed page text. */
  readonly text_offset: number
  /** Whether page text continues past this response. */
  readonly text_truncated: boolean
  /** Characters the page held in total. */
  readonly total_text_chars: number
  readonly elements: ObservationElementValue[]
  readonly groups: ObservationGroupValue[]
  /** Index of the first returned element within this mode's ranked selection. */
  readonly element_offset: number
  /** Whether ranked elements continue past this response. */
  readonly elements_truncated: boolean
  /** Visible interactive elements the page held in total. */
  readonly total_elements: number
  /** Token accepted by `browser_observe_next`; absent when nothing remains. */
  readonly continuation?: string
  readonly digest: string
}

/** Where a continuation resumes inside one observation. */
export interface ObservationOffsets {
  readonly text: number
  readonly elements: number
}

/**
 * Project one page of an observation into lossless tool JSON.
 *
 * Elements are already ranked by the Provider, so the mode filter and the
 * element budget drop repeated per-record links before anything a caller can
 * act on. `continuation` is minted by the caller because only it knows whether
 * the cursor is still the newest one.
 * @param observation - the runtime observation being read.
 * @param budget - mode and per-response limits.
 * @param offsets - where this page starts.
 * @param continuation - token that reads the next page, when one exists.
 * @returns the JSON value for one tool response.
 */
export function observationValue(
  observation: BrowserObservation,
  budget: ObservationBudget = observationBudget('interactive', {}, {
    maxTextChars: Number.MAX_SAFE_INTEGER,
    maxElements: Number.MAX_SAFE_INTEGER,
  }),
  offsets: ObservationOffsets = { text: 0, elements: 0 },
  continuation?: string,
): ObservationValue {
  const selected = observation.elements.filter(element => budget.priorities.includes(element.priority))
  const elements = selected.slice(offsets.elements, offsets.elements + budget.maxElements)
  const text = observation.text.slice(offsets.text, offsets.text + budget.maxTextChars)
  const groupRefs = new Set(elements.flatMap(element => element.group === undefined ? [] : [element.group]))
  const projected = elements.map((element): ObservationElementValue => ({
    ref: element.ref,
    kind: element.kind,
    name: element.name,
    disabled: element.disabled,
    ...(element.inputType === undefined ? {} : { input_type: element.inputType }),
    section: element.section,
    priority: element.priority,
    pagination: element.pagination,
    ...(element.group === undefined ? {} : { group: element.group }),
    ...(element.groupLabel === undefined ? {} : { group_label: element.groupLabel }),
  }))
  const returnedRefs = new Set(elements.map(element => element.ref))
  return {
    id: observation.id,
    environment_id: observation.environmentId,
    generation: observation.generation,
    page_id: observation.pageId,
    revision: observation.revision,
    url: observation.url,
    title: observation.title,
    mode: budget.mode,
    text,
    text_offset: offsets.text,
    text_truncated: offsets.text + text.length < observation.text.length || observation.truncated,
    total_text_chars: observation.totalTextChars,
    elements: projected,
    groups: observation.groups
      .filter(group => groupRefs.has(group.ref))
      .map(group => ({
        ref: group.ref,
        label: group.label,
        elements: group.elements.filter(ref => returnedRefs.has(ref)),
      })),
    element_offset: offsets.elements,
    elements_truncated: offsets.elements + elements.length < selected.length || observation.elementsTruncated,
    total_elements: observation.totalElements,
    ...(continuation === undefined ? {} : { continuation }),
    digest: observation.digest,
  }
}

/**
 * Whether more of this observation can be read after the given page.
 * @param observation - the observation being paged.
 * @param budget - mode and per-response limits.
 * @param offsets - where the page just returned started.
 * @returns the offsets of the next page, or `undefined` when exhausted.
 */
export function nextOffsets(
  observation: BrowserObservation,
  budget: ObservationBudget,
  offsets: ObservationOffsets,
): ObservationOffsets | undefined {
  const selected = observation.elements.filter(element => budget.priorities.includes(element.priority))
  const text = Math.min(offsets.text + budget.maxTextChars, observation.text.length)
  const elements = Math.min(offsets.elements + budget.maxElements, selected.length)
  // A zero budget excludes that dimension from this mode entirely, so paging
  // cannot advance it; treating it as pending would never exhaust the cursor.
  const textPending = budget.maxTextChars > 0 && text < observation.text.length
  const elementsPending = budget.maxElements > 0 && elements < selected.length
  if (!textPending && !elementsPending) return undefined
  return { text, elements }
}

/** Format an observation page as compact model-facing text. */
export function formatObservation(observation: ObservationValue): string {
  const lines = [
    `Observation ${observation.id} (revision ${observation.revision}, mode ${observation.mode})`,
    `URL: ${observation.url}`,
    `Title: ${observation.title || '(untitled)'}`,
  ]

  const shown = observation.elements.length
  const hidden = Math.max(observation.total_elements - observation.element_offset - shown, 0)
  lines.push(observation.elements_truncated
    ? `Interactive elements: ${shown} shown from rank ${observation.element_offset + 1}; ${hidden} not shown`
    : `Interactive elements: ${shown} of ${observation.total_elements}`)

  const grouped = new Map(observation.groups.map(group => [group.ref, group]))
  const ungrouped = observation.elements.filter(element => element.group === undefined)
  if (ungrouped.length === 0 && grouped.size === 0) lines.push('  (none)')
  for (const element of ungrouped) lines.push(`  ${elementLine(element)}`)

  if (grouped.size > 0) {
    lines.push(`Records: ${grouped.size}`)
    for (const group of grouped.values()) {
      lines.push(`  [${group.ref}] ${group.label || '(untitled record)'}`)
      for (const ref of group.elements) {
        const element = observation.elements.find(candidate => candidate.ref === ref)
        if (element !== undefined) lines.push(`    ${elementLine(element)}`)
      }
    }
  }

  if (observation.text !== '') {
    const end = observation.text_offset + observation.text.length
    lines.push('', `Page text (${observation.text_offset + 1}-${end} of ${observation.total_text_chars} chars):`)
    lines.push(observation.text)
  } else if (observation.total_text_chars > 0) {
    lines.push('', `Page text: not included in ${observation.mode} mode (${observation.total_text_chars} chars available)`)
  }

  if (observation.continuation !== undefined) {
    lines.push('', `More remains. Call browser_observe_next with continuation "${observation.continuation}".`)
  } else if (observation.text_truncated || observation.elements_truncated) {
    lines.push('', 'The page holds more than this observation retained; re-observe with a larger budget or another mode.')
  }
  return lines.join('\n')
}

function elementLine(element: ObservationElementValue): string {
  const state = element.disabled ? ' disabled' : ''
  const input = element.input_type === undefined ? '' : ` input=${element.input_type}`
  const paging = element.pagination ? ' pagination' : ''
  return `[${element.ref}] ${element.kind}${input}${paging}${state} — ${element.name || '(unnamed)'}`
}

/** Timing and output-size evidence a tool response reports. */
export interface TransitionMetricsValue {
  readonly duration_ms: number
  readonly action_ms: number
  readonly observation_ms: number
  readonly text_chars: number
  readonly element_count: number
  readonly text_truncated: boolean
  readonly elements_truncated: boolean
}

/** JSON projection of one transition's identity, outcome, and metrics. */
export interface TransitionValue {
  readonly id: string
  readonly outcome: 'succeeded' | 'failed' | 'unknown'
  readonly before_observation_id: string
  readonly after_observation_id: string
  readonly metrics: TransitionMetricsValue
}

/** Project transition evidence into tool JSON. */
export function transitionValue(transition: BrowserTransition): TransitionValue {
  if (transition.after === undefined) throw new Error(`transition ${transition.id} has no after observation`)
  return {
    id: transition.id,
    outcome: transition.outcome,
    before_observation_id: transition.before.id,
    after_observation_id: transition.after.id,
    metrics: {
      duration_ms: transition.metrics.durationMs,
      action_ms: transition.metrics.actionMs,
      observation_ms: transition.metrics.observationMs,
      text_chars: transition.metrics.textChars,
      element_count: transition.metrics.elementCount,
      text_truncated: transition.metrics.textTruncated,
      elements_truncated: transition.metrics.elementsTruncated,
    },
  }
}

/** Format transition evidence as one model-facing line. */
export function formatTransition(transition: TransitionValue): string {
  const metrics = transition.metrics
  return [
    `Transition ${transition.id}: ${transition.outcome}`,
    `(${metrics.duration_ms}ms total, ${metrics.action_ms}ms action, ${metrics.observation_ms}ms observation)`,
  ].join(' ')
}

/** Render a persisted screenshot reference as text plus an image content block. */
export function screenshotContent(value: {
  readonly url: string
  readonly observation_id: string
  readonly attachment: unknown
}): ContentBlock[] {
  return [
    { type: 'text', text: `Screenshot for ${value.url} (observation ${value.observation_id})` },
    { type: 'image', attachment: value.attachment as ImageAttachmentRef },
  ]
}
