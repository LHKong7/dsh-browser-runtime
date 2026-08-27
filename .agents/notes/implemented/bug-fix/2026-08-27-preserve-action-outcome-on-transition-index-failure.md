# Agent Note: Preserve action outcomes when the transition index fails

Status: implemented

English | [中文](2026-08-27-preserve-action-outcome-on-transition-index-failure.zh.md)

## Problem

An admitted browser action can change external state before the Runtime records its compact transition. Treating a compact-index write rejection as `BROWSER_EVIDENCE_WRITE_FAILED` replaced a successful action, Provider failure, or caller cancellation with a storage error. The tool Consumer then reported an error that could cause the model to repeat a click, fill, or navigation whose side effect had already occurred. `listTransitions()` also selected durable rows instead of memory whenever any durable row existed, so one older durable record could hide a current transition retained only in memory.

## Decision

The compact `transitions` table is an auxiliary operator query index, not the commit point for a browser action. The Runtime appends every transition to its bounded in-memory records before attempting the durable write. A rejected write emits a warning and does not replace action success, Provider failure, or the caller's cancellation reason.

`listTransitions()` merges durable rows with bounded in-memory records by transition id. The in-memory value wins for a duplicate id, and a current record remains queryable in the process even when the compact index rejected it.

Checkpoint metadata has different semantics because it is required for cross-process resume. A checkpoint metadata commit failure remains fatal, rolls back the newly created Provider payload, and uses the specific `BROWSER_CHECKPOINT_METADATA_FAILED` code. DSH's existing `tool/call` and `tool/result` Session events remain the durable record of model-visible interaction; the auxiliary transition index does not replace them.

## Alternatives considered

**Propagate a combined action-and-index error.** Rejected because callers need the actual action result to decide whether retry is safe. A storage wrapper still masks the distinction that matters.

**Mark the action unknown and invalidate the environment.** Rejected because closing browser state cannot undo an external click or submission, and an unknown tool error still invites a retry.

**Atomically commit the browser side effect and transition row.** Rejected because a remote web action and the local storage backend do not share a transaction coordinator.

**Queue transition writes for durable retry.** Rejected because retry ownership, shutdown draining, and persistent queue state would add lifecycle machinery for an optional operator index. The Session event log already owns durable model-visible history.

## Verification

Storage integration tests inject a backend that accepts reads and rejects every mutation. They require successful actions to remain successful, Provider failures to retain `BROWSER_ACTION_FAILED` and their cause, caller cancellation to retain its exact reason, and `listTransitions()` to return both an older durable row and the current in-memory row. A real `ToolRuntime` integration requires `browser_open` to return a successful tool result under the same index failure. The checkpoint rollback test separately requires `BROWSER_CHECKPOINT_METADATA_FAILED` and deletion of the unindexed Provider payload.

## Consequences

An auxiliary storage outage cannot turn a known browser result into a misleading tool failure, reducing unsafe model retries after external side effects. Operators receive a warning, and current-process inspection retains the record until bounded-memory eviction. A rejected compact row can be absent from transition queries after restart; durable model-visible history remains in the Session log. Checkpoint metadata retains strict failure and rollback semantics because losing it would make resume state unreachable.
