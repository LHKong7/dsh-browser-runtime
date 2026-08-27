/**
 * Functions Playwright serializes into Chromium.
 *
 * Everything here runs in the page, outside Node's coverage isolate and outside
 * this module's scope: each exported function must be self-contained, must not
 * close over an import, and must return structured-cloneable data. Ranking and
 * grouping live here rather than in the Runtime because the decision needs the
 * DOM, and deciding in the page keeps the Playwright protocol payload bounded.
 */

/** Landmark region an element belongs to. */
export type ElementSection =
  | 'search'
  | 'form'
  | 'navigation'
  | 'banner'
  | 'main'
  | 'record'
  | 'complementary'
  | 'contentinfo'
  | 'unknown'

/**
 * Semantic priority tier, lowest number first.
 *
 * 1 form controls, buttons, and pagination; 2 site navigation and page-level
 * actions; 3 the title link of a repeating record; 4 ordinary body links;
 * 5 repeated per-record links such as authors, footnotes, and download formats.
 */
export type ElementPriority = 1 | 2 | 3 | 4 | 5

/** One interactive element as the page describes it. */
export interface ElementSnapshot {
  readonly ordinal: number
  readonly kind: string
  readonly name: string
  readonly disabled: boolean
  readonly opensNewPage: boolean
  readonly downloads: boolean
  readonly externalProtocol: boolean
  readonly inputType?: string
  readonly section: ElementSection
  readonly priority: ElementPriority
  readonly pagination: boolean
  readonly groupKey?: string
  readonly groupLabel?: string
  readonly fingerprint: string
}

/** Ranked interactive elements plus the candidate count before truncation. */
export interface ElementSnapshotResult {
  readonly elements: ElementSnapshot[]
  readonly total: number
}

/** Bounded body text plus whether the page held more. */
export interface BodyTextSnapshot {
  readonly text: string
  readonly truncated: boolean
  readonly totalChars: number
}

/** Viewport, document, and device metrics used to bound a screenshot. */
export interface ScreenshotLayout {
  readonly contentWidth: number
  readonly contentHeight: number
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly deviceScaleFactor: number
}

/**
 * Slice body text inside the renderer so the full string never crosses the
 * Playwright protocol.
 * @param body - the document body element.
 * @param maxTextChars - characters the Runtime admits.
 * @returns the bounded prefix, whether it was cut, and the original length.
 */
// Playwright serializes this function into Chromium, outside Node's coverage isolate.
/* v8 ignore next */
export function snapshotBodyText(body: Element, maxTextChars: number): BodyTextSnapshot {
  const text = body instanceof HTMLElement ? body.innerText : (body.textContent ?? '')
  return {
    text: text.slice(0, maxTextChars),
    truncated: text.length > maxTextChars,
    totalChars: text.length,
  }
}

/**
 * Measure the page for a bounded screenshot request.
 * @returns document and viewport sizes plus the device scale factor.
 */
// Playwright serializes this function into Chromium, outside Node's coverage isolate.
/* v8 ignore next */
export function snapshotScreenshotLayout(): ScreenshotLayout {
  const root = document.documentElement
  const body = document.body
  const viewportWidth = Math.max(globalThis.innerWidth, 1)
  const viewportHeight = Math.max(globalThis.innerHeight, 1)
  return {
    contentWidth: Math.max(viewportWidth, root?.scrollWidth ?? 0, body?.scrollWidth ?? 0),
    contentHeight: Math.max(viewportHeight, root?.scrollHeight ?? 0, body?.scrollHeight ?? 0),
    viewportWidth,
    viewportHeight,
    deviceScaleFactor: Number.isFinite(globalThis.devicePixelRatio) && globalThis.devicePixelRatio > 0
      ? globalThis.devicePixelRatio
      : 1,
  }
}

/**
 * Describe, rank, and bound the interactive elements of the current page.
 *
 * Elements keep their DOM ordinal so a later action can address them, but the
 * returned order is by priority tier and then document order, so truncation
 * drops repeated per-record links before it drops a form control or a
 * pagination entry.
 * @param nodes - every node matching the Provider's interactive selector.
 * @param maxElements - how many ranked elements to return.
 * @returns the ranked, bounded elements and the visible candidate count.
 */
// Playwright serializes this function into Chromium, outside Node's coverage isolate.
/* v8 ignore next */
export function snapshotElements(nodes: Element[], maxElements: number): ElementSnapshotResult {
  const PAGINATION_TEXT
    = /^(\d+|\d+\s*[-–—]\s*\d+|next|previous|prev|more|all|first|last|older|newer|»|«|›|‹|→|←|下一页|上一页|下一頁|上一頁|更多|全部|首页|末页)$/i
  const RECORD_TAGS = ['LI', 'ARTICLE', 'TR', 'DT', 'DD', 'SECTION']

  const textOf = (node: Element | null | undefined, limit: number): string => {
    if (node === null || node === undefined) return ''
    const raw = node instanceof HTMLElement ? node.innerText : (node.textContent ?? '')
    return raw.replace(/\s+/g, ' ').trim().slice(0, limit)
  }

  const accessibleName = (node: HTMLElement): string => {
    const candidate = node.getAttribute('aria-label')
      ?? node.getAttribute('title')
      ?? node.getAttribute('alt')
      ?? node.getAttribute('placeholder')
      ?? node.textContent
      ?? ''
    return candidate.replace(/\s+/g, ' ').trim().slice(0, 200)
  }

  const opensNewPage = (node: HTMLElement): boolean => {
    const defaultTarget = node.ownerDocument.querySelector('base[target]')?.getAttribute('target') ?? ''
    let target = ''
    if (node instanceof HTMLAnchorElement) {
      target = node.target || defaultTarget
    } else if (node instanceof HTMLButtonElement && node.type === 'submit') {
      target = node.formTarget || node.form?.target || defaultTarget
    } else if (node instanceof HTMLInputElement && (node.type === 'submit' || node.type === 'image')) {
      target = node.formTarget || node.form?.target || defaultTarget
    }
    const trimmed = target.trim()
    const normalized = trimmed.toLowerCase()
    if (normalized === '' || normalized === '_self' || normalized === '_parent'
      || normalized === '_top' || normalized === '_unfencedtop') return false
    if (normalized === '_blank') return true
    return ![...node.ownerDocument.querySelectorAll('iframe, frame')]
      .some(frame => frame.getAttribute('name') === trimmed)
  }

  const usesExternalProtocol = (node: HTMLElement): boolean => {
    let rawUrl: string | null = null
    if (node instanceof HTMLAnchorElement) {
      rawUrl = node.getAttribute('href')
    } else if (node instanceof HTMLButtonElement && node.type === 'submit') {
      rawUrl = node.getAttribute('formaction') ?? node.form?.getAttribute('action') ?? null
    } else if (node instanceof HTMLInputElement && (node.type === 'submit' || node.type === 'image')) {
      rawUrl = node.getAttribute('formaction') ?? node.form?.getAttribute('action') ?? null
    }
    if (rawUrl === null) return false
    try {
      return !['http:', 'https:', 'javascript:', 'blob:', 'data:', 'about:']
        .includes(new URL(rawUrl, node.ownerDocument.baseURI).protocol.toLowerCase())
    } catch {
      return true
    }
  }

  const landmarkOf = (node: HTMLElement): ElementSection => {
    for (let current: HTMLElement | null = node; current !== null; current = current.parentElement) {
      const role = current.getAttribute('role')?.trim().toLowerCase() ?? ''
      const tag = current.tagName
      if (role === 'search') return 'search'
      if (tag === 'NAV' || role === 'navigation') return 'navigation'
      if (tag === 'FORM' || role === 'form') return 'form'
      if (tag === 'HEADER' || role === 'banner') return 'banner'
      if (tag === 'FOOTER' || role === 'contentinfo') return 'contentinfo'
      if (tag === 'ASIDE' || role === 'complementary') return 'complementary'
      if (tag === 'MAIN' || role === 'main') return 'main'
    }
    return 'unknown'
  }

  /** Nearest ancestor that repeats among its siblings, i.e. one list record. */
  const recordOf = (node: HTMLElement): HTMLElement | undefined => {
    for (let current: HTMLElement | null = node; current !== null; current = current.parentElement) {
      const candidate = current
      if (candidate.tagName === 'BODY') return undefined
      const role = candidate.getAttribute('role')?.trim().toLowerCase() ?? ''
      if (!RECORD_TAGS.includes(candidate.tagName) && role !== 'listitem' && role !== 'article') continue
      const parent = candidate.parentElement
      if (parent === null) continue
      const siblings = [...parent.children].filter(child => child.tagName === candidate.tagName)
      if (siblings.length >= 3) return candidate
    }
    return undefined
  }

  /**
   * Stable identity of one record. `dt`/`dd` pairs describe a single record, so
   * both sides of a definition list collapse onto the same key.
   */
  const recordKey = (record: HTMLElement): string => {
    const parent = record.parentElement
    if (parent === null) return record.tagName.toLowerCase()
    const isDefinition = record.tagName === 'DT' || record.tagName === 'DD'
    let index = 0
    for (const child of parent.children) {
      if (child === record) break
      if (isDefinition ? child.tagName === 'DT' : child.tagName === record.tagName) index += 1
    }
    if (isDefinition && record.tagName === 'DD') index = Math.max(index - 1, 0)
    const container = parent.tagName.toLowerCase()
    return `${container}[${isDefinition ? 'dl' : record.tagName.toLowerCase()}]#${index}`
  }

  /** Both halves of a `dt`/`dd` pair describe one record, so both are searched. */
  const recordScopes = (record: HTMLElement): Element[] => {
    const parent = record.parentElement
    const isDefinition = record.tagName === 'DT' || record.tagName === 'DD'
    if (!isDefinition || parent === null) return [record]
    const key = recordKey(record)
    return [...parent.children].filter(child => (
      (child.tagName === 'DT' || child.tagName === 'DD') && recordKey(child as HTMLElement) === key
    ))
  }

  const recordLabel = (record: HTMLElement): string => {
    const scopes = recordScopes(record)
    for (const selector of ['h1, h2, h3, h4, h5, h6, [role="heading"]', '.title, [class*="title"]']) {
      for (const scope of scopes) {
        const found = textOf(scope.querySelector(selector), 160)
        if (found !== '') return found
      }
    }
    return textOf(scopes[0] ?? record, 160)
  }

  const isPagination = (node: HTMLElement, name: string): boolean => {
    const rel = node.getAttribute('rel')?.toLowerCase() ?? ''
    if (rel.includes('next') || rel.includes('prev')) return true
    const label = (node.getAttribute('aria-label') ?? name).replace(/\s+/g, ' ').trim()
    if (label === '' || label.length > 24) return false
    if (!PAGINATION_TEXT.test(label)) return false
    // A lone numeric link is ordinary content; pagination comes in runs.
    const parent = node.parentElement
    if (parent === null) return false
    const siblings = [...parent.querySelectorAll('a[href], button')]
      .filter(sibling => PAGINATION_TEXT.test(textOf(sibling, 24)))
    return siblings.length >= 2
  }

  const priorityOf = (input: {
    tag: string
    role: string
    inputType: string | undefined
    section: ElementSection
    pagination: boolean
    record: HTMLElement | undefined
    isRecordTitle: boolean
  }): ElementPriority => {
    const control = input.tag === 'input' || input.tag === 'textarea' || input.tag === 'select'
      || input.tag === 'button'
      || input.role === 'button' || input.role === 'checkbox' || input.role === 'radio'
      || input.role === 'textbox' || input.role === 'combobox' || input.role === 'searchbox'
    if (control || input.pagination) return 1
    if (input.section === 'navigation' || input.section === 'banner' || input.section === 'search') return 2
    if (input.record !== undefined) return input.isRecordTitle ? 3 : 5
    if (input.section === 'contentinfo' || input.section === 'complementary') return 5
    return 4
  }

  const describe = (node: HTMLElement, ordinal: number): ElementSnapshot => {
    const tag = node.tagName.toLowerCase()
    const role = node.getAttribute('role')?.trim().toLowerCase() ?? ''
    const inputType = node instanceof HTMLInputElement ? (node.type || 'text').toLowerCase() : undefined
    const kind = role || (inputType === undefined ? tag : `${tag}:${inputType}`)
    const name = accessibleName(node)
    const disabled = 'disabled' in node && Boolean((node as HTMLButtonElement).disabled)
    const newPage = opensNewPage(node)
    const downloads = node instanceof HTMLAnchorElement && node.hasAttribute('download')
    const externalProtocol = usesExternalProtocol(node)
    // The fingerprint stays exactly the identity an action re-validates against.
    // Ranking metadata is deliberately excluded: a record moving within a list
    // must not invalidate a reference the model already holds.
    const fingerprint = JSON.stringify({
      tag,
      role,
      inputType: inputType ?? '',
      name,
      opensNewPage: newPage,
      downloads,
      externalProtocol,
    })
    const section = landmarkOf(node)
    const record = recordOf(node)
    const pagination = (tag === 'a' || tag === 'button' || role === 'link' || role === 'button')
      && isPagination(node, name)
    const recordTitleNode = record?.querySelector('a[href], [role="link"]')
    const isRecordTitle = record !== undefined && recordTitleNode === node
    const priority = priorityOf({ tag, role, inputType, section, pagination, record, isRecordTitle })
    const groupKey = record === undefined ? undefined : recordKey(record)
    const groupLabel = record === undefined ? undefined : recordLabel(record)
    return {
      ordinal,
      kind,
      name,
      disabled,
      opensNewPage: newPage,
      downloads,
      externalProtocol,
      ...(inputType === undefined ? {} : { inputType }),
      section: record === undefined ? section : 'record',
      priority,
      pagination,
      ...(groupKey === undefined ? {} : { groupKey }),
      ...(groupLabel === undefined || groupLabel === '' ? {} : { groupLabel }),
      fingerprint,
    }
  }

  const candidates: ElementSnapshot[] = []
  for (let ordinal = 0; ordinal < nodes.length; ordinal += 1) {
    const node = nodes[ordinal]
    if (!(node instanceof HTMLElement)) continue
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    if (style.visibility === 'hidden' || style.display === 'none' || rect.width === 0 || rect.height === 0) continue
    candidates.push(describe(node, ordinal))
  }
  const ranked = candidates
    .map((element, index) => ({ element, index }))
    .sort((left, right) => (
      left.element.priority - right.element.priority || left.index - right.index
    ))
    .map(entry => entry.element)
  return { elements: ranked.slice(0, Math.max(maxElements, 0)), total: candidates.length }
}

/** Where a scroll moves the page, mirroring the Runtime's scroll targets. */
export interface ScrollRequest {
  readonly to: 'up' | 'down' | 'top' | 'bottom' | 'element'
  readonly pages: number
}

/**
 * Scroll the page without exposing coordinates to the model.
 * @param request - direction and viewport multiples.
 */
// Playwright serializes this function into Chromium, outside Node's coverage isolate.
/* v8 ignore next */
export function scrollViewport(request: ScrollRequest): void {
  const viewport = Math.max(globalThis.innerHeight, 1)
  switch (request.to) {
    case 'top': globalThis.scrollTo({ top: 0 }); return
    case 'bottom': globalThis.scrollTo({ top: document.documentElement.scrollHeight }); return
    case 'up': globalThis.scrollBy({ top: -viewport * request.pages }); return
    default: globalThis.scrollBy({ top: viewport * request.pages })
  }
}

/** What an extraction should read out of a region. */
export interface ExtractionRequest {
  readonly kind: 'list' | 'table' | 'links' | 'article'
  readonly limit: number
  readonly maxTextChars: number
}

/** Extracted records plus the count the region held before the limit applied. */
export interface ExtractionResult {
  readonly columns: string[]
  readonly rows: Record<string, string>[]
  readonly total: number
}

/**
 * Read structured content out of one region.
 *
 * The model supplies a kind and a region reference from its latest observation,
 * never a selector and never JavaScript: every traversal below is fixed here,
 * so an extraction cannot reach outside the region or run page-authored code.
 * @param scope - the region element the Runtime resolved.
 * @param request - extraction kind and budgets.
 * @returns the extracted rows and the region's record count.
 */
// Playwright serializes this function into Chromium, outside Node's coverage isolate.
/* v8 ignore next */
export function extractStructuredContent(scope: Element, request: ExtractionRequest): ExtractionResult {
  const clean = (value: string, limit: number): string => value.replace(/\s+/g, ' ').trim().slice(0, limit)
  const textOf = (node: Element | null | undefined, limit: number): string => {
    if (node === null || node === undefined) return ''
    return clean(node instanceof HTMLElement ? node.innerText : (node.textContent ?? ''), limit)
  }
  const absolute = (node: Element, attribute: string): string => {
    const raw = node.getAttribute(attribute)
    if (raw === null) return ''
    try {
      return new URL(raw, node.ownerDocument.baseURI).toString()
    } catch {
      return raw
    }
  }
  const bounded = <T>(items: T[]): { taken: T[]; total: number } => ({
    taken: items.slice(0, request.limit),
    total: items.length,
  })

  /**
   * Widen an element reference to the region a caller means by it.
   *
   * The model addresses an element from its observation, but the useful region
   * for an extraction is usually the container that element sits in: naming one
   * paper's link means "this listing", not "this anchor".
   */
  const resolveRegion = (): Element => {
    const listContainers = 'ol, ul, dl, tbody'
    const ancestor = (selector: string): Element | undefined => {
      for (let current: Element | null = scope; current !== null; current = current.parentElement) {
        if (current.matches(selector)) return current
      }
      return undefined
    }
    if (request.kind === 'table') {
      return (scope.matches('table') ? scope : undefined)
        ?? scope.querySelector('table')
        ?? ancestor('table')
        ?? scope
    }
    if (request.kind === 'article') return scope
    if (request.kind === 'list') {
      return (scope.matches(listContainers) ? scope : undefined)
        ?? scope.querySelector(listContainers)
        ?? ancestor(listContainers)
        ?? scope
    }
    // links: an anchor addresses the run of links around it, not just itself.
    if (scope.querySelector('a[href]') !== null) return scope
    return ancestor(listContainers) ?? scope.parentElement ?? scope
  }

  const region = resolveRegion()

  if (request.kind === 'links') {
    const anchors = [...region.querySelectorAll('a[href]')]
    const { taken, total } = bounded(anchors)
    return {
      columns: ['index', 'text', 'url', 'title'],
      rows: taken.map((anchor, index) => ({
        index: String(index),
        text: textOf(anchor, request.maxTextChars),
        url: absolute(anchor, 'href'),
        title: clean(anchor.getAttribute('title') ?? '', 200),
      })),
      total,
    }
  }

  if (request.kind === 'table') {
    const table = region.tagName === 'TABLE' ? region : region.querySelector('table')
    if (table === null) return { columns: [], rows: [], total: 0 }
    const headerCells = [...table.querySelectorAll('th')]
    const bodyRows = [...table.querySelectorAll('tr')].filter(row => row.querySelector('td') !== null)
    const columns = headerCells.length > 0
      ? headerCells.map((cell, index) => textOf(cell, 120) || `column_${index}`)
      : [...(bodyRows[0]?.querySelectorAll('td') ?? [])].map((_cell, index) => `column_${index}`)
    const { taken, total } = bounded(bodyRows)
    return {
      columns: ['index', ...columns],
      rows: taken.map((row, index) => {
        const record: Record<string, string> = { index: String(index) }
        const cells = [...row.querySelectorAll('td')]
        for (let column = 0; column < cells.length; column += 1) {
          record[columns[column] ?? `column_${column}`] = textOf(cells[column], request.maxTextChars)
        }
        return record
      }),
      total,
    }
  }

  if (request.kind === 'article') {
    const article = region.querySelector('article, [role="article"], main, [role="main"]') ?? region
    const heading = article.querySelector('h1, h2, [role="heading"]')
      ?? scope.ownerDocument.querySelector('h1')
    const byline = article.querySelector('[rel="author"], .byline, [class*="author"]')
    const body = article instanceof HTMLElement ? article.innerText : (article.textContent ?? '')
    return {
      columns: ['title', 'byline', 'text'],
      rows: [{
        title: textOf(heading, 300) || clean(scope.ownerDocument.title, 300),
        byline: textOf(byline, 300),
        text: body.slice(0, request.maxTextChars),
      }],
      total: 1,
    }
  }

  // list: the repeating records of the region, one row each.
  const childTag = region.tagName === 'DL' ? 'DT' : region.tagName === 'TBODY' ? 'TR' : 'LI'
  let records = [...region.children].filter(child => child.tagName === childTag)
  if (records.length === 0) {
    records = [...region.children].filter(child => child.tagName === 'ARTICLE' || child.tagName === 'SECTION')
  }
  const { taken, total } = bounded(records)
  return {
    columns: ['index', 'title', 'url', 'text'],
    rows: taken.map((record, index) => {
      // A definition list splits one record across `dt` and the `dd` after it.
      const detail = record.tagName === 'DT' && record.nextElementSibling?.tagName === 'DD'
        ? record.nextElementSibling
        : undefined
      const scopes = detail === undefined ? [record] : [record, detail]
      const link = scopes.map(part => part.querySelector('a[href]')).find(found => found !== null)
      const heading = scopes.map(part => part.querySelector('h1, h2, h3, h4, h5, h6')).find(found => found !== null)
      return {
        index: String(index),
        title: textOf(heading ?? link, 300),
        url: link === undefined || link === null ? '' : absolute(link, 'href'),
        text: scopes.map(part => textOf(part, request.maxTextChars)).join(' ').slice(0, request.maxTextChars),
      }
    }),
    total,
  }
}
