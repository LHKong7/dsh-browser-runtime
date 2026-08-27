# Agent Note: 保留 routed request 的失败身份

Status: implemented

[English](2026-08-27-route-policy-error-classification.md) | 中文

## Problem

Playwright route handler 在同一个代码块中捕获网络策略检查和 `route.continue()`。因此，context 关闭或其他 request transport 失败会被记录成被阻止 URL；即使策略允许该请求，当前导航也可能返回 `BROWSER_POLICY_DENIED`。单一 blocked-URL slot 还会接受子资源拒绝，却只在显式 `navigate` 操作中读取，因此图片请求可能覆盖失败证据，而 `click` 发起的 policy 拒绝导航没有相同的稳定错误。

## Decision

`routeWithNetworkPolicy()` 只捕获 request admission 抛出的 `BrowserProviderPolicyError`。它在中止 route 前同步报告拒绝；`route.continue()` 和 `route.abort()` 在 catch 外执行，并保留各自的 Playwright 失败。

Playwright environment 对每个 routed request 应用该检查，但只保留其主页面 frame 上的导航拒绝。每次操作都会清除旧的拒绝状态。显式导航和点击触发的导航都会把保留的拒绝返回为 `BROWSER_POLICY_DENIED`；被拒绝的子资源会中止，但不会替换操作结果。

## Alternatives considered

**捕获完整 route handler，并根据任意 rejection 推断 policy 拒绝。** 不采用，因为 request transport 和 context 生命周期失败不是策略决策，需要进入普通的 `BROWSER_ACTION_FAILED` 路径。

**不区分资源类型，保留最后一个被拒绝的 request。** 不采用，因为被阻止的图片、脚本或 frame 不能替换主操作的失败身份。

**只检查模型提供的导航 URL。** 不采用，因为 redirect、页面脚本和子资源可以访问原始工具参数中不存在的目标。

## Verification

网络策略单元测试要求被拒绝的 route 中止且不继续，然后注入 `route.continue()` 和 `route.abort()` 失败，并要求每个错误对象原样返回。continue 失败不会触发拒绝 callback；abort 失败会保留 admission 拒绝 callback，但不会替换其 transport 错误。真实 Chromium 测试点击主文档 URL 含内嵌凭据的链接，并要求 Runtime 返回 `BROWSER_POLICY_DENIED`。

## Consequences

显式导航和页面发起的主导航都会用 policy 错误标识真实的策略决策。子资源请求仍受策略约束，但单个资源被阻止不会让整个操作失败。Playwright route 失败会作为 Provider 失败暴露，而不是虚假的安全拒绝。[浏览器出站策略](2026-08-27-browser-egress-policy.zh.md)负责 DNS 固定和 request route 之外的 transport。
