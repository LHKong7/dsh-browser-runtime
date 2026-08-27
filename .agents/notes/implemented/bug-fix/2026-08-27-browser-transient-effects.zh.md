# Agent Note: 将 dialog、file chooser 与 download 约束到 Playwright action

Status: implemented

[English](2026-08-27-browser-transient-effects.md) | 中文

## Problem

Browser dialog、file chooser 和 download 可以在 Playwright action 中开始，却不会出现在其 page observation 中。以 fire-and-forget 方式 dismiss 或 cancel 会让 action 在浏览器 effect 及其 cleanup settle 前返回成功。关闭 Playwright download access 也不能证明网络 transfer 已停止。这些行为会使 action outcome、资源 ownership 以及 Provider 声明的不支持 upload 与 download capability 互相矛盾。

## Decision

Provider 会自动 dismiss 每个 page dialog，并跟踪其 dismissal promise。Dismiss 失败时会关闭发起 dialog 的 Page，避免 modal dialog 持续阻塞页面 event loop。Action 或 teardown 会同时保留 dismissal 与 page-close failure。因此 confirm 结果为 `false`，prompt 结果为 `null`，而 Provider 不暴露接受 dialog 或输入 prompt 的操作。

Observation 中的文件输入会在 click 或 fill dispatch 前被拒绝。Context init script 会替换文件输入的 `click()` 和 `showPicker()`，捕获文件输入及其关联 label 的 click activation，通过随机的 environment 专属 binding 报告 attempt，并阻止 native chooser activation。Playwright FileChooser event 仍作为兜底，以空 file list 清空 input。发起 action 会返回 `BROWSER_POLICY_DENIED`；宿主机路径和文件 payload 都不会进入页面。

Observation 中带 `download` attribute 的 anchor 会以 download 身份写入 fingerprint，并在 dispatch 前被拒绝。对于由 response 决定的 download，每个 Page navigation request 都会被跟踪到 response header settle。带 attachment content disposition 的导航 response 会递增 download-policy revision，并通过 Chromium control session 发送 `Page.stopLoading`。Blob、data 和其他到达 Playwright Download event 的路径会被取消。Provider 会在内部启用 Playwright download ownership，以便取消这些 artifact；Provider API 绝不会暴露其路径，而 BrowserContext close 会删除 partial artifact。

## Operation settlement

Action 会先排空旧 navigation、dialog、file-chooser、download 和 unexpected-Page 工作，再记录 policy revision。Dispatch 后会完成一次浏览器协议往返，并再次排空相同工作。即使 Playwright 同时报告通用 click 或 navigation failure，只要出现新的 Page、file chooser 或 download revision，action 就会被归类为 `BROWSER_POLICY_DENIED`。Cleanup failure 会与 policy 或 action failure 合并，而不会取代它或被丢弃。

如果 navigation request 在 `navigationTimeoutMs` 前没有产生 response，Provider 会关闭 primary Page 并报告 cleanup failure，避免无界 response wait 存活到操作结束以后。在 action 完全返回后才被调度的 effect 仍会作为 environment-owned background work 被停止或清空，但不会追溯归因到已完成的 action。

## Alternatives considered

**设置 `acceptDownloads: false` 并依赖 Playwright 默认行为。** 不采用，因为这会拒绝 artifact access，却不能可靠终止 active response，也不能把被拒绝的 download 归因到对应 action。

**只使用 dialog、FileChooser 与 Download event listener。** 不采用，因为 browser event 可能在 click completion 和 after-state observation 以后才到达。Dispatch 前 metadata、init control、response settlement 与 event fallback 分别覆盖不同时间点。

**在 v0.1 中暴露 upload 与 download path。** 不采用，因为 host-path selection、file authorization、artifact persistence、evidence rendering 与 secret handling 需要显式 capability，而不能依赖偶然取得的 Playwright access。

**每次出现不支持的 effect 都关闭 BrowserContext。** 不采用，因为可以在保留 primary Page 的情况下 dismiss dialog、阻止或清空 chooser，并停止 transfer。只有无法建立有界 settlement 时，Provider 才关闭 Page。

## Verification

真实 Chromium 集成测试证明：alert、confirm 和 prompt dismissal 会在 after-state evidence 前完成；直接及脚本触发的 file chooser 会以空 file list 返回 `BROWSER_POLICY_DENIED`；declared download 不发送 request；blob download 会被取消；attachment response 停止后不会留下 active response；background attachment 会被停止，而 primary Page 仍可 observation。完整 Provider suite 还会通过组装后的 Runtime 覆盖普通 navigation、click、WebSocket、cancellation、checkpoint、strict proxy 与 single-page 行为。Node V8 coverage 只排除序列化进 Chromium 的函数，因为 host isolate 无法观察其执行；这些真实浏览器测试负责验证其行为。

## Consequences

页面可以观察到文件输入的 `click()` 和 `showPicker()` 会直接返回且不打开 chooser，就像它们可以观察到被阻止的 `window.open`。Upload、accepted-dialog 与 prompt-input workflow 在 Provider 暴露对应显式 capability 前均不可用。

Server 只有在收到 navigation request 后才能决定 response-defined download。因此在 Chromium 报告 attachment header 且 Provider 停止 loading 前，server 可能已经观察到 request 和初始 response bytes。Declarative download 和 observation 中的文件输入不会产生这种网络副作用。

被取消的 Playwright artifact 在 BrowserContext close 执行删除前始终由 Provider 持有。Model tool 与 caller API 无法取得它们，并且 cancellation 会在关联 action 返回前 settle。
