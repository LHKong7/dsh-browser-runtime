# Agent Note: 让插件约定穿过 Loader.unwrapExports

Status: implemented

[English](2026-08-27-loader-export-conformance.md) | 中文

## Problem

两个函数式插件入口同时发布了具名约定和默认导出：

```ts
export const name = 'browser-playwright'
export const inject = ['browserRuntime']
export const Config = /* schema */
export function apply(ctx, config) { /* … */ }
export default apply
```

DSH Loader 用 `exports.default ?? exports` 解析导入的模块，因此它只拿到裸的 `apply` 函数，丢弃了 `inject`、`Config` 和 `name`。Provider 随后在没有声明服务依赖的情况下运行，并在 `ctx.browserRuntime` 处以 `cannot get property "browserRuntime" without inject` 失败；Tools 插件也失去了配置 schema 和另外三项注入。仓库里没有任何测试执行过 Loader，所以通过的测试套件、成功的构建和干净的 `publint` 都在为一个无法挂载的包背书。

在已发布的 `0.1.1` 上重新发布修复会让问题叠加：pnpm 把同版本、同路径的 tarball 当作它已经解析过的那个包，因此修好的源码仍然产生旧的运行时行为。

## Decision

函数式插件入口只使用具名导出。默认导出只保留给把 `inject` 和 `Config` 作为静态属性携带的 Service 或 class 插件，因为 Cordis 直接接受构造函数并从中读取这些静态属性。`dsh-browser-runtime` 依据该规则保留 `export { BrowserRuntime as default }`；`dsh-browser-runtime/playwright` 和 `dsh-browser-runtime/tools` 在任何层级都没有默认导出，包括入口再导出的实现模块。

`tests/loader-conformance.spec.ts` 对真实入口命名空间运行来自 `@deepseek-ai/cordis-plugin-loader` 的真实 `Loader.prototype.unwrapExports`，断言存活下来的约定，然后用真实的 `dsh-tools`、`dsh-system-prompt` 和一个 attachment store，把三个解包后的插件挂载到真实 Cordis Context 中。一旦默认导出回归，该套件就会以原始的 `without inject` 错误失败。

`scripts/verify-package.mjs` 针对构建产物而非源码重复该门禁：解析每个 `exports` 子路径、通过读取生成的 JavaScript 拒绝函数式入口中的默认导出、解包并挂载每个入口、检查声明目标、bundle patch 和 CLI 是否真的随包发布，并输出包版本、源码提交以及入口的 SHA-256 摘要。`scripts/pack-check.mjs` 会打包、解压，并针对解压后的 tarball 运行该门禁和 `doctor`。两者都在 CI 的 `build` 与 `lint:package` 之后运行。

修复以 `0.1.2` 发布。构建产物的每次变化都要升级版本。

## Alternatives considered

**保留默认导出并添加 `apply.inject`。** 已否决，因为函数属性能否存活取决于形态的巧合，Config schema 仍然没有 Cordis 会读取的位置，而且这条规则对后来的贡献者不可见。

**只用手写的 unwrap helper 断言导出形态。** 已否决，因为那只是把包钉在它自己的假设上。CLI 确实携带一份有文档说明的副本，供 loader 包未安装的场景使用，并且 `tests/cli-diagnostics.spec.ts` 在本包可能产生的每种模块形态上把它与真实实现做对比。

**只检查源码树。** 已否决，因为观察到的故障发生在已安装的产物中。`files` 遗漏、过期的 `lib/`，或重新引入默认导出的构建，在 tarball 本身被解包并挂载之前都不可见。

**在 `0.1.1` 上重新发布。** 已否决，因为那正是已经观察到的失败模式：pnpm 解析到缓存的包，修好的源码从未到达 profile。

## Verification

`tests/loader-conformance.spec.ts` 在修正后的入口上通过，并在恢复默认导出时复现原始挂载失败。`pnpm run verify:package` 挂载构建树；`pnpm run verify:tarball` 打包、解压、挂载并对归档运行 `doctor`，报告 `browser-runtime, browser-playwright, tool-browser mounted`、已注册的 provider、已注册的工具以及完整性摘要。

## Consequences

三个入口可以从已安装的 profile 挂载，重新引入的默认导出会在源码和产物两个层级让 CI 失败。新增入口的贡献者必须遵循具名导出规则，并把它登记到 `scripts/verify-package.mjs` 的 `ENTRIES` 和 `src/cli/diagnostics.ts` 的 `ENTRY_POINTS` 中。本包新增 `@deepseek-ai/cordis-plugin-loader` 开发依赖，使门禁使用真实 Loader 而不是对它的描述。
