# Agent Note: Gate the published package contract

Status: implemented

English | [中文](2026-08-27-package-conformance-gate.zh.md)

## Problem

The package could build and produce a tarball while still carrying inconsistent `exports`, missing declaration targets, or an incomplete `files` list. Its public opaque ids also used a private `__brand` helper instead of the shared DeepSeek Harness `Branded<B>` primitive, so the declaration contract diverged from the host packages it integrates with. Tests had no coverage floor, allowing a passing suite to lose exercised production paths without a CI signal.

## Decision

Every opaque browser id uses `Branded<B>` from `@deepseek-ai/dsh-brand`. The package declares the brand primitive as a peer dependency so its declarations use the host's DSH type identity and as a development dependency so local typechecking is self-contained.

The `lint:package` script runs publint against the built package. CI runs it after build and before `pnpm pack`, making export resolution, declaration targets, and published-file selection part of every push and pull-request check.

`test:coverage` runs the complete Vitest suite with V8 coverage restricted to `src/**/*.ts`. CI uses this command and enforces global minimums of 75% statements, 60% branches, 80% functions, and 80% lines. These floors start below the measured baseline so a small platform-specific difference does not make them aspirational, while any material regression fails the build.

## Alternatives considered

**Keep the package-local brand helper.** Rejected because it duplicates an official zero-runtime type primitive and makes the public declarations structurally different from DSH conventions.

**Make `dsh-brand` a bundled runtime dependency.** Rejected because the import is type-only and DSH packages use a peer dependency to share the nominal type declaration with consumers.

**Treat successful `pnpm pack` as sufficient.** Rejected because packing proves that an archive can be written, not that each exported JavaScript and declaration path resolves correctly.

**Report coverage without thresholds.** Rejected because a report that CI never compares cannot prevent an untested regression. Per-file 100% remains a future target rather than a claim attached to the first standalone release.

## Verification

Typecheck and build consume the direct `dsh-brand` declaration. `pnpm run test:coverage` executes the real Chromium suite and checks production-source thresholds. `pnpm run lint:package` packs the candidate and checks its exports and types. The final release smoke installs the generated tarball into an empty temporary project and imports every public entry point under plain Node.

## Consequences

Published declarations use the same opaque-id primitive as the host, and package metadata or material coverage regressions fail CI before release. Plugin development gains explicit coverage and package-lint commands plus their development dependencies. Consumers must resolve the compatible `@deepseek-ai/dsh-brand` peer alongside the existing DSH peers; the package adds no runtime import for branding. Global coverage floors prevent backsliding but do not imply that each file or failure path is complete.
