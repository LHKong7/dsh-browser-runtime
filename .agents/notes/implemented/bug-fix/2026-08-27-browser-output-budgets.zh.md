# Agent Note：限制浏览器 observation 与截图输出

状态：已实现

[English](2026-08-27-browser-output-budgets.md) | 中文

## 问题

页面可以暴露任意大的正文文本和任意大的 full-page 截图尺寸。如果在 Playwright 返回 `innerText` 后才应用 Runtime 文本限制，完整字符串仍会被传输并分配到 Node.js 中。没有 pixel 与 encoded-byte 限制的截图可能消耗 browser 内存、protocol 带宽、Node.js 内存、attachment storage，以及 render block 占用的模型上下文。

## 决策

Playwright 在 Chromium 内执行正文提取函数。该函数计算 `innerText`，只返回 Runtime `maxTextChars` 选定的前缀，并报告完整文本是否更长。完整字符串只作为 renderer 的瞬时状态存在，不跨越 Playwright protocol。Interactive metadata 仍由 `maxElements` 独立限制。

Playwright Provider 提供两个正整数配置限制：`maxScreenshotPixels` 默认为 16,000,000 device pixels，`maxScreenshotBytes` 默认为 16 MiB。无效配置会使 Provider 构造失败。

Capture 前，Provider 在 Chromium 中测量 viewport 或 document 尺寸以及 device scale factor。Device-pixel 乘积不安全或超过预算时，会在 encoding 前拒绝。允许的 full-page 请求会把测得的 document rectangle 固定为 clip，而不会让 Playwright 再次决定 full-page 尺寸，因此测量后的页面增长不能扩大本次 capture。PNG encoding 后，Provider 会在 byte buffer 进入 attachment storage 前拒绝超过 byte 预算的结果。两种拒绝都使用 `BrowserProviderPolicyError`；Runtime 对外返回 `BROWSER_POLICY_DENIED`。

## 考虑过的方案

**依赖 action timeout。** 未采用，因为大型结果可能在 timeout 内完成，同时已经分配大量内存。

**只在 Runtime 中限制。** 未采用，因为完整正文或 PNG 已经跨越 Provider interface 并进入 Node.js 内存。

**只使用 encoded-byte 限制。** 未采用，因为高度可压缩的图像可能具有很小的 PNG，却需要很大的 raster allocation。

**移除 full-page 截图。** 未采用，因为有界的 full-page 证据仍有价值，而且 Provider 可以固定 capture rectangle。

## 验证

真实受管理 Chromium 测试会导航到含 100,000 个正文字符的页面，并收到恰好 60,000 个字符的配置前缀以及 `truncated: true`。另一项真实浏览器测试验证：低于 pixel 限制、但高于一 byte PNG 限制的 viewport capture 会通过 byte 路径失败；高页面的 full-page capture 会通过 pixel 路径失败。已有允许截图测试验证 PNG signature。单元测试验证非正数截图限制会在加载时被拒绝。

## 结果

Observation 传输和持久化截图输出具有明确限制。运维人员可以在 `cordis.yml` 中调整截图预算；更低的配置会拒绝只符合默认限制的证据。

文本提取仍会在 renderer 内瞬时生成 `innerText`。PNG byte 验证必须在 Chromium encoding 和 Playwright 传输后执行，因此不能阻止这部分瞬时 browser 与 Node.js 内存分配。Pixel 预检限制 raster 尺寸；byte 检查则阻止超大 encoding 进入 attachment persistence 和下游输出。
