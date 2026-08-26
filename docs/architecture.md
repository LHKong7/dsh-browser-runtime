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

Concurrent acquisition for one owner is single-flight. Compatible calls receive separate leases over one environment; incompatible session, persistence, or provider settings fail with `BROWSER_OWNER_CONFLICT`. Each lease releases once. The last release closes admission, aborts and drains admitted work, optionally checkpoints, and closes the provider environment.

Provider registration is an effect. Its disposer removes the provider from selection before closing every environment opened through it, then calls provider-wide `dispose()`. Runtime disposal performs the same environment drain. Cleanup attempts checkpoint and close independently and reports both failures through `AggregateError`.

## Observation and action

A Provider observation contains page fields and opaque targets. The Runtime assigns environment, generation, page, observation, revision, digest, and local element identities. It retains provider targets only for the latest observation.

`click` and `fill` must name the latest observation and one of its refs. The Runtime rejects older observations before the Provider runs. The Provider re-resolves its opaque target and verifies its fingerprint immediately before the action, covering page changes that occur without another Runtime observation. `fill` rejects a target observed as `input[type=password]`.

All operations for one environment use one FIFO. Separate environments have separate FIFOs. Browser tools do not declare concurrency safety, so DSH's scheduler also treats model-visible calls as exclusive.

An admitted action produces a `BrowserTransition`. A successful transition has before and after observations. A provider failure records `failed`; an action that completed but could not produce after-state evidence records `unknown` and throws `BROWSER_ACTION_EVIDENCE_FAILED`. Runtime evidence records fill length and `[REDACTED]`, never its value.

## Persistence and evidence

The Runtime keeps checkpoint and transition metadata in memory. When `ctx.storageDomain` is mounted, it opens the `browser_runtime` domain and writes `checkpoints` and compact `transitions` tables. Compact transitions retain ids, URL/digest/revision evidence, redacted action, timing, outcome, and failure, but omit page text and provider targets.

Provider checkpoint payloads remain private to the Provider. Playwright writes an opaque random-name JSON file with mode `0600` under an owner-only directory and returns only the filename ref. The payload contains cookies and localStorage. `BrowserRuntime` prevents restoration through a different Provider.

Screenshots use a separate path: the Runtime returns PNG bytes to the tool Consumer, which calls `ctx.attachments.saveImage`. The tool result carries the durable attachment ref and an image render block; no host output path enters model arguments or output.

The plugin writes no custom Session event types. DSH's existing `tool/call` and `tool/result` events retain model-visible calls and results; `tool/result` content carries observations, transition ids, and attachment refs.

## Provider obligations

A Provider has a unique branded id, truthful capability flags, `available()`, and `open()`. Checkpoint-capable Providers also implement `restore()` and each environment implements `checkpoint()`. `destroyCheckpoint()` and provider-wide `dispose()` are optional.

`open()` and `restore()` retain ownership of partial resources until they fulfill. A rejection must leave no process, context, page, profile directory, or other owned resource running. After fulfillment, `BrowserRuntime` owns `BrowserProviderEnvironment.close()` and may call it repeatedly or after cancellation; close must be idempotent.

Provider methods accept explicit `AbortSignal` values. Cancellation must not return while ignored work continues. The Playwright Provider closes its BrowserContext on abort, waits for the Playwright operation and close path to settle, and leaves the environment unusable.

Provider observations must be bounded, exclude hidden/password values and raw HTML, and keep action targets opaque. Providers throw `BrowserProviderTargetStaleError` when a target fingerprint changes and `BrowserProviderPolicyError` when policy denies an operation.

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
