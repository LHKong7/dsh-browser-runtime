# Agent Note: Enforce the Playwright single-page capability

Status: implemented

English | [中文](2026-08-27-single-page-enforcement.zh.md)

## Problem

The Playwright Provider advertises `multiplePages: false`, but a page can request another browsing context through a link or form target, `window.open`, or another browser mechanism. Closing a new Page without awaiting it does not preserve the advertised capability: the action can be recorded as successful, cleanup failure is lost, and an unmanaged Page can outlive the operation.

## Decision

The Provider owns one primary Page and treats creation of another browsing context as a browser policy denial. Each element snapshot and fingerprint records whether its effective link or form target would create a new context. Reserved self/parent/top targets and existing named frames remain valid; `_blank` and names without an existing frame are rejected before click dispatch. A target mutation that changes this result after observation is stale.

The BrowserContext installs a script before the primary Page is created. It replaces `window.open` with a function that reports the attempt through a random per-environment binding and returns `null`, matching the browser result for a blocked popup. The action performs a browser protocol round trip after dispatch, observes the binding revision, and returns `BROWSER_POLICY_DENIED` without creating a Page or sending its navigation request.

The context-level Page event remains the fallback for creation paths outside those two controls. It immediately starts Page closure and tracks every closure promise. Actions drain old closures before dispatch and new closures afterward; environment teardown also drains them. A close failure is retained and combined with the action or policy failure instead of being discarded.

## Alternatives considered

**Treat `multiplePages: false` as descriptive metadata only.** Rejected because capability negotiation must describe behavior that the Provider enforces.

**Close extra Pages asynchronously and keep the action successful.** Rejected because the Agent receives success for an effect it cannot observe or continue, while cleanup failure and resource ownership remain indeterminate.

**Replace the primary Page with the popup.** Rejected because popup handoff changes page identity, navigation evidence, and checkpoint behavior. It belongs to a future multiple-page or explicit handoff capability.

**Reject every link or form target.** Rejected because `_self`, `_parent`, `_top`, `_unfencedTop`, and existing named frames remain inside the owned Page.

## Verification

Real Chromium integration tests click an observed `_blank` link and a button whose handler calls `window.open`. Both actions return `BROWSER_POLICY_DENIED`, the popup endpoint receives no request, no popup response remains active, and the primary Page remains observable. A third fixture schedules a detached `_blank` link after its action completes; its initial request reaches the fixture, the context fallback drains the active response, and the primary Page remains observable. The ordinary click, navigation, WebSocket, cancellation, checkpoint, and strict-proxy tests continue through the assembled Runtime.

## Consequences

Popup-based authentication, payment, and document workflows are unavailable in v0.1 even when the browser would normally permit them. `window.open` is feature-detectably blocked and returns `null`. Targets that resolve to an existing frame remain usable.

The fallback Page event guarantees cleanup ownership, not zero initial network activity: an unrecognized browser creation path can start its first request before Playwright reports the Page. Strict mode still applies its destination proxy to that request. Explicit private-network mode can contact the admitted destination before the fallback closes the Page.
