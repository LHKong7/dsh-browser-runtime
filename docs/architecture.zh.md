# 架构

[English](architecture.md) | 中文

本文定义 v0.1 的所有权、生命周期、并发、证据、持久化和 Provider 义务。

## 角色

```text
Agent / tool / workflow
        │ acquire(owner, sessionId, policy)
        ▼
BrowserRuntime (ctx.browserRuntime)
  Provider registry · lease · FIFO · ref · evidence · checkpoint index
        │ open / restore / observe / act / screenshot / checkpoint / close
        ▼
BrowserProvider
        │
        └── PlaywrightBrowserProvider → 隔离 Chromium BrowserContext + 单个 Page
```

Runtime 是 environment identity 和 lease 的唯一公共 owner。Consumer 无法取得 Playwright 对象、Provider target、CSS selector 或文件系统路径。

## Acquire 与所有权

`BrowserRuntime.acquire()` 要求精确 `owner` 对象、持久 `BrowserSessionId`、persistence policy，以及可选的 Provider 和 capability 条件。Runtime 使用对象身份而不是字符串 owner id 作为进程内共享键。

同一 owner 的并发 acquire 为 single-flight。兼容调用获得同一环境上的独立 lease；session、persistence 或 Provider 设置不兼容时返回 `BROWSER_OWNER_CONFLICT`。每个 lease 只能释放一次。最后一个 lease 释放后，Runtime 停止接收新操作，中止并排空已接收操作，根据 policy 执行 checkpoint，最后关闭 Provider environment。

Provider registration 是 effect。它的 disposer 先从选择集合移除 Provider，再关闭由它创建的全部 environment，最后调用 Provider 级 `dispose()`。Runtime dispose 也会排空环境。清理会分别尝试 checkpoint 和 close；两者都失败时通过 `AggregateError` 报告。

## Observation 与 Action

Provider observation 包含页面字段和 opaque target。Runtime 分配 environment、generation、page、observation、revision、digest 与局部 element identity，并且只保存最新 observation 的 Provider target。

`click` 和 `fill` 必须指定最新 observation 及其中一个 ref。旧 observation 会在调用 Provider 前被拒绝。Provider 在 action 前重新解析 opaque target 并核对 fingerprint，从而覆盖两次 Runtime observation 之间发生的页面变化。`fill` 会拒绝 observation 中标记为 `input[type=password]` 的目标。

同一 environment 的全部操作进入一个 FIFO；不同 environment 各自拥有 FIFO。Browser tools 不声明 concurrency safety，因此 DSH scheduler 也会把模型可见调用作为 exclusive 操作处理。

每个已接收 action 生成一个 `BrowserTransition`。成功 transition 含 before 和 after observation；Provider 失败记为 `failed`；action 已完成但无法得到 after-state 证据时记为 `unknown`，并抛出 `BROWSER_ACTION_EVIDENCE_FAILED`。Runtime 证据只记录 fill 长度和 `[REDACTED]`，不记录原值。

## 持久化与证据

Runtime 在内存中保存 checkpoint 与 transition 元数据。`ctx.storageDomain` 挂载后，Runtime 打开 `browser_runtime` domain，并写入 `checkpoints` 与紧凑 `transitions` 表。紧凑 transition 保留 id、URL/digest/revision 证据、隐藏值后的 action、时间、outcome 和 failure，不保存页面正文或 Provider target。

Provider checkpoint payload 由 Provider 私有管理。Playwright 在 owner-only 目录中以 `0600` 权限写入随机名称 JSON 文件，只向 Runtime 返回文件名 ref。Payload 包含 cookie 和 localStorage。`BrowserRuntime` 禁止使用另一个 Provider 恢复该 checkpoint。

截图走独立路径：Runtime 向工具 Consumer 返回 PNG bytes，Consumer 调用 `ctx.attachments.saveImage`。Tool result 携带持久 attachment ref 和 image render block；模型参数与输出均不包含宿主机路径。

插件不写自定义 Session event type。DSH 现有 `tool/call` 和 `tool/result` 事件记录模型可见的调用和结果；`tool/result` content 携带 observation、transition id 和 attachment ref。

## Provider 义务

Provider 需要唯一 branded id、真实 capability flag、`available()` 和 `open()`。支持 checkpoint 的 Provider 还要实现 `restore()`，其 environment 要实现 `checkpoint()`。`destroyCheckpoint()` 和 Provider 级 `dispose()` 可选。

`open()` 与 `restore()` 在 fulfill 前始终拥有部分创建的资源；reject 后不能留下进程、context、page、profile 目录或其他资源。Fulfill 后由 `BrowserRuntime` 拥有 `BrowserProviderEnvironment.close()`，Runtime 可以在取消后或重复调用 close，因此 close 必须幂等。

Provider 方法接收明确的 `AbortSignal`。取消后不能在未被管理的工作仍继续时提前返回。Playwright Provider 会在 abort 时关闭 BrowserContext，等待 Playwright 操作和 close 路径 settle，并把 environment 留在不可用状态。

Provider observation 必须有界，不包含隐藏值、密码值或原始 HTML，并保持 action target opaque。Target fingerprint 改变时抛出 `BrowserProviderTargetStaleError`，policy 拒绝操作时抛出 `BrowserProviderPolicyError`。

## 扩展 Provider registry

实现 `BrowserProvider`，再从注入 Runtime 的 Cordis plugin 注册：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserProvider } from 'dsh-browser-runtime'

export const inject = ['browserRuntime']

export function apply(ctx: Context, provider: BrowserProvider): void {
  ctx.browserRuntime.registerProvider(provider)
}
```

Runtime 会拒绝重复 id、缺失或不可用的指定 Provider、零个可用 Provider、有歧义的自动选择，以及不满足的 capability。注册顺序不会决定 Provider。
