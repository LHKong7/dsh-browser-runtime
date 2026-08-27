import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { chromium } from 'playwright'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BrowserRuntime, { BrowserSessionId } from 'dsh-browser-runtime'
import type { BrowserEnvironmentLease, BrowserObservation } from 'dsh-browser-runtime'
import { PlaywrightBrowserProvider } from 'dsh-browser-runtime/playwright'

const hasChromium = existsSync(chromium.executablePath())

/**
 * A listing page shaped like the arXiv new-submissions view that motivated
 * ranking: a search form, a run of pagination links, and definition-list
 * records whose per-paper action links vastly outnumber everything actionable.
 */
const PAPERS = 12

function listingPage(): string {
  const records = Array.from({ length: PAPERS }, (_paper, index) => `
    <dt>
      <a href="/abs/${index}">arXiv:2508.${String(index).padStart(5, '0')}</a>
      [<a href="/pdf/${index}">pdf</a>, <a href="/html/${index}">html</a>, <a href="/format/${index}">other</a>]
    </dt>
    <dd>
      <div class="meta">
        <div class="list-title">Title: Paper number ${index} on browser runtimes</div>
        <div class="list-authors">
          <a href="/a/one">Author One</a>, <a href="/a/two">Author Two</a>, <a href="/a/three">Author Three</a>
        </div>
        <div class="list-subjects">Subjects: Artificial Intelligence</div>
      </div>
    </dd>`).join('')
  return `<!doctype html>
    <html><head><title>Listing fixture</title></head>
    <body>
      <header>
        <nav><a href="/cs">cs</a> <a href="/math">math</a> <a href="/physics">physics</a></nav>
        <form role="search" action="/search">
          <input type="text" name="query" aria-label="Search term">
          <button type="submit">Search</button>
        </form>
      </header>
      <main>
        <p>Showing 1-50 of 600 entries</p>
        <div class="paging">
          <a href="/list?skip=50">51-100</a>
          <a href="/list?skip=100">101-150</a>
          <a href="/list?skip=150">151-200</a>
          <a href="/list?all">all</a>
        </div>
        <form id="filters">
          <select name="field" aria-label="Field">
            <option value="all">All fields</option>
            <option value="title">Title</option>
          </select>
          <input type="checkbox" id="abstracts" name="abstracts">
          <label for="abstracts">Show abstracts</label>
        </form>
        <table id="counts">
          <thead><tr><th>Subject</th><th>Entries</th></tr></thead>
          <tbody>
            <tr><td>Artificial Intelligence</td><td>412</td></tr>
            <tr><td>Machine Learning</td><td>188</td></tr>
          </tbody>
        </table>
        <dl id="articles">${records}</dl>
      </main>
      <footer><a href="/about">About</a> <a href="/help">Help</a></footer>
    </body></html>`
}

describe.skipIf(!hasChromium)('observation ranking and extraction in a real browser', () => {
  let server: Server
  let baseUrl: string
  let ctx: Context
  let lease: BrowserEnvironmentLease
  let unregister: (() => Promise<void>) | undefined

  beforeEach(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(request.url === '/other' ? '<!doctype html><title>Other</title><p>Other page</p>' : listingPage())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    ctx = new Context()
    await ctx.plugin(BrowserRuntime, { provider: 'playwright' })
    unregister = ctx.browserRuntime.registerProvider(new PlaywrightBrowserProvider({
      headless: true,
      allowPrivateNetwork: true,
      maxElements: 200,
    }))
    lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('observation-fixture'),
      persistence: 'ephemeral',
    })
    await lease.act({ type: 'navigate', url: `${baseUrl}/list` })
  })

  afterEach(async () => {
    await lease.release()
    await unregister?.()
    await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })

  function names(observation: BrowserObservation, priority: number): string[] {
    return observation.elements.filter(element => element.priority === priority).map(element => element.name)
  }

  it('ranks controls and pagination above repeated per-record links', async () => {
    const observation = await lease.observe()
    const controls = names(observation, 1)
    expect(controls).toContain('Search')
    expect(controls).toContain('51-100')
    expect(controls).toContain('101-150')
    expect(controls).toContain('all')
    expect(names(observation, 2)).toEqual(expect.arrayContaining(['cs', 'math', 'physics']))

    // Every element ahead of the first per-record link is more useful than it.
    const firstRecordLink = observation.elements.findIndex(element => element.priority >= 3)
    expect(observation.elements.slice(0, firstRecordLink).every(element => element.priority <= 2)).toBe(true)
    const authorIndex = observation.elements.findIndex(element => element.name === 'Author One')
    expect(authorIndex).toBeGreaterThan(firstRecordLink)
  })

  it('marks a run of paging links as pagination and a lone link as content', async () => {
    const observation = await lease.observe()
    const paging = observation.elements.filter(element => element.pagination).map(element => element.name)
    expect(paging).toEqual(expect.arrayContaining(['51-100', '101-150', '151-200', 'all']))
    expect(paging).not.toContain('About')
  })

  it('keeps every pagination entry when the element budget truncates the page', async () => {
    const observation = await lease.observe({ maxElements: 12 })
    expect(observation.elementsTruncated).toBe(true)
    expect(observation.totalElements).toBeGreaterThan(12)
    const paging = observation.elements.filter(element => element.pagination).map(element => element.name)
    expect(paging).toEqual(expect.arrayContaining(['51-100', '101-150', '151-200', 'all']))
    expect(observation.elements.map(element => element.name)).not.toContain('Author One')
  })

  it('collapses each dt/dd paper into one record with a title label', async () => {
    const observation = await lease.observe()
    expect(observation.groups.length).toBe(PAPERS)
    const first = observation.groups[0]
    expect(first?.label).toContain('Paper number 0 on browser runtimes')
    const refs = new Set(first?.elements)
    const members = observation.elements.filter(element => refs.has(element.ref)).map(element => element.name)
    // The abs/pdf/html/other links and the three author links all belong to the same paper.
    expect(members).toEqual(expect.arrayContaining(['pdf', 'html', 'other', 'Author One']))
    expect(observation.elements.filter(element => element.group === first?.ref).length).toBe(members.length)
  })

  it('reports how much text and how many elements the page held', async () => {
    const observation = await lease.observe({ maxTextChars: 200 })
    expect(observation.text).toHaveLength(200)
    expect(observation.truncated).toBe(true)
    expect(observation.totalTextChars).toBeGreaterThan(200)
    expect(observation.totalElements).toBeGreaterThan(PAPERS * 4)
  })

  it('extracts the listing records without a selector or model JavaScript', async () => {
    const observation = await lease.observe()
    const region = observation.elements.find(element => element.group !== undefined)
    if (region === undefined) throw new Error('fixture record not found')
    const extraction = await lease.extract({
      kind: 'list',
      observationId: observation.id,
      regionRef: region.ref,
      limit: 5,
    })
    expect(extraction.kind).toBe('list')
    expect(extraction.total).toBe(PAPERS)
    expect(extraction.truncated).toBe(true)
    expect(extraction.rows).toHaveLength(5)
    expect(extraction.rows[0]?.url).toBe(`${baseUrl}/abs/0`)
    expect(extraction.rows[0]?.text).toContain('Paper number 0 on browser runtimes')
  })

  it('extracts a table keyed by its header cells', async () => {
    const extraction = await lease.extract({ kind: 'table', limit: 10 })
    expect(extraction.columns).toEqual(['index', 'Subject', 'Entries'])
    expect(extraction.rows).toEqual([
      { index: '0', Subject: 'Artificial Intelligence', Entries: '412' },
      { index: '1', Subject: 'Machine Learning', Entries: '188' },
    ])
  })

  it('extracts links with absolute URLs', async () => {
    const extraction = await lease.extract({ kind: 'links', limit: 4 })
    expect(extraction.columns).toEqual(['index', 'text', 'url', 'title'])
    expect(extraction.rows[0]?.url).toBe(`${baseUrl}/cs`)
    expect(extraction.truncated).toBe(true)
  })

  it('extracts the article body of the page', async () => {
    const extraction = await lease.extract({ kind: 'article', maxTextChars: 400 })
    expect(extraction.rows).toHaveLength(1)
    expect(extraction.rows[0]?.text).toContain('Showing 1-50 of 600 entries')
    expect(extraction.rows[0]?.text?.length).toBeLessThanOrEqual(400)
  })

  it('rejects an extraction region from a superseded observation', async () => {
    const first = await lease.observe()
    const stale = first.elements[0]
    if (stale === undefined) throw new Error('fixture element not found')
    await lease.observe()
    await expect(lease.extract({
      kind: 'list',
      observationId: first.id,
      regionRef: stale.ref,
    })).rejects.toMatchObject({ code: 'BROWSER_STALE_REFERENCE' })
  })
})

describe.skipIf(!hasChromium)('interaction tools in a real browser', () => {
  let server: Server
  let baseUrl: string
  let ctx: Context
  let lease: BrowserEnvironmentLease
  let unregister: (() => Promise<void>) | undefined

  beforeEach(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (request.url?.startsWith('/search')) {
        response.end(`<!doctype html><title>Results</title><p>Results for ${request.url.split('=')[1] ?? ''}</p>`)
        return
      }
      response.end(`<!doctype html>
        <html><head><title>Form fixture</title></head>
        <body style="margin:0">
          <form action="/search"><input type="text" name="q" aria-label="Query"></form>
          <select id="pick" aria-label="Pick">
            <option value="a">Alpha</option>
            <option value="b">Beta</option>
          </select>
          <input type="checkbox" id="agree" aria-label="Agree">
          <div style="height:4000px"></div>
          <button id="deep">Deep button</button>
          <p id="state"></p>
          <script>
            document.getElementById('agree').addEventListener('change', (event) => {
              document.getElementById('state').textContent = 'agree=' + event.target.checked
            })
            document.getElementById('pick').addEventListener('change', (event) => {
              document.getElementById('state').textContent = 'pick=' + event.target.value
            })
          </script>
        </body></html>`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    ctx = new Context()
    await ctx.plugin(BrowserRuntime, { provider: 'playwright' })
    unregister = ctx.browserRuntime.registerProvider(new PlaywrightBrowserProvider({
      headless: true,
      allowPrivateNetwork: true,
    }))
    lease = await ctx.browserRuntime.acquire({
      owner: {},
      sessionId: BrowserSessionId('interaction-fixture'),
      persistence: 'ephemeral',
    })
    await lease.act({ type: 'navigate', url: `${baseUrl}/` })
  })

  afterEach(async () => {
    await lease.release()
    await unregister?.()
    await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })

  async function refFor(match: (kind: string, name: string) => boolean): Promise<{
    observationId: BrowserObservation['id']
    ref: BrowserObservation['elements'][number]['ref']
  }> {
    const observation = await lease.observe()
    const element = observation.elements.find(candidate => match(candidate.kind, candidate.name))
    if (element === undefined) throw new Error('fixture element not found')
    return { observationId: observation.id, ref: element.ref }
  }

  it('submits a form by pressing Enter in its field', async () => {
    const field = await refFor(kind => kind === 'input:text')
    await lease.act({ type: 'fill', observationId: field.observationId, elementRef: field.ref, value: 'browsers' })
    const pressed = await refFor(kind => kind === 'input:text')
    const transition = await lease.act({
      type: 'press',
      key: 'Enter',
      observationId: pressed.observationId,
      elementRef: pressed.ref,
    })
    expect(transition.outcome).toBe('succeeded')
    expect(transition.after?.url).toContain('/search?q=browsers')
    expect(transition.after?.text).toContain('Results for browsers')
  })

  it('chooses a select option and toggles a checkbox', async () => {
    const select = await refFor(kind => kind === 'select')
    const selected = await lease.act({
      type: 'select',
      observationId: select.observationId,
      elementRef: select.ref,
      values: ['b'],
    })
    expect(selected.after?.text).toContain('pick=b')

    const checkbox = await refFor(kind => kind === 'input:checkbox')
    const checked = await lease.act({
      type: 'check',
      observationId: checkbox.observationId,
      elementRef: checkbox.ref,
      checked: true,
    })
    expect(checked.after?.text).toContain('agree=true')
  })

  it('scrolls by viewport multiples, to an end, and to an element', async () => {
    const down = await lease.act({ type: 'scroll', to: 'down', pages: 2 })
    expect(down.outcome).toBe('succeeded')
    await lease.act({ type: 'scroll', to: 'bottom' })
    await lease.act({ type: 'scroll', to: 'top' })
    const deep = await refFor((_kind, name) => name === 'Deep button')
    const scrolled = await lease.act({
      type: 'scroll',
      to: 'element',
      observationId: deep.observationId,
      elementRef: deep.ref,
    })
    expect(scrolled.outcome).toBe('succeeded')
  })

  it('moves through the environment\'s own history and reloads', async () => {
    await lease.act({ type: 'navigate', url: `${baseUrl}/search?q=first` })
    const back = await lease.act({ type: 'history', direction: 'back' })
    expect(back.after?.url).toBe(`${baseUrl}/`)
    const forward = await lease.act({ type: 'history', direction: 'forward' })
    expect(forward.after?.url).toContain('/search?q=first')
    const reloaded = await lease.act({ type: 'reload' })
    expect(reloaded.after?.url).toContain('/search?q=first')
  })

  it('denies a history move the environment has no entry for', async () => {
    await expect(lease.act({ type: 'history', direction: 'forward' }))
      .rejects.toMatchObject({ code: 'BROWSER_POLICY_DENIED' })
  })

  it('waits for load state and for an element to become visible', async () => {
    const loaded = await lease.act({ type: 'wait', until: 'load' })
    expect(loaded.outcome).toBe('succeeded')
    const deep = await refFor((_kind, name) => name === 'Deep button')
    const visible = await lease.act({
      type: 'wait',
      until: 'element-visible',
      observationId: deep.observationId,
      elementRef: deep.ref,
      timeoutMs: 5_000,
    })
    expect(visible.outcome).toBe('succeeded')
  })
})
