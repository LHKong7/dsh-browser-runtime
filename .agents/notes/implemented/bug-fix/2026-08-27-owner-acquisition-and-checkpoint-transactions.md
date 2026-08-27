# Agent Note: Keep owner acquisition and checkpoints lifecycle-safe

Status: implemented

English | [中文](2026-08-27-owner-acquisition-and-checkpoint-transactions.zh.md)

## Problem

An owner environment is shared across compatible `BrowserRuntime.acquire()` calls, but binding provider setup to the first caller's signal lets that caller cancel every concurrent waiter. The tool Consumer had the same coupling between its Agent-scoped lease setup and the first tool-call signal. Checkpoint creation also produced Provider payloads before committing Runtime metadata without removing the new payload when the metadata write failed, and prior-payload cleanup continued after the checkpoint operation returned. A Provider could advertise checkpoint support while omitting `restore()`, `destroyCheckpoint()`, or an environment's `checkpoint()`, making rollback impossible or deferring misconfiguration until shutdown.

Provider selection can await asynchronous `available()` after reading a registration but before associating its owner slot with that Provider. Unregistration could therefore miss the opening slot, call Provider-wide `dispose()`, and let the acquire continue into `open()` on the disposed Provider. Checkpoint transactions from different owner objects can also share one session id. Without a Runtime-owned per-session order, an earlier metadata failure can restore or delete the in-memory index written by a later transaction even though the storage domain serializes its own backend writes. Two Providers opened before the first checkpoint exists could then replace the same session index in sequence, leaving the first Provider's private payload unreachable.

## Decision

The owner slot owns provider setup and its cancellation signal. Each acquire waits for the shared setup through its own signal; caller cancellation rejects only that wait. When all pending callers leave without a lease, slot shutdown aborts setup. Provider removal and Runtime disposal continue to abort the owner slot and wait for rollback.

Provider selection associates each candidate registration with the owner slot before awaiting `available()`. Unregistration removes the Provider from the registry, aborts and settles candidate selection or environment opening, closes published environments, and only then calls Provider-wide `dispose()`. Exact selection rechecks registration identity after availability resolves; automatic selection retries when registry membership changed during its asynchronous checks and commits only a stable snapshot.

The Agent tool binding owns its lease acquisition. Tool calls independently wait for the binding's promise, while Agent disposal aborts the acquisition. A tool timeout therefore cannot fail another concurrent tool call waiting for the same Agent lease. Cancellation during an operation invalidates and releases that lease because the Playwright Provider closes its BrowserContext to stop work; the next tool call waits for cleanup and acquires a new environment.

Checkpoint creation treats the Provider payload and Runtime index as one ordered transaction. Payload creation, metadata commit or rollback, and prior-payload cleanup serialize by session id across owner environments. A caller cancelled while waiting releases its queue turn only after the preceding transaction settles, so later work cannot bypass active checkpoint state. Each transaction reads the current index before creating its payload and rejects a different Provider with `BROWSER_CHECKPOINT_PROVIDER_MISMATCH`. A metadata commit failure restores the previous in-memory index and waits for deletion of the new payload; failure of both steps is an `AggregateError`. A successful replacement waits for best-effort deletion of the previous payload before returning. Explicit deletion commits the metadata and in-memory removal before deleting the Provider payload, avoiding an index that references state already removed from the Provider.

Advertising checkpoint support makes `restore()` and `destroyCheckpoint()` mandatory at Provider registration. Every environment from that Provider must expose `checkpoint()`; the Runtime closes and rejects a newly opened environment that does not. These checks make payload rollback and replacement cleanup available before a checkpoint transaction can begin.

## Alternatives considered

**Let the first caller own shared provider setup.** Rejected because compatible acquires promise independent caller cancellation and leases; registration order must not make one caller the lifecycle owner of another.

**Wait for setup to finish before honoring caller cancellation.** Rejected because it preserves shared setup but makes acquisition cancellation ineffective during a slow browser launch.

**Only recheck Provider registration after `available()`.** Rejected because it prevents a later `open()` but still allows Provider-wide disposal to race the in-flight availability call. Publishing the candidate on the owner slot lets unregistration settle the whole selection interval.

**Rely on the storage domain's write chain for checkpoint ordering.** Rejected because that chain serializes durable writes, not the Runtime's preceding in-memory replacement or its failure rollback. The complete payload/index transaction needs the same per-session order.

**Replace a checkpoint through a different Provider and ask the prior Provider to delete its payload.** Rejected because v0.1 does not define cross-Provider checkpoint conversion or replacement semantics. Requiring explicit checkpoint deletion before switching Providers avoids implicit state loss and cross-registration cleanup races.

**Leave a new payload after metadata failure.** Rejected because no Runtime index can name or delete that payload after restart.

**Delete a checkpoint payload before its metadata.** Rejected because a metadata write failure would preserve a durable index whose Provider state is already missing.

**Permit checkpoint Providers without payload deletion.** Rejected because an optional deletion operation makes metadata rollback and explicit checkpoint destruction incapable of reaching a defined final state.

## Verification

Runtime tests cancel one of two concurrent acquires during delayed Provider setup and require the other acquire to receive the single opened environment; a last-waiter case requires setup rollback without a cleanup warning. Provider-removal races cover configured and automatic selection, hold `available()` pending, and require unregistration to wait without calling `open()` after disposal. Runtime tests also reject a checkpoint Provider missing lifecycle methods during registration, require a newly opened environment missing `checkpoint()` to close before acquisition fails, preserve both validation and close failures in an `AggregateError`, prove that cancelling a queued same-session checkpoint does not let a third transaction overtake the active one, and reject a concurrent cross-Provider replacement before the second Provider creates a payload. Tool integration tests exercise the equivalent acquisition race through `ctx.tools.execute`, then cancel an admitted operation and require the next tool call to open a second environment successfully. Playwright integration interrupts a real slow navigation, releases the closed context, and opens a fresh environment. Storage integration rejects the first of two same-session metadata commits and requires the later commit to remain identical in the Runtime and durable index while the failed payload is deleted once.

## Consequences

Concurrent callers no longer share cancellation, while the owner lifecycle still reaches quiescence when every caller leaves. Shared setup can continue after one caller stops, which is intentional while another caller or the Agent binding owns it. Provider unload may wait for an asynchronous availability check or partial open to settle, but no environment starts after Provider-wide disposal. An operation timeout discards that Agent's current browser environment, so ephemeral page state is lost; this avoids caching an environment that Playwright has already closed. Same-session checkpoint work loses cross-owner parallelism in exchange for one coherent payload/index history, and cancellation can leave an empty queue turn until its predecessor settles. Switching the checkpoint Provider requires releasing live environments, explicitly deleting the old checkpoint, and acquiring with the new Provider. Checkpoint failure paths perform more cleanup before returning, preventing unindexed payloads and background deletion work at the cost of waiting for Provider cleanup. Checkpoint Provider misconfiguration fails during registration or environment opening instead of after browser use, and rejected environments incur an awaited close.
