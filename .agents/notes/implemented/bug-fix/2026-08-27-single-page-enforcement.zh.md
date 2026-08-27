# Agent Note: 执行 Playwright 单页面能力

Status: implemented

[English](2026-08-27-single-page-enforcement.md) | 中文

## Problem

Playwright Provider 声明 `multiplePages: false`，但页面仍可通过 link 或 form target、`window.open` 或其他浏览器机制请求新的 browsing context。只触发新 Page 的关闭而不等待它，无法维持声明的 capability：action 可能被记录为成功，cleanup failure 会丢失，未受管理的 Page 也可能存活到操作结束以后。

## Decision

Provider 拥有一个 primary Page，并把创建另一个 browsing context 视为 browser policy denial。每个 element snapshot 与 fingerprint 都会记录其有效 link 或 form target 是否会创建新 context。指向 self、parent、top 的保留 target 与已有 named frame 仍然有效；`_blank` 和没有对应已有 frame 的名称会在 click dispatch 前被拒绝。Observation 后让该结果发生变化的 target mutation 会被视为 stale。

BrowserContext 会在创建 primary Page 前安装脚本。该脚本把 `window.open` 替换为一个函数：通过 environment 专属的随机 binding 报告 attempt，然后返回 `null`，与浏览器阻止 popup 时的结果一致。Action 会在 dispatch 后完成一次浏览器协议往返、读取 binding revision，并在不创建 Page 或发送其导航 request 的情况下返回 `BROWSER_POLICY_DENIED`。

Context-level Page event 仍是上述两种控制之外创建路径的兜底。它会立即开始关闭 Page，并跟踪每个关闭 promise。Action 会在 dispatch 前排空旧关闭操作，在 dispatch 后排空新关闭操作；environment teardown 也会排空它们。Close failure 会被保留，并与 action 或 policy failure 合并，而不是被丢弃。

## Alternatives considered

**只把 `multiplePages: false` 当作描述性 metadata。** 不采用，因为 capability negotiation 必须描述 Provider 实际执行的行为。

**异步关闭额外 Page，并继续把 action 记为成功。** 不采用，因为 Agent 会为无法观察或继续的效果收到成功结果，同时 cleanup failure 与资源 ownership 仍不确定。

**用 popup 替换 primary Page。** 不采用，因为 popup handoff 会改变 page identity、navigation evidence 和 checkpoint 行为。它应属于未来的 multiple-page 或显式 handoff capability。

**拒绝全部 link 或 form target。** 不采用，因为 `_self`、`_parent`、`_top`、`_unfencedTop` 和已有 named frame 仍位于受管理的 Page 内。

## Verification

真实 Chromium 集成测试会点击 observation 中的 `_blank` link，以及 handler 调用 `window.open` 的 button。两个 action 都返回 `BROWSER_POLICY_DENIED`；popup endpoint 不会收到 request，不会留下 active popup response，primary Page 仍可 observation。第三个 fixture 会在 action 完成后调度 detached `_blank` link；其初始 request 会到达 fixture，context fallback 会排空 active response，primary Page 仍可 observation。普通 click、navigation、WebSocket、cancellation、checkpoint 与 strict-proxy 测试继续通过组装后的 Runtime 执行。

## Consequences

v0.1 无法使用依赖 popup 的 authentication、payment 与 document workflow，即使浏览器通常会允许它们。`window.open` 会以可被 feature detection 观察到的方式被阻止，并返回 `null`。解析到已有 frame 的 target 仍然可用。

Fallback Page event 保证 cleanup ownership，但不保证零初始网络活动：Playwright 报告 Page 前，未知的浏览器创建路径可能已经开始第一个 request。Strict mode 仍会对该 request 应用 destination proxy。显式 private-network mode 可能在 fallback 关闭 Page 前接触已经准入的目标。
