# Agent Note: Preserve routed request failure identity

Status: implemented

English | [中文](2026-08-27-route-policy-error-classification.zh.md)

## Problem

The Playwright route handler caught network-policy checks and `route.continue()` in one block. A closed context or another request transport failure was therefore recorded as a blocked URL, and the active navigation could surface `BROWSER_POLICY_DENIED` even though policy admitted the request. The single blocked-URL slot also accepted subresource denials and was consulted only by explicit `navigate` actions, so an image request could replace failure evidence while policy-denied navigation initiated by `click` lacked the same stable error.

## Decision

`routeWithNetworkPolicy()` catches only `BrowserProviderPolicyError` from request admission. It reports that denial synchronously before aborting the route; `route.continue()` and `route.abort()` execute outside the catch and retain their Playwright failures.

The Playwright environment applies this check to every routed request but retains a denial only for navigation on its primary page frame. Each action clears prior denial state. Explicit navigation and click-triggered navigation both surface a retained denial as `BROWSER_POLICY_DENIED`; denied subresources are aborted without replacing the action result.

## Alternatives considered

**Catch the complete route handler and infer denial from any rejection.** Rejected because request transport and context lifecycle failures are not policy decisions and require the ordinary `BROWSER_ACTION_FAILED` path.

**Retain the last denied request regardless of resource type.** Rejected because a blocked image, script, or frame must not replace the failure identity of the main action.

**Check only model-supplied navigation URLs.** Rejected because redirects, page scripts, and subresources can reach destinations absent from the original tool arguments.

## Verification

The network-policy unit suite requires a denied route to abort without continuing, then injects `route.continue()` and `route.abort()` failures and requires each same error object to escape. The continue failure produces no denial callback; the abort failure preserves the admission denial callback without replacing its transport error. The real Chromium suite clicks a link whose main-document URL contains embedded credentials and requires the Runtime to return `BROWSER_POLICY_DENIED`.

## Consequences

Policy errors now identify policy decisions across explicit and page-initiated main navigation. Subresource requests remain subject to policy without turning every blocked asset into an action failure. Playwright route failures are visible as Provider failures instead of false security denials. The [browser egress policy](2026-08-27-browser-egress-policy.md) owns DNS pinning and transports outside request routing.
