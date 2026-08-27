# Agent Note: Rank and page browser observations

Status: implemented

English | [中文](2026-08-27-observation-ranking-and-paging.zh.md)

## Problem

One `browser_open` on an arXiv listing took about three seconds, returned 18,902 characters, and hit the 100-element reference cap. Navigation was fine; the observation was not. The cap was spent on author links, per-paper Abstract/PDF/HTML/Other links, and repeated format links, so the page controls a model actually needs — the search box, the date switcher, and the `51-100`, `101-150`, `more`, `all` paging entries — were partly or entirely outside the returned set. The bounds were also silent about themselves: an observation reported a boolean `truncated` for text and nothing at all for elements, so the model could not tell whether the paging link it wanted existed and was dropped, or did not exist.

Ordering was document order, and the only bound was a single count. Both are the wrong shape for a listing page: document order puts the least useful links first when a page repeats a record hundreds of times, and one number cannot express "keep every control, drop the authors".

## Decision

The Provider ranks elements into five tiers before they cross the Playwright protocol: form controls, buttons, and pagination; site navigation and page-level actions; the title link of a repeating record; ordinary body links; repeated per-record links such as authors, footnotes, and download formats. Elements are returned sorted by tier and then document order, so the element budget cuts the tail rather than an arbitrary suffix of the document. A run of numeric or next/previous/more/all links marks each of them as pagination; a lone such link stays ordinary content, because a single `2` in prose is not a pager.

Ranking runs inside Chromium, in `src/provider/page-snapshot.ts`. The decision needs the DOM, and deciding in the page keeps the protocol payload bounded: the Runtime would otherwise have to receive every candidate in order to rank them.

Elements inside one repeating record carry a shared `groupKey`, and the Runtime mints observation-local group refs such as `g1`. A record is the nearest ancestor repeating among at least three siblings, and a `dt`/`dd` pair counts as one record, which is what makes an arXiv entry's action links collapse under its title. Element fingerprints deliberately exclude tier, section, and group: a record moving within a list must not invalidate a reference the model already holds.

`browser_observe` takes a mode. `summary` (the default) returns tiers 1-3 plus a text lead, `interactive` returns every tier and no page text, and `document` returns page text plus only the controls needed to keep reading. Each mode has its own text and element budget; explicit `max_text_chars` and `max_elements` override them and the plugin configuration caps both.

`browser_observe_next` reads the next page of the newest observation. It re-projects a stored observation rather than re-observing, so element references stay valid while the model pages through text or the element tail. A continuation belongs to the newest observation only: any tool that produces an observation replaces the cursor, and an older token fails with `BROWSER_OBSERVATION_SUPERSEDED` rather than quietly reading a page the model has moved past.

Observations report the page's total text length and visible element count next to both truncation flags, so "not shown" is always a number rather than an inference.

## Alternatives considered

**Raise `maxElements`.** Rejected because it makes the failure bigger rather than better: 300 references on that page are still mostly authors, and the token cost grows with the noise.

**Rank in the Runtime.** Rejected because ranking needs landmark ancestors, sibling structure, and computed visibility. Sending all of that to Node to sort it there is the transport cost the bound exists to avoid.

**Let the model pass a CSS selector to narrow the observation.** Rejected because model-supplied selectors are exactly the capability this plugin does not grant; a selector is a general read primitive over the page.

**Include tier and group in the element fingerprint.** Rejected because it would make a reference stale whenever a list reordered around it, turning an ordinary page update into a spurious stale-reference error.

**Have `browser_observe_next` re-observe with a larger budget.** Rejected because a new observation invalidates every reference the model is holding, which is the opposite of what a caller reading further down one page wants.

## Verification

A real-Chromium suite serves a listing shaped like the page that motivated this — a search form, four paging links, and twelve `dt`/`dd` papers with four action links and three author links each. It asserts that controls and every paging entry rank ahead of the first per-record link, that a paging run is marked while a lone link is not, that a 12-element budget keeps all four paging entries and drops the authors, and that each `dt`/`dd` pair collapses into one labelled record. Tool-level tests cover each mode's tier selection, continuation advance and exhaustion, a superseded cursor, and that a reference from a paged observation still acts.

## Consequences

A first observation of a large listing fits a small budget while retaining every page control, and truncation is reported as counts the model can act on. Callers now choose a mode instead of raising a limit, and reading further down one page no longer costs the references they hold.

Ranking is a heuristic over structure, not a semantic understanding of the page. A site that builds records without repeating sibling elements will not produce groups, and a paging control styled as a lone link will not be marked. The tiers are fixed in the Provider rather than configurable, so a page whose priorities differ from the common case cannot reorder them; the escape hatch is `interactive` mode plus paging, which returns everything.
