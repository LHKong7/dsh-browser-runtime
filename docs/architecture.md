# Architecture

English | [中文](architecture.zh.md)

This reference defines v0.1 ownership, lifecycle, concurrency, evidence, persistence, and Provider obligations.

## Roles

```text
Agent / tool / workflow
        │ acquire(owner, sessionId, policy)
        ▼
BrowserRuntime (ctx.browserRuntime)
  provider registry · leases · FIFO · refs · evidence · checkpoint index
        │ open / restore / observe / act / screenshot / checkpoint / close
        ▼
BrowserProvider
        │
        └── PlaywrightBrowserProvider → isolated Chromium BrowserContext + one Page
```

The Runtime is the only public owner of environment identity and leases. Consumers never receive Playwright objects, provider targets, CSS selectors, or filesystem paths.

## Acquisition and ownership

`BrowserRuntime.acquire()` requires an exact `owner` object, a durable `BrowserSessionId`, persistence policy, and optional provider/capability requirements. The Runtime uses object identity, not a string owner id, as the process-local sharing key.

Concurrent acquisition for one owner is single-flight. The owner slot owns the provider-open cancellation signal; each caller races the shared result against its own signal without cancelling another waiter. Compatible calls receive separate leases over one environment; incompatible session, persistence, or provider settings fail with `BROWSER_OWNER_CONFLICT`. When no caller or lease remains, the slot aborts unfinished setup. Each lease releases once. The last release closes admission, aborts and drains admitted work, optionally checkpoints, and closes the provider environment.

The tool Consumer applies the same ownership rule at Agent scope. The Agent binding owns lease acquisition, while each tool call can cancel only its wait for that lease. If cancellation interrupts an operation after acquisition, the binding waits for release of the possibly unusable lease; the next tool call acquires a fresh environment. Agent disposal aborts unfinished acquisition, waits for any invalidated-lease cleanup, and releases a published lease.

Provider registration is an effect. Selection remains owned by its candidate registration while `available()` is pending, and automatic selection makes its decision against a stable registry snapshot. The registration disposer removes the Provider from selection, aborts and settles selection/opening work, closes every environment opened through it, then calls Provider-wide `dispose()`. Runtime disposal performs the same environment drain. Cleanup attempts checkpoint and close independently and reports both failures through `AggregateError`.

## Observation and action

A Provider observation contains page fields and opaque targets. The Runtime assigns environment, generation, page, observation, revision, digest, and local element identities. It retains provider targets only for the latest observation.

`click` and `fill` must name the latest observation and one of its refs. The Runtime rejects older observations before the Provider runs. The Provider re-resolves its opaque target and verifies its fingerprint immediately before the action, covering page changes that occur without another Runtime observation. `fill` rejects a target observed as `input[type=password]`.

All operations for one environment use one FIFO. Separate environments have separate FIFOs. Browser tools do not declare concurrency safety, so DSH's scheduler also treats model-visible calls as exclusive.

An admitted action produces a `BrowserTransition`. A successful transition has before and after observations. A provider failure records `failed`; an action that completed but could not produce after-state evidence records `unknown` and throws `BROWSER_ACTION_EVIDENCE_FAILED`. Runtime evidence records fill length and `[REDACTED]`, never its value.

## Persistence and evidence

The Runtime keeps checkpoint and transition metadata in memory. When `ctx.storageDomain` is mounted, it opens the `browser_runtime` domain and writes `checkpoints` and compact `transitions` tables. The checkpoint table is required for cross-process resume. The transition table is an auxiliary query index: a write failure emits an operator warning without changing action success, Provider failure, or caller cancellation. `listTransitions()` merges its durable rows with the bounded in-memory records by transition id, so current-process queries retain a record that the compact index rejected. Compact transitions retain ids, URL/digest/revision evidence, redacted action, timing, outcome, and failure, but omit page text and Provider targets.

Provider checkpoint payloads remain private to the Provider. Playwright writes an opaque random-name JSON file with mode `0600` under an owner-only directory and returns only the filename ref. The payload contains cookies and localStorage. `BrowserRuntime` prevents restoration or checkpoint replacement through a different Provider; replacement rejects before creating another payload. Payload creation, metadata commit or rollback, and prior-payload cleanup serialize by session id across owner environments. A cancelled queued checkpoint retains its ordering position until the preceding transaction settles, so later work cannot overtake it. Checkpoint creation commits metadata after the Provider payload exists; a metadata failure reports `BROWSER_CHECKPOINT_METADATA_FAILED` and rolls back the new payload. Replacing a checkpoint waits for best-effort deletion of the prior payload. Explicit deletion removes durable metadata before deleting the payload, so a metadata failure cannot leave an index that references missing Provider state.

Screenshots use a separate path: the Runtime returns PNG bytes to the tool Consumer, which calls `ctx.attachments.saveImage`. The tool result carries the durable attachment ref and an image render block; no host output path enters model arguments or output.

The plugin writes no custom Session event types. DSH's existing `tool/call` and `tool/result` events retain model-visible calls and results; `tool/result` content carries observations, transition ids, and attachment refs.

## Provider obligations

A Provider has a unique branded id, truthful capability flags, `available()`, and `open()`. A checkpoint-capable Provider must implement `restore()` and `destroyCheckpoint()`, and every environment it returns must implement `checkpoint()`. The Runtime rejects missing Provider methods during registration; it closes and rejects a newly opened environment that lacks `checkpoint()`. Provider-wide `dispose()` remains optional.

`open()` and `restore()` retain ownership of partial resources until they fulfill. A rejection must leave no process, context, page, profile directory, or other owned resource running. After fulfillment, `BrowserRuntime` owns `BrowserProviderEnvironment.close()` and may call it repeatedly or after cancellation; close must be idempotent.

Provider methods accept explicit `AbortSignal` values. Cancellation must not return while ignored work continues. The Playwright Provider closes its BrowserContext on abort, waits for the Playwright operation and close path to settle, and leaves the environment unusable.

Provider observations are bounded, exclude hidden/password values and raw HTML, and keep action targets opaque. Target-fingerprint changes throw `BrowserProviderTargetStaleError`; policy denials throw `BrowserProviderPolicyError`.

The Playwright Provider slices body text inside Chromium before transport. Screenshot requests exceeding configured device-pixel or encoded-byte budgets fail with `BROWSER_POLICY_DENIED`; the byte check occurs after PNG encoding.

Each strict Playwright environment owns an authenticated HTTP proxy on an ephemeral IPv4 loopback port. HTTP(S), `ws:`/`wss:`, and proxied browser TCP pass through it. Before page routes are installed, a temporary page loads an empty document returned by the proxy itself to establish Chromium's authentication cache without contacting an upstream server. The proxy validates credentials and destination policy, resolves the hostname once, opens a socket using only the validated addresses, and binds each forwarded HTTP request to that socket with a one-use Agent. Proxy shutdown stops admission and destroys its sockets before BrowserContext and browser cleanup; pending DNS resolution cannot create a connection after proxy close or an observed client abort. Strict mode also disables Chromium QUIC and non-proxied WebRTC UDP. `allowPrivateNetwork` omits the proxy and both launch restrictions, allowing direct browser connections while request and WebSocket routes retain protocol and embedded-credential checks. The Provider uses only Playwright-managed Chromium from the pinned Playwright version.

Playwright request and WebSocket routes preserve operation failure identity and reject disallowed connections before normal browser handling. A denied main-document navigation is retained for the active `navigate` or `click` operation and surfaces as `BROWSER_POLICY_DENIED`; denied subresources are aborted without replacing the operation's result. A denied WebSocket closes with policy code `1008` before `connectToServer()` and is not attributed to an unrelated active action. Failures from `route.continue()`, `route.abort()`, or WebSocket route closure remain Playwright failures and are never classified as policy denials. In strict mode, the proxy repeats policy admission at socket creation and pins its DNS result.

The Playwright Provider advertises `multiplePages: false` and keeps one primary Page. Element fingerprints include whether the effective link or form target names a new browsing context, so a mutation that changes that result is stale and a matching click is rejected before dispatch. A context initialization script makes `window.open` report an attempt and return `null`; the action observes that attempt as `BROWSER_POLICY_DENIED`. The context closes every other Page immediately, and actions and teardown await tracked closure. This fallback prevents a second Page from surviving but cannot prove that an unrecognized creation path sent no initial request before the Page event.

The Provider dismisses every page dialog and tracks dismissal through action or teardown completion. A dismissal failure closes the initiating Page and remains part of the operation failure. File-input snapshots are rejected before dispatch. The initialization script also blocks file-input `click()`, `showPicker()`, click activation, and label activation through a per-environment binding; the Playwright FileChooser event clears any path that bypasses those controls. The action returns `BROWSER_POLICY_DENIED` for an upload attempt.

An anchor `download` attribute is part of its element fingerprint and causes pre-dispatch denial. The Provider tracks each Page navigation until response headers settle. An attachment disposition increments the active download-policy revision and sends `Page.stopLoading` through a Chromium control session; a response that does not produce headers before `navigationTimeoutMs` closes the primary Page. Download events for blob, data, or other paths are cancelled. Actions await navigation settlement, response stopping, download cancellation, and unexpected-page closure before deciding success; cleanup failure is retained alongside the policy or action failure. Playwright owns partial download artifacts until BrowserContext close deletes them, and no artifact path crosses the Provider API.

The BrowserContext starts with an empty global permission grant, and Chromium launches with permission prompts denied. Permission-controlled APIs therefore receive `denied` without host UI. A click that requests a permission remains an ordinary page action rather than a Provider policy operation; its page-visible denial is part of subsequent observation.

Element fingerprints mark external-protocol link and form targets; only HTTP(S), `javascript:`, `blob:`, `data:`, and `about:` are browser-owned. Other protocols fail before click dispatch. The initialization script intercepts anchor and form activation plus `form.submit()`. `Page.frameRequestedNavigation` catches renderer navigation such as `location.href`, records the policy revision, stops loading, and participates in action or teardown settlement.

## Extending the Provider registry

Implement `BrowserProvider`, then register it from an injected Cordis plugin:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserProvider } from 'dsh-browser-runtime'

export const inject = ['browserRuntime']

export function apply(ctx: Context, provider: BrowserProvider): void {
  ctx.browserRuntime.registerProvider(provider)
}
```

The Runtime rejects duplicate ids, a missing or unavailable configured Provider, zero available Providers, ambiguous auto-selection, and unsupported required capabilities. Registration order never selects a Provider.
