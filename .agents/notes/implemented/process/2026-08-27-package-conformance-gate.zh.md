# Agent Note: 为发布包约定建立门禁

Status: implemented

[English](2026-08-27-package-conformance-gate.md) | 中文

## Problem

即使 `exports` 不一致、声明目标缺失或 `files` 列表不完整，这个包仍可能成功构建并生成 tarball。它的公开 opaque id 还使用私有 `__brand` helper，而不是 DeepSeek Harness 共享的 `Branded<B>` primitive，导致声明约定与其集成的宿主包不同。测试没有覆盖率下限，因此通过的测试套件可能在 CI 没有信号的情况下失去对生产路径的覆盖。

## Decision

每个 opaque browser id 都使用 `@deepseek-ai/dsh-brand` 的 `Branded<B>`。该包把 brand primitive 声明为对等依赖（peer dependency），使声明使用宿主的 DSH 类型身份；同时把它声明为开发依赖，让本地类型检查可以独立运行。

`lint:package` 脚本针对构建后的包运行 publint。CI 在 build 之后、`pnpm pack` 之前执行该脚本，使 export 解析、声明目标和发布文件选择成为每次 push 与 Pull Request 检查的一部分。

`test:coverage` 使用 V8 coverage 运行完整 Vitest 套件，并只统计 `src/**/*.ts`。CI 使用该命令，同时执行全局下限：statements 75%、branches 60%、functions 80%、lines 80%。这些下限低于实测 baseline，避免较小的平台差异使门禁停留在目标状态，同时任何实质性回退都会使 build 失败。

## Alternatives considered

**保留包内 brand helper。** 不采用，因为它重复了官方零运行时类型 primitive，并使公开声明在结构上偏离 DSH 约定。

**把 `dsh-brand` 作为打包的运行时依赖。** 不采用，因为该 import 只用于类型，且 DSH 包通过对等依赖与消费方共享 nominal type 声明。

**把成功执行 `pnpm pack` 视为充分验证。** 不采用，因为 pack 只能证明能够写出 archive，不能证明每个导出的 JavaScript 和声明路径都能正确解析。

**只报告 coverage，不设置 threshold。** 不采用，因为 CI 从不比较的报告无法阻止未测试回退。Per-file 100% 仍是未来目标，而不是第一个 standalone release 已经满足的声明。

## Verification

类型检查和 build 会使用直接声明的 `dsh-brand`。`pnpm run test:coverage` 会执行真实 Chromium 套件并检查生产源码 threshold。`pnpm run lint:package` 会打包候选产物并检查 exports 与 types。最终发布冒烟测试把生成的 tarball 安装到空的临时项目，并在 plain Node 下导入每个公开入口。

## Consequences

发布声明使用与宿主相同的 opaque-id primitive，包元数据缺陷或实质覆盖率回退会在发布前使 CI 失败。插件开发增加明确的 coverage 与 package-lint 命令及其开发依赖。消费方必须在已有 DSH 对等依赖旁解析兼容的 `@deepseek-ai/dsh-brand` peer；该包不会为 branding 增加运行时 import。全局 coverage 下限可以防止回退，但不表示每个文件或失败路径都已经完整覆盖。
