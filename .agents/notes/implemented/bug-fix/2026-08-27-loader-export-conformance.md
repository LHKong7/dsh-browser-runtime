# Agent Note: Keep the plugin contract through Loader.unwrapExports

Status: implemented

English | [中文](2026-08-27-loader-export-conformance.zh.md)

## Problem

Both functional plugin entry points published a named contract and a default export:

```ts
export const name = 'browser-playwright'
export const inject = ['browserRuntime']
export const Config = /* schema */
export function apply(ctx, config) { /* … */ }
export default apply
```

The DSH Loader resolves an imported module with `exports.default ?? exports`, so it received the bare `apply` function and discarded `inject`, `Config`, and `name`. The Provider then ran without its declared service dependency and failed at `ctx.browserRuntime` with `cannot get property "browserRuntime" without inject`, and the Tools plugin lost its config schema and its three other injections. Nothing in the repository exercised the Loader, so a green test suite, a successful build, and a clean `publint` run all reported a package that could not mount.

Republishing the fix under the already-published `0.1.1` compounded it: pnpm treated a same-version, same-path tarball as the package it had already resolved, so a corrected source tree still produced the old runtime behavior.

## Decision

A functional plugin entry point uses named exports only. A default export is reserved for a Service or class plugin that carries `inject` and `Config` as static properties, because Cordis accepts a constructor directly and reads those statics off it. `dsh-browser-runtime` keeps `export { BrowserRuntime as default }` under that rule; `dsh-browser-runtime/playwright` and `dsh-browser-runtime/tools` have no default export at any level, including the implementation modules the entry points re-export.

`tests/loader-conformance.spec.ts` runs the real `Loader.prototype.unwrapExports` from `@deepseek-ai/cordis-plugin-loader` over the real entry-point namespaces, asserts the surviving contract, and then mounts all three unwrapped plugins in a real Cordis Context with the real `dsh-tools`, `dsh-system-prompt`, and an attachment store. The suite fails with the original `without inject` error if a default export returns.

`scripts/verify-package.mjs` repeats that gate against built artifacts rather than source: it resolves every `exports` subpath, rejects a default export in the functional entries by reading the emitted JavaScript, unwraps and mounts each entry, checks that the declaration targets, the bundle patch, and the CLI actually shipped, and prints the package version, source commit, and a SHA-256 digest over the entry points. `scripts/pack-check.mjs` packs, extracts, and runs that gate plus `doctor` against the extracted tarball. Both run in CI after `build` and `lint:package`.

The fix ships as `0.1.2`. Every change to the build output takes a new version.

## Alternatives considered

**Keep the default export and add `apply.inject`.** Rejected because function properties survive unwrapping only by accident of the shape, the Config schema still has no home Cordis reads, and the rule would be invisible to a future contributor.

**Assert the export shape with a hand-written unwrap helper only.** Rejected because that pins the package against its own assumption. The CLI does carry a documented copy for use where the loader package is not installed, and `tests/cli-diagnostics.spec.ts` compares it against the real implementation across every module shape the bundle can produce.

**Check only the source tree.** Rejected because the observed failure was in an installed artifact. A `files` omission, a stale `lib/`, or a build that reintroduces a default export are invisible until the tarball itself is unwrapped and mounted.

**Republish under `0.1.1`.** Rejected because that is the failure mode already observed: pnpm resolved the cached package and the corrected source never reached the profile.

## Verification

`tests/loader-conformance.spec.ts` passes on the corrected entry points and reproduces the original mounting failure when the default exports are restored. `pnpm run verify:package` mounts the built tree; `pnpm run verify:tarball` packs, extracts, mounts, and runs `doctor` over the archive, reporting `browser-runtime, browser-playwright, tool-browser mounted`, the registered provider, the registered tools, and the integrity digest.

## Consequences

The three entry points mount from an installed profile, and a reintroduced default export fails CI at both the source and artifact level. Contributors adding an entry point must follow the named-export rule and register it in `ENTRIES` in `scripts/verify-package.mjs` and in `ENTRY_POINTS` in `src/cli/diagnostics.ts`. The package gains `@deepseek-ai/cordis-plugin-loader` as a development dependency so the gate uses the real Loader rather than a description of it.
