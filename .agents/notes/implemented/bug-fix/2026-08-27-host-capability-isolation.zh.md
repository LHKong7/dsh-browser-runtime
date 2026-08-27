# Agent Note: 拒绝宿主 permission 与 external protocol handler

Status: implemented

[English](2026-08-27-host-capability-isolation.md) | 中文

## Problem

Browser page 可以请求 geolocation、notification、media device、clipboard access 和其他由宿主支持的 permission。它也可以导航到 `mailto:`、`tel:`、`file:` 或 custom protocol，而浏览器处理这些 protocol 时可能涉及宿主 UI 或另一个应用。依赖 headless Chromium 默认行为会使结果随平台变化，也会让请求 Provider API 以外 capability 的 click 看起来成功。

## Decision

每个 BrowserContext 都以空的 global permission grant 启动。Playwright 会把它映射到 Chromium 的 context-scoped permission override：不授予任何 permission，并拒绝其他全部 permission type。Chromium 还会以 `--deny-permission-prompts` 启动，因此不支持的 permission type 不能回退到宿主 UI。由 permission 控制的 API 会报告 `denied`。页面仍负责展示该结果：请求 permission 的 click 是普通 page action，而不是 Provider policy failure。

每个 interactive-element snapshot 都会解析 anchor 与 submit control 的有效 URL。HTTP(S)、`javascript:`、`blob:`、`data:` 和 `about:` 仍是浏览器内部 navigation protocol。其他 protocol 都会作为 external-protocol attempt 写入 element fingerprint。匹配的 click 会在 dispatch 前返回 `BROWSER_POLICY_DENIED`，改变 protocol classification 的 mutation 会被视为 stale。

Context init script 会把相同 classification 应用于 anchor `click()`、click 和 submit activation，以及直接 `form.submit()`。它会阻止浏览器操作，并通过随机的 environment 专属 binding 报告 attempt。Chromium control session 会监听 renderer-requested navigation，并为 external protocol 发送 `Page.stopLoading`，从而覆盖直接 location assignment 与其他绕过 DOM activation control 的 navigation 路径。

## Operation settlement

External-protocol binding 与 Chromium listener 会递增同一个 environment revision。Action 会在 dispatch 前记录该 revision，完成一次浏览器协议往返，排空被跟踪的 stop command，并在 revision 改变时返回 `BROWSER_POLICY_DENIED`。Stop-command failure 会作为 policy failure 的一部分保留。在触发 action 返回后才调度的 external navigation 仍会作为 environment-owned background work 被停止，但不会追溯归因到已完成的 action。

## Alternatives considered

**依赖 headless Chromium 抑制 prompt 与外部应用。** 不采用，因为 headless 与 headful 行为、操作系统 handler 和浏览器默认值都不是稳定的 Provider policy。

**暴露可配置的 permission grant。** v0.1 不采用，因为 geolocation value、media-device selection、clipboard ownership、user approval 与 evidence 需要显式 capability API。通用字符串列表会在未定义这些约定的情况下授予宿主 access。

**依赖 Playwright request route 处理 external protocol。** 不采用，因为 external protocol 不一定会变成 HTTP request。Element preflight、DOM activation control 与 Chromium navigation event 会覆盖选择宿主 handler 前的时间点。

**拒绝全部非 HTTP(S) URL。** 不采用，因为 `javascript:`、`blob:`、`data:` 和 `about:` 始终位于已经执行的 browser page 内，不会选择宿主 protocol handler。这些路径产生的 download 与 popup 仍受各自独立 control 约束。

## Verification

真实的受管理 Chromium 测试确认 geolocation、notification、camera、microphone、clipboard read 与 clipboard write 全部报告 `denied`；notification 与 geolocation request 会以 denial 完成且不出现 prompt。其他测试确认 observation 中的 `mailto:` link 与 custom-protocol form 会在 dispatch 前被拒绝，脚本创建的 `tel:` anchor 与直接 `form.submit()` 会通过 binding 被拒绝，`location.href` assignment 会通过 Chromium control 被拒绝。每条拒绝路径结束后，primary Page URL 与 observation 仍然可用。

## Consequences

需要 location、notification、camera、microphone、clipboard、MIDI、sensor、local font 或其他 browser permission 的站点无法在 v0.1 完成对应 workflow。站点仍可渲染自己的 denial state，Agent 也可以 observation 该状态。

Page script 可以观察到被 override 的 anchor 与 form activation 行为。HTTP(S) navigation 以及浏览器内部的 `javascript:`、`blob:`、`data:` 和 `about:` navigation 仍然可用，并继续受 network、download 与 single-page control 约束。

这属于应用层 browser control，而不是操作系统 sandbox。当部署策略需要针对 browser 或 Chromium 缺陷建立独立 barrier 时，仍然需要 host sandbox。
