import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BrowserObservation } from '../runtime/types.ts'

/** JSON projection of a browser observation returned by model-facing tools. */
export interface ObservationValue {
  readonly id: string
  readonly environment_id: string
  readonly generation: number
  readonly page_id: string
  readonly revision: number
  readonly url: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
  readonly digest: string
  readonly elements: {
    readonly ref: string
    readonly kind: string
    readonly name: string
    readonly disabled: boolean
    readonly input_type?: string
  }[]
}

/** Project the provider-neutral observation into lossless tool JSON. */
export function observationValue(observation: BrowserObservation): ObservationValue {
  return {
    id: observation.id,
    environment_id: observation.environmentId,
    generation: observation.generation,
    page_id: observation.pageId,
    revision: observation.revision,
    url: observation.url,
    title: observation.title,
    text: observation.text,
    truncated: observation.truncated,
    digest: observation.digest,
    elements: observation.elements.map(element => ({
      ref: element.ref,
      kind: element.kind,
      name: element.name,
      disabled: element.disabled,
      ...(element.inputType === undefined ? {} : { input_type: element.inputType }),
    })),
  }
}

/** Format an observation as compact model-facing text with observation-local refs. */
export function formatObservation(observation: ObservationValue): string {
  const heading = [
    `Observation ${observation.id} (revision ${observation.revision})`,
    `URL: ${observation.url}`,
    `Title: ${observation.title || '(untitled)'}`,
  ]
  const elements = observation.elements.length === 0
    ? ['Interactive elements: none']
    : [
        'Interactive elements:',
        ...observation.elements.map((element) => {
          const state = element.disabled ? ' disabled' : ''
          const input = element.input_type === undefined ? '' : ` input=${element.input_type}`
          return `[${element.ref}] ${element.kind}${input}${state} — ${element.name || '(unnamed)'}`
        }),
      ]
  const suffix = observation.truncated ? '\n[Page text truncated]' : ''
  return [...heading, ...elements, '', observation.text + suffix].join('\n')
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
