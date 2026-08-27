# Agent Note: Bound browser observation and screenshot output

Status: implemented

English | [中文](2026-08-27-browser-output-budgets.zh.md)

## Problem

A page can expose an arbitrarily large body text value and arbitrarily large full-page screenshot dimensions. Applying the Runtime text limit after Playwright returns `innerText` still transports and allocates the complete string in Node.js. A screenshot without pixel and encoded-byte limits can consume browser memory, protocol bandwidth, Node.js memory, attachment storage, and model context through its render block.

## Decision

Playwright evaluates body-text extraction inside Chromium. The evaluated function computes `innerText`, returns only the prefix selected by the Runtime's `maxTextChars`, and reports whether the complete text was longer. The full string remains transient renderer state and does not cross the Playwright protocol. Interactive metadata remains independently bounded by `maxElements`.

The Playwright Provider has two positive-integer configuration limits: `maxScreenshotPixels`, defaulting to 16,000,000 device pixels, and `maxScreenshotBytes`, defaulting to 16 MiB. Invalid values reject Provider construction.

Before capture, the Provider measures viewport or document dimensions and the device scale factor in Chromium. It rejects an unsafe or over-budget device-pixel product before encoding. A permitted full-page request uses the measured document rectangle as a fixed clip instead of asking Playwright to determine full-page dimensions again. Page growth after measurement therefore cannot enlarge that capture. After PNG encoding, the Provider rejects an over-budget byte buffer before it reaches attachment storage. Both denials use `BrowserProviderPolicyError`; the Runtime exposes them as `BROWSER_POLICY_DENIED`.

## Alternatives considered

**Rely on action timeouts.** Rejected because a large result can allocate substantial memory and complete within the timeout.

**Apply limits only in the Runtime.** Rejected because the complete text or PNG would already have crossed the Provider interface and entered Node.js memory.

**Use only the encoded-byte limit.** Rejected because a highly compressible image can have a small PNG while requiring a very large raster allocation.

**Remove full-page screenshots.** Rejected because bounded full-page evidence is useful and the Provider can define a fixed capture rectangle.

## Verification

A real managed-Chromium test navigates to a page with 100,000 body characters and receives exactly the configured 60,000-character prefix with `truncated: true`. Another real-browser test verifies that a viewport capture below the pixel limit but above a one-byte PNG limit fails through the byte path, while a tall full-page capture fails through the pixel path. The existing allowed screenshot test verifies the PNG signature. A unit test verifies load-time rejection of non-positive screenshot limits.

## Consequences

Observation transport and stored screenshot output have explicit limits. Operators can tune screenshot budgets in `cordis.yml`; lower values reject evidence that previously fit only the default limits.

Text extraction still materializes `innerText` transiently inside the renderer. PNG byte validation necessarily occurs after Chromium encodes and Playwright transfers the PNG, so it cannot prevent that transient browser and Node.js allocation. The pixel preflight limits the raster dimensions, and the byte check prevents attachment persistence and downstream output of an oversized encoding.
