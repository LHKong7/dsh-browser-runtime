# Agent Note: Bound dialogs, file choosers, and downloads to Playwright actions

Status: implemented

English | [中文](2026-08-27-browser-transient-effects.zh.md)

## Problem

Browser dialogs, file choosers, and downloads can begin during a Playwright action without appearing in its page observation. Fire-and-forget dismissal or cancellation lets the action return success before the browser effect and its cleanup settle. Disabling Playwright download access also does not prove that the network transfer stopped. These behaviors leave action outcome, resource ownership, and the Provider's advertised lack of upload and download capabilities inconsistent.

## Decision

The Provider automatically dismisses every page dialog and tracks its dismissal promise. A failed dismissal closes the initiating Page so a modal dialog cannot leave the page event loop blocked. The action or teardown retains both the dismissal and page-close failures. Confirm therefore evaluates to `false`, prompt evaluates to `null`, and the Provider exposes no accept or prompt-input operation.

An observed file input is rejected before click or fill dispatch. A context initialization script replaces file-input `click()` and `showPicker()`, captures file-input and associated-label click activation, reports the attempt through a random per-environment binding, and prevents native chooser activation. The Playwright FileChooser event remains a fallback and clears the input with an empty file list. The initiating action returns `BROWSER_POLICY_DENIED`; no host path or file payload enters the page.

An observed anchor with a `download` attribute is fingerprinted as a download and rejected before dispatch. For response-defined downloads, each Page navigation request is tracked until its response headers settle. A navigation response with an attachment content disposition increments the download-policy revision and sends `Page.stopLoading` through a Chromium control session. Blob, data, and other paths that reach a Playwright Download event are cancelled. Playwright download ownership is enabled internally so the Provider can cancel these artifacts; the Provider API never exposes their path, and BrowserContext close deletes partial artifacts.

## Operation settlement

An action drains old navigation, dialog, file-chooser, download, and unexpected-Page work before capturing policy revisions. After dispatch it performs a browser protocol round trip and drains the same work again. New-page, file-chooser, or download revisions classify the action as `BROWSER_POLICY_DENIED` even when Playwright also reports a generic click or navigation failure. Cleanup failure is combined with the policy or action failure instead of replacing or discarding it.

A navigation request that does not produce a response before `navigationTimeoutMs` closes the primary Page and reports cleanup failure, preventing an unbounded response wait from surviving the operation. An effect scheduled after its action has fully returned is still stopped or cleared as environment-owned background work, but it is not retroactively assigned to the completed action.

## Alternatives considered

**Set `acceptDownloads: false` and rely on Playwright defaults.** Rejected because this denies artifact access but does not reliably terminate an active response or associate the denied download with its action.

**Use only dialog, FileChooser, and Download event listeners.** Rejected because browser events can arrive after click completion and after-state observation. Pre-dispatch metadata, initialization controls, response settlement, and event fallbacks cover different timing points.

**Expose upload and download paths in v0.1.** Rejected because host-path selection, file authorization, artifact persistence, evidence rendering, and secret handling require explicit capabilities rather than incidental Playwright access.

**Close the BrowserContext for every unsupported effect.** Rejected because a dialog can be dismissed, a chooser can be prevented or cleared, and a transfer can be stopped while preserving the primary Page. The Provider closes the Page only when bounded settlement cannot be established.

## Verification

Real Chromium integration tests establish that alert, confirm, and prompt dismissal completes before after-state evidence; direct and script-triggered file choosers return `BROWSER_POLICY_DENIED` with an empty file list; declared downloads send no request; blob downloads are cancelled; attachment responses are stopped with no active response left; and a background attachment is stopped while the primary Page remains observable. The full Provider suite also covers ordinary navigation, click, WebSocket, cancellation, checkpoint, strict proxy, and single-page behavior through the assembled Runtime. Node V8 coverage excludes only functions serialized into Chromium because the host isolate cannot observe their execution; these real-browser tests own their behavior.

## Consequences

Pages can observe that file-input `click()` and `showPicker()` return without opening a chooser, just as they can observe the blocked `window.open`. Upload, accepted-dialog, and prompt-input workflows are unavailable until the Provider exposes explicit capabilities for them.

A server determines a response-defined download only after receiving the navigation request. The server can therefore observe the request and initial response bytes before Chromium reports the attachment header and the Provider stops loading. Declarative downloads and observed file inputs are rejected without that network side effect.

Cancelled Playwright artifacts remain Provider-owned until BrowserContext close performs deletion. They are unreachable from model tools and caller APIs, and cancellation settles before an associated action returns.
