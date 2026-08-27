# Agent Note: Deny host permissions and external protocol handlers

Status: implemented

English | [中文](2026-08-27-host-capability-isolation.zh.md)

## Problem

A browser page can request geolocation, notifications, media devices, clipboard access, and other host-backed permissions. It can also navigate to `mailto:`, `tel:`, `file:`, or a custom protocol whose browser behavior may involve host UI or another application. Relying on headless Chromium defaults leaves these results platform-dependent and lets a click appear successful even when it requests a capability outside the Provider API.

## Decision

Every BrowserContext starts with an empty global permission grant. Playwright maps this to Chromium's context-scoped permission override, granting no permission and rejecting all other permission types. Chromium also launches with `--deny-permission-prompts`, so an unsupported permission type cannot fall back to host UI. Permission-controlled APIs report `denied`. The page remains responsible for displaying that result: a click that requests a permission is an ordinary page action, not a Provider policy failure.

Each interactive-element snapshot resolves the effective URL for anchors and submit controls. HTTP(S), `javascript:`, `blob:`, `data:`, and `about:` remain browser-owned navigation protocols. Any other protocol is part of the element fingerprint as an external-protocol attempt. A matching click returns `BROWSER_POLICY_DENIED` before dispatch, and a mutation that changes the protocol classification is stale.

The context initialization script applies the same classification to anchor `click()`, click and submit activation, and direct `form.submit()`. It prevents the browser operation and reports the attempt through a random per-environment binding. A Chromium control session listens for renderer-requested navigation and sends `Page.stopLoading` for an external protocol, covering direct location assignment and other navigation paths that bypass DOM activation controls.

## Operation settlement

The external-protocol binding and Chromium listener increment one environment revision. An action records that revision before dispatch, performs a browser protocol round trip, drains tracked stop commands, and returns `BROWSER_POLICY_DENIED` when the revision changes. A stop-command failure remains part of the policy failure. External navigation scheduled after its triggering action has returned is still stopped as environment-owned background work, but it is not retroactively assigned to the completed action.

## Alternatives considered

**Rely on headless Chromium to suppress prompts and external applications.** Rejected because headless and headful behavior, operating-system handlers, and browser defaults are not a stable Provider policy.

**Expose configurable permission grants.** Rejected for v0.1 because geolocation values, media-device selection, clipboard ownership, user approval, and evidence require explicit capability APIs. A generic string list would grant host access without defining those obligations.

**Depend on Playwright request routing for external protocols.** Rejected because external protocols do not have to become HTTP requests. Element preflight, DOM activation controls, and Chromium navigation events cover the points before a host handler could be selected.

**Reject every non-HTTP(S) URL.** Rejected because `javascript:`, `blob:`, `data:`, and `about:` remain inside the already executing browser page and do not select a host protocol handler. Downloads and popups from those paths remain subject to their separate controls.

## Verification

A real managed-Chromium test confirms that geolocation, notifications, camera, microphone, clipboard read, and clipboard write all report `denied`; notification and geolocation requests complete with denial and no prompt. Other tests confirm pre-dispatch denial for an observed `mailto:` link and custom-protocol form, binding-based denial for a script-created `tel:` anchor and direct `form.submit()`, and Chromium-control denial for a `location.href` assignment. The primary Page URL and observation remain available after each denied path.

## Consequences

Sites that require location, notifications, camera, microphone, clipboard, MIDI, sensors, local fonts, or another browser permission cannot complete those workflows in v0.1. They can still render their own denial state, and the Agent can observe it.

Page scripts can observe the overridden anchor and form activation behavior. HTTP(S) navigation and browser-owned `javascript:`, `blob:`, `data:`, and `about:` navigation remain available, subject to the network, download, and single-page controls.

This is application-level browser control, not an operating-system sandbox. A host sandbox remains necessary when deployment policy requires an independent barrier against browser or Chromium defects.
