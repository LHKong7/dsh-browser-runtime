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

同一 owner 的并发 acquire 为 single-flight。owner slot 持有 Provider 初始化的取消信号；每个调用方用自己的信号等待共享结果，但不能取消其他等待方。兼容调用获得同一环境上的独立 lease；session、persistence 或 Provider 设置不兼容时返回 `BROWSER_OWNER_CONFLICT`。没有调用方或 lease 时，slot 会中止尚未完成的初始化。每个 lease 只能释放一次。最后一个 lease 释放后，Runtime 停止接收新操作，中止并排空已接收操作，根据 policy 执行 checkpoint，最后关闭 Provider environment。

工具 Consumer 在 Agent 范围使用同一所有权规则。Agent binding 持有 lease 初始化；每个工具调用只能取消自己对该 lease 的等待。如果取消发生在初始化完成后的操作中，binding 会等待释放可能已不可用的 lease；下一次工具调用会取得新环境。Agent 销毁会中止尚未完成的初始化、等待失效 lease 清理，并释放已经建立的 lease。

Provider registration 是 effect。`available()` 尚未返回时，选择流程仍归属当前候选 registration；自动选择只会基于稳定的 registry 快照作出决定。Registration disposer 会先从选择集合移除 Provider，中止并等待选择与初始化，关闭由它创建的全部 environment，最后调用 Provider 级 `dispose()`。Runtime dispose 也会排空环境。清理会分别尝试 checkpoint 和 close；两者都失败时通过 `AggregateError` 报告。

## Observation 与 Action

Provider observation 包含页面字段和 opaque target。Runtime 分配 environment、generation、page、observation、revision、digest 与局部 element identity，并且只保存最新 observation 的 Provider target。

`click` 和 `fill` 必须指定最新 observation 及其中一个 ref。旧 observation 会在调用 Provider 前被拒绝。Provider 在 action 前重新解析 opaque target 并核对 fingerprint，从而覆盖两次 Runtime observation 之间发生的页面变化。`fill` 会拒绝 observation 中标记为 `input[type=password]` 的目标。

同一 environment 的全部操作进入一个 FIFO；不同 environment 各自拥有 FIFO。Browser tools 不声明 concurrency safety，因此 DSH scheduler 也会把模型可见调用作为 exclusive 操作处理。

每个已接收 action 生成一个 `BrowserTransition`。成功 transition 含 before 和 after observation；Provider 失败记为 `failed`；action 已完成但无法得到 after-state 证据时记为 `unknown`，并抛出 `BROWSER_ACTION_EVIDENCE_FAILED`。Runtime 证据只记录 fill 长度和 `[REDACTED]`，不记录原值。

## 持久化与证据

Runtime 在内存中保存 checkpoint 与 transition 元数据。`ctx.storageDomain` 挂载后，Runtime 打开 `browser_runtime` domain，并写入 `checkpoints` 与紧凑 `transitions` 表。Checkpoint 表是跨进程恢复的必需索引。Transition 表只是辅助查询索引：写入失败会记录一条运维警告，但不会改变 action 成功、Provider 失败或调用方取消的结果。`listTransitions()` 会按 transition id 合并持久数据与有界内存记录，因此当前进程的查询仍能返回被紧凑索引拒绝的记录。紧凑 transition 保留 id、URL/digest/revision 证据、隐藏值后的 action、时间、outcome 和 failure，不保存页面正文或 Provider target。

Provider checkpoint payload 由 Provider 私有管理。Playwright 在 owner-only 目录中以 `0600` 权限写入随机名称 JSON 文件，只向 Runtime 返回文件名 ref。Payload 包含 cookie 和 localStorage。`BrowserRuntime` 禁止通过另一个 Provider 恢复或替换 checkpoint；替换会在创建另一个 payload 之前被拒绝。Payload 创建、元数据提交或回滚以及旧 payload 清理会按 session id 跨 owner environment 串行执行。已取消的排队 checkpoint 会保留其顺序位置，直到前一个事务结束，因此后续工作无法超越它。创建 checkpoint 时先生成 Provider payload，再提交元数据；元数据失败会返回 `BROWSER_CHECKPOINT_METADATA_FAILED` 并回滚新 payload。替换 checkpoint 会等待旧 payload 的尽力删除完成。显式删除会先移除持久元数据，再删除 payload，因此元数据失败不会留下指向缺失 Provider 状态的索引。

截图走独立路径：Runtime 向工具 Consumer 返回 PNG bytes，Consumer 调用 `ctx.attachments.saveImage`。Tool result 携带持久 attachment ref 和 image render block；模型参数与输出均不包含宿主机路径。

插件不写自定义 Session event type。DSH 现有 `tool/call` 和 `tool/result` 事件记录模型可见的调用和结果；`tool/result` content 携带 observation、transition id 和 attachment ref。

## Provider 义务

Provider 需要唯一 branded id、真实 capability flag、`available()` 和 `open()`。支持 checkpoint 的 Provider 必须实现 `restore()` 和 `destroyCheckpoint()`，而且它返回的每个 environment 都必须实现 `checkpoint()`。Runtime 会在注册时拒绝缺失的 Provider 方法；新打开的 environment 缺少 `checkpoint()` 时，Runtime 会关闭并拒绝它。Provider 级 `dispose()` 仍为可选。

`open()` 与 `restore()` 在 fulfill 前始终拥有部分创建的资源；reject 后不能留下进程、context、page、profile 目录或其他资源。Fulfill 后由 `BrowserRuntime` 拥有 `BrowserProviderEnvironment.close()`，Runtime 可以在取消后或重复调用 close，因此 close 必须幂等。

Provider 方法接收明确的 `AbortSignal`。取消后不能在未被管理的工作仍继续时提前返回。Playwright Provider 会在 abort 时关闭 BrowserContext，等待 Playwright 操作和 close 路径 settle，并把 environment 留在不可用状态。

Provider observation 必须有界，不包含隐藏值、密码值或原始 HTML，并保持 action target opaque。Target fingerprint 改变时抛出 `BrowserProviderTargetStaleError`；policy 拒绝时抛出 `BrowserProviderPolicyError`。

Playwright Provider 会在 Chromium 内截断正文，然后才传输。截图超过配置的 device-pixel 或 encoded-byte 预算时以 `BROWSER_POLICY_DENIED` 失败；byte 检查发生在 PNG encoding 之后。

每个 strict Playwright environment 都拥有一个绑定到临时 IPv4 loopback 端口的认证 HTTP proxy。HTTP(S)、`ws:`/`wss:` 和经代理的浏览器 TCP 都会经过该 proxy。安装页面 route 前，临时页面会加载由 proxy 自己返回的空文档，在不接触 upstream server 的情况下建立 Chromium authentication cache。Proxy 验证凭据与目标策略，只解析一次 hostname，只使用已验证地址打开 socket，并通过一次性 Agent 把每个转发 HTTP request 绑定到该 socket。Proxy shutdown 会停止 admission 并销毁其 socket，然后才清理 BrowserContext 与 browser；pending DNS resolution 无法在 proxy close 或已经观察到 client abort 后创建连接。Strict mode 还会禁用 Chromium QUIC 和未经过代理的 WebRTC UDP。`allowPrivateNetwork` 不会启动 proxy，也不会加入这两个启动限制，因此允许浏览器直接连接，同时 request route 与 WebSocket route 仍保留协议与内嵌凭据检查。Provider 只使用固定 Playwright 版本管理的 Chromium。

Playwright request route 与 WebSocket route 会保留操作的失败身份，并在浏览器正常处理前拒绝不允许的连接。被拒绝的主文档导航会保留给当前 `navigate` 或 `click` 操作，并以 `BROWSER_POLICY_DENIED` 返回；被拒绝的子资源会中止，但不会替换操作结果。被拒绝的 WebSocket 会在 `connectToServer()` 前以策略代码 `1008` 关闭，并且不会归因于无关的当前操作。`route.continue()`、`route.abort()` 或 WebSocket route close 的失败仍属于 Playwright 失败，绝不会被归类为 policy 拒绝。在 strict mode 中，proxy 会在创建 socket 时重复执行策略准入，并固定其 DNS 结果。

Playwright Provider 声明 `multiplePages: false`，并保留一个 primary Page。Element fingerprint 包含有效 link 或 form target 是否指向新 browsing context，因此 observation 后让该结果发生变化的 mutation 会被视为 stale，匹配的 click 则会在 dispatch 前被拒绝。Context init script 会让 `window.open` 报告一次 attempt 并返回 `null`；action 会把该 attempt 识别为 `BROWSER_POLICY_DENIED`。Context 会立即关闭其他全部 Page，action 与 teardown 都会等待被跟踪的关闭操作。该兜底保证第二个 Page 不会存活，但不能证明未知创建路径在 Page event 前没有发送初始 request。

Provider 会 dismiss 每个 page dialog，并跟踪 dismiss 直到 action 或 teardown 完成。Dismiss 失败会关闭发起 dialog 的 Page，并作为操作 failure 的一部分保留。文件输入 snapshot 会在 dispatch 前被拒绝。Init script 还会通过 environment 专属 binding 阻止文件输入的 `click()`、`showPicker()`、click activation 和 label activation；Playwright FileChooser event 会清空绕过这些控制的路径。Action 会为 upload attempt 返回 `BROWSER_POLICY_DENIED`。

Anchor 的 `download` attribute 属于其 element fingerprint，并会触发 dispatch 前拒绝。Provider 会跟踪每次 Page navigation，直到 response header settle。Attachment disposition 会递增当前 download-policy revision，并通过 Chromium control session 发送 `Page.stopLoading`；如果 response 在 `navigationTimeoutMs` 前没有产生 header，primary Page 会被关闭。Blob、data 或其他路径产生的 Download event 会被取消。Action 会在判定成功前等待 navigation settle、response stop、download cancellation 和 unexpected-page closure；cleanup failure 会与 policy 或 action failure 一同保留。Partial download artifact 由 Playwright 持有，直至 BrowserContext close 将其删除，并且 artifact path 不会越过 Provider API。

BrowserContext 会以空的 global permission grant 启动，Chromium launch 也会拒绝 permission prompt。因此由 permission 控制的 API 会在不打开宿主 UI 的情况下收到 `denied`。请求 permission 的 click 仍是普通 page action，而不是 Provider policy operation；页面可见的 denial 会进入后续 observation。

Element fingerprint 会标记 external-protocol link 与 form target；只有 HTTP(S)、`javascript:`、`blob:`、`data:` 和 `about:` 属于浏览器内部路径。其他 protocol 会在 click dispatch 前失败。Init script 拦截 anchor 与 form activation 以及 `form.submit()`。`Page.frameRequestedNavigation` 捕获 `location.href` 等 renderer navigation，记录 policy revision，停止加载，并参与 action 或 teardown settlement。

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
