# dsh-browser-runtime

[English](README.md) | 中文

> 让任何 DeepSeek Harness agent（智能体）成为具有隔离环境和持久状态的 browser agent（浏览器智能体）。

`dsh-browser-runtime` 为 agent 提供可操作交互式页面的真实 Chromium 浏览器：它可以导航、观察、点击、填写表单、等待更新、提取结构化内容并保存截图。一个 DSH bundle 会同时安装运行时、Playwright 提供方、模型工具，以及教现有 agent 使用这些能力的系统提示词。

这是一套浏览器运行时，而不是一组松散的 Playwright 调用。它负责 agent 隔离、浏览器生命周期、操作串行化、陈旧引用检查、可恢复检查点、transition 证据、凭据处理和出站网络策略。它直接扩展当前 DSH agent，不会启动第二套浏览器专用 agent loop（智能体循环）。

## 快速开始

需要 DeepSeek Harness、Node.js `^22.19` 或 `>=24`，以及 pnpm 10。安装 bundle、安装它固定版本的 Chromium build，然后验证运行时：

```sh
dsh plugin --profile web add -w dsh-browser-runtime
dsh-browser-runtime install chromium
dsh-browser-runtime doctor
```

启动或重启 Web profile，然后用自然语言描述浏览器任务：

> 打开 Hacker News，提取前十条内容，进入最热门的一条并总结，最后保存一张完整页面截图。

同一个 agent 会获得 `browser_*` 工具和使用说明。一次典型执行会依次完成 `browser_open` → observation 引用 → action 或提取 → 新 observation → 截图，不需要另一个 agent 或单独的编排层。

### 其他安装来源

从本地源码安装时，先构建 tarball，再安装该路径：

```sh
pnpm install
pnpm pack
dsh plugin --profile web add -w ./dsh-browser-runtime-0.1.2.tgz
dsh-browser-runtime install chromium
dsh-browser-runtime doctor
dsh --profile web --dump-config
```

从 GitHub 安装时，应固定经过审查的 commit：

```sh
dsh plugin --profile web add -w github:YOUR_ACCOUNT/dsh-browser-runtime#COMMIT_SHA
dsh-browser-runtime install chromium
```

`dsh-browser-runtime doctor` 会报告 Node、插件和 Playwright 版本，Chromium 的安装状态和路径，DSH Loader 看到的导出，bundle patch，以及提供方能否打开环境。任何检查失败都会以非零码退出。

Git 安装会执行本包的 `prepare` 构建。pnpm 10 会拒绝该脚本，直到 profile 的 `pnpm-workspace.yaml` 允许精确包名：

```yaml
allowBuilds:
  dsh-browser-runtime: true
```

授权构建前应审查并固定源码。发布到 npm 的包或 tarball 已携带构建产物，不需要该授权。

## Agent 获得什么

- 十八个始终可用的浏览器工具覆盖导航、观察、表单、滚动、等待、截图和结构化提取；可选凭据工具可以填写已存秘密，而不会向模型暴露明文。
- 每个精确 Agent 对象拥有隔离的 BrowserContext 和 Page，因此并行 Agent 不会共享 cookie、导航状态、元素引用或浏览器清理过程。
- 排序后的 observation 会把控件、分页、导航和记录标题放在重复的低价值链接之前，continuation 可以继续读取而不重新生成引用。
- Action 只接受最新 observation 的引用，不接受模型提供的 selector 或 JavaScript；陈旧或已变化的目标会在提供方执行前失败。
- `resume` 检查点可以跨浏览器 generation 保留 cookie 和 localStorage，ephemeral 模式则每次从干净环境开始。
- 每个被接受的 action 都会记录 before/after 证据、耗时与结果；失败时还会返回一行可由机器路由的恢复信息。

## 为什么要使用浏览器运行时？

| 关注点 | 直接为 Agent 接入浏览器调用 | `dsh-browser-runtime` |
|---|---|---|
| 安装 | 分别接入工具服务器、提示词、浏览器进程和清理路径 | 一个 DSH bundle 挂载运行时、提供方、工具和使用说明 |
| 多 Agent | 集成方负责分隔浏览器状态和取消操作 | 每个精确 Agent 拥有隔离环境、独立 lease 和 FIFO |
| 元素寻址 | selector、页面 JavaScript，或由调用方维护有效性的引用 | 最新 observation 引用，并由运行时和提供方执行陈旧检查 |
| 状态 | 共享 profile 或集成特有的 storage state | 每个 Agent session 显式选择 `ephemeral` 或可恢复检查点策略 |
| 失败 | 工具异常没有统一恢复约定 | transition 证据，以及错误码、状态有效性、建议 action 和可重试性 |
| 安全 | 由部署自行实现浏览器和秘密控制 | 默认仅允许公网、限制输出，并提供支持审批的凭据通道 |

提供方注册表可替换：Playwright/Chromium 是随包提供的实现，消费方依赖 `BrowserRuntime`，不依赖 Playwright 对象、CSS selector 或宿主机路径。因此增加其他提供方时，面向 Agent 的行为可以保持稳定。

## 模型工具

| 工具 | 用途 |
|---|---|
| `browser_open` | 打开 HTTP(S) URL 并返回 observation |
| `browser_observe` | 按指定模式刷新页面文本和交互元素引用 |
| `browser_observe_next` | 继续读取最新 observation 的下一页 |
| `browser_click` | 点击最新 observation 中的引用 |
| `browser_fill` | 向非密码输入项写入非敏感文本 |
| `browser_fill_credential` | 用按名引用的已存凭据填写输入项 |
| `browser_press` | 向引用或当前焦点元素发送一个白名单按键 |
| `browser_select` | 在 select 引用中选择选项 |
| `browser_check` | 设置复选框或单选框引用的状态 |
| `browser_scroll` | 按视口倍数、到页首页尾或滚动到引用 |
| `browser_back` / `browser_forward` / `browser_reload` | 在本环境自己的历史中前后移动 |
| `browser_wait` | 等待页面或元素状态后再观察 |
| `browser_screenshot` | 保存视口或整页 PNG attachment |
| `browser_extract_list` / `_table` / `_links` / `_article` | 从某个区域读取结构化内容 |

只有在配置了凭据来源时才会注册 `browser_fill_credential`。提取工具接受最新 observation 中的 `region_ref`，既不接受 selector 也不接受 JavaScript；元素引用会扩展到调用方所指的语义区域，因此指定某条记录的链接可以提取它所在的列表。面对数百或数千条静态数据时，官方 API 或直接 fetch 优于浏览器逐页操作。

## 架构概览

```text
DSH Agent -> browser_* tools -> BrowserRuntime -> Playwright Provider -> Chromium
```

可安装包包含三个插件入口：

| 入口 | 角色 | Service 或工具 |
|---|---|---|
| `dsh-browser-runtime` | Service Definition 与控制面 | `ctx.browserRuntime` |
| `dsh-browser-runtime/playwright` | Playwright/Chromium Provider | Provider id `playwright` |
| `dsh-browser-runtime/tools` | 面向模型的 Consumer | `browser_*` 工具和提示词说明 |

Bundle patch 会同时挂载三个角色。源码目录仍将角色分开，因此新的提供方可以注册到相同运行时和工具消费方后面。所有权、取消、持久化、证据与扩展规则见[架构及提供方 API](docs/architecture.zh.md)。

## 运行时行为

- 每个精确 Agent 对象拥有一个隔离 BrowserContext 和一个 Page。
- 同一 owner 的并发 acquire 共享初始化并返回独立 lease；不同 owner 永不共享环境。
- 取消一个 acquire 或工具调用只终止该调用方的等待；其他等待方仍可完成 owner 共享初始化。
- 取消正在执行的浏览器操作会释放可能已不可用的 Agent lease；下一次工具调用会打开或恢复新环境。
- 同一环境的操作按 FIFO 执行；不同环境可以并行。
- 每次 observation 生成 `e1` 之类的局部引用；只有最新 observation 的引用可以执行。
- observation 按五个层级排序——表单控件与分页、站点导航、记录标题、正文链接、重复的记录内链接——因此预算裁剪会先丢弃作者链接，而不是分页链接。重复的页面记录会折叠成 `g1` 这样的分组，`dt`/`dd` 一对算作同一条记录。
- `browser_observe` 接受 `mode`（`summary`、`interactive`、`document`）以及 `max_text_chars` 和 `max_elements`。`browser_observe_next` 在不重新观察的前提下继续读取最新 observation，因此翻页期间元素引用保持有效。
- 每个 action 都生成带耗时与输出规模指标的 before/after transition 证据；fill 内容不会写入 Runtime 证据。
- 工具失败会追加一行可路由信息：`code`、`url`、`observation`、`lease`、`recommended_action`、`retryable`。系统不会自动重试，因为失败的点击仍可能已经发生跳转。
- 紧凑 transition 索引写入失败会记录一条运维警告，但不会改变 action 成功、Provider 失败或取消的结果；当前进程的查询会保留有界内存记录。
- 截图通过 `ctx.attachments` 保存为 PNG，模型不能指定宿主机路径。
- `resume` 保存 cookie 和 localStorage；恢复后 generation 增加，旧 page、observation、element 身份全部失效。同一 session 的 checkpoint payload 创建、索引提交或回滚以及旧 payload 清理会跨 owner 串行执行；一个 Provider 不能替换另一个 Provider 的 session checkpoint。
- Provider 卸载会在 Provider 级资源释放前中止并等待选择与初始化；最后一个 lease 释放、Agent 销毁和 Runtime 卸载也会等待浏览器资源清理完成。

## 配置

Bundle 的 [`cordis.patch.yml`](cordis.patch.yml) 默认选择 Playwright、使用 ephemeral Agent 环境、阻止私网访问，并注册完整的浏览器工具组。用户 profile 可以按 id 替换任意行；DSH patch 会替换整段 `config`，因此覆盖时必须重述该行的全部字段。

Runtime 行：

```yaml
- id: browser-runtime
  config:
    provider: playwright
    maxTextChars: 60000
    maxTransitionsInMemory: 500
    cleanupTimeoutMs: 10000
    checkpointTtlMs: 0
    maxCheckpoints: 100
```

Playwright 行：

```yaml
- id: browser-playwright
  config:
    headless: true
    navigationTimeoutMs: 30000
    actionTimeoutMs: 10000
    maxElements: 100
    maxScreenshotPixels: 16000000
    maxScreenshotBytes: 16777216
    network:
      mode: strict # strict | allowlist | unrestricted
      allowHosts: []
      allowCidrs: []
      denyCidrs: []
    # checkpointRoot: /private/absolute/path
```

工具行：

```yaml
- id: tool-browser
  config:
    provider: playwright
    persistence: ephemeral # or resume
    timeoutMs: 30000
    observeMode: summary # or interactive, document
    maxTextChars: 12000
    maxElements: 100
    # credentials:
    #   requireApproval: true
    #   refs:
    #     ci-token: DSH_BROWSER_CI_TOKEN
```

`observeMode` 决定未指定模式时使用的默认模式，`maxTextChars`/`maxElements` 限制单次响应最多携带的内容。Runtime 行的 `maxTextChars` 是另一个上限，约束一次 observation 从页面保留多少文本。

Runtime 的 checkpoint 保留由 `checkpointTtlMs`（`0` 表示永久保留）和 `maxCheckpoints` 限制。持久索引加载时会执行一次裁剪；`ctx.browserRuntime.pruneCheckpoints()` 和 `listCheckpoints()` 对外暴露该能力，`dsh-browser-runtime checkpoints [--clear]` 可以列出或删除 Provider 私有 payload。每条记录都保存写入它的 Provider build，恢复时会拒绝由其他 build 写入的 payload。

`persistence: resume` 可以在同一进程内从 Runtime 内存索引恢复。跨进程恢复还需要 DSH 的 `ctx.storageDomain`，Web profile 已经挂载该服务。Checkpoint 元数据写入 `browser_runtime` domain；Playwright 的敏感 storage-state payload 以 owner-only 权限存放在 `$DSH_HOME/browser-runtime/providers/playwright/v1/checkpoints`。

## 安全限制

默认 Provider 使用临时隔离的浏览器 profile 和经过清理的私有 `HOME`，阻止 service worker，不提供下载、上传、任意模型 JavaScript、模型 selector 或连接用户 Chrome profile 的 API。导航只接受不含内嵌凭据的 HTTP(S) URL。在 strict mode 中，每个 environment 都会把 HTTP(S)、`ws:`/`wss:` 和经代理的浏览器 TCP 流量发送到带认证的 loopback proxy。Proxy 只解析一次 hostname，要求全部结果符合地址策略，并只使用这些结果创建 upstream socket，避免浏览器选择另一条 DNS 结果。默认策略会拒绝 loopback、private、link-local、reserved 和 multicast 目标。

Strict mode 还会在受管理的 Chromium build 中禁用 QUIC 和直连 WebRTC UDP，因此 WebTransport、HTTP/3、STUN 和 TURN 不能建立未经过代理的路径。

`network.mode: allowlist` 保留上述全部控制，只额外放行 `allowHosts` 中的主机和 `allowCidrs` 中的网段。`allowHosts` 条目按 hostname 精确匹配；以点开头的条目同时匹配该主机及其子域。`denyCidrs` 会在任何放行之前检查，并在所有模式下生效，因此即使 profile 放行了 loopback，`169.254.0.0/16` 这类 link-local 网段仍不可达。请优先使用它，而不是旧开关：

```yaml
network:
  mode: allowlist
  allowHosts: [localhost, .dev.internal.example]
  allowCidrs: [127.0.0.1/32]
  denyCidrs: [169.254.0.0/16]
```

`network.mode: unrestricted` 不会启动 policy proxy，也不会加入这些启动限制，因此允许 HTTP、WebSocket、UDP 与 QUIC 直接连接私网等目标。已废弃的 `allowPrivateNetwork: true` 映射到该模式；把它和相互矛盾的 `network.mode` 一起配置会在加载时失败。所有模式下 Playwright request route 仍会拒绝不支持的协议和包含内嵌凭据的 URL。Provider 只支持由固定 Playwright 版本管理的 Chromium build。

Provider 只暴露一个页面。如果 click 的有效 link 或 form target 会创建另一个 browsing context，该操作会在 dispatch 前以 `BROWSER_POLICY_DENIED` 失败。页面脚本调用 `window.open` 会得到 `null`，触发它的 action 也会收到相同 policy failure。其他意外 Page 会被关闭，并在 action 或 environment cleanup 完成前排空；v0.1 不会把 popup 交还给 Agent。

页面 dialog 会被自动 dismiss，action 会等待 dismiss 完成后再返回。被 dismiss 的 confirm 结果为 `false`，prompt 结果为 `null`；v0.1 不提供接受 dialog 或输入 prompt 的 API。

文件输入会在 dispatch 前以 `BROWSER_POLICY_DENIED` 失败。初始化脚本还会阻止通过 `click()`、`showPicker()`、click event 和关联 label 激活文件输入；意外出现的 Playwright FileChooser 会作为兜底被清空。宿主机文件路径和文件 payload 都不会进入页面。

带 `download` attribute 的 link 会在 dispatch 前失败。`Content-Disposition` 为 `attachment` 的导航 response 会在 response header 到达后通过 Chromium control 停止；其他 Playwright Download event 会被取消。Provider 只为取得并取消 transfer 的所有权而启用 Playwright download，既不暴露路径，BrowserContext cleanup 也会删除所有 partial artifact。由 response 决定的 download 可能在 attachment header 被观察并停止前已经到达 server 并传输初始 bytes。

BrowserContext 不授予任何 Web permission，Chromium 也会拒绝 permission prompt。因此 geolocation、notification、camera、microphone、clipboard read、clipboard write 和其他由 permission 控制的 browser API 都会在不打开宿主 UI 的情况下报告 `denied`。请求 permission 的 page action 仍可作为普通 click 成功，而页面会收到 denial。

如果 observation 中 link 或 form submission 的有效 URL 使用 HTTP(S)、`javascript:`、`blob:`、`data:`、`about:` 以外的 protocol，该操作会在 dispatch 前以 `BROWSER_POLICY_DENIED` 失败。Init script 还会阻止 external-protocol anchor click、form activation 和 `form.submit()`；对于直接写入 `location.href` 等 renderer navigation，Chromium control 会在其继续前将其停止。这些受控路径不会为 `mailto:`、`tel:`、`file:` 或 custom protocol 调用宿主 handler。

Observation 正文会在 Chromium 内按照 Runtime 的 `maxTextChars` 截断，然后才跨越 Playwright protocol；`maxElements` 限制 target metadata 数量。截图会在 capture 前按照 device pixel 检查 `maxScreenshotPixels`，并在 PNG encoding 后检查 `maxScreenshotBytes`。超过任一限制都会返回 `BROWSER_POLICY_DENIED`，而且不会持久化 attachment。Encoded-byte 检查无法避免生成和接收 PNG 所需的瞬时 browser 与 Node.js 内存分配。

`browser_fill` 不是秘密输入通道。DSH 会在插件执行前记录原始 tool-call 参数，因此写入 `value` 的秘密仍会进入 Session log，即使 Runtime transition 证据已经隐藏该值。密码输入框会被直接拒绝。

`browser_fill_credential` 才是该通道。模型只提供 `credential_ref`；明文由部署挂载的 `ctx.browserCredentials` 服务或配置的环境变量映射解析，并直接交给 Provider。它不会进入模型请求、工具参数、transition 证据或 Session log——证据中只保留引用名和 `[REDACTED]`。除非关闭 `credentials.requireApproval`，每次填写都要经过 `ctx.approval`；要求审批却没有挂载审批服务时会拒绝全部填写，而不是放行。只有在配置了凭据来源时才会注册该工具。

Proxy 与浏览器启动限制属于应用层出站限制，不是操作系统网络 sandbox。如果部署需要独立的网络边界，应使用宿主机防火墙或容器网络策略。

## v0.1 不包含

popup 接管、下载、上传、任意 JavaScript、连接真实 Chrome、跨 Provider checkpoint 转换、IndexedDB/sessionStorage 恢复，以及通用的非浏览器 Environment API。Checkpoint payload 是磁盘上的 owner-only 文件，而不是加密或受密钥管理的存储。目前没有专用的浏览器 Web UI，也没有用于连接运行中 Chrome 的 CDP Provider。Playwright 管理的 Chromium 需要单独安装。

## 开发与测试

```sh
pnpm install
node lib/cli/index.js install chromium
pnpm run typecheck
pnpm run test:coverage
pnpm run build
pnpm run lint:package
pnpm run verify:package
pnpm run verify:tarball
```

如果 Playwright 管理的 Chromium 存在，`pnpm test` 会启动真实本地 HTTP server 和 Chromium；没有 Chromium 时 Playwright 测试会自行跳过，CI 会明确安装 Chromium。

### 场景覆盖

| 场景 | 覆盖它的测试 |
|---|---|
| 打开公开静态网页 | `playwright.integration.spec.ts` |
| 填写搜索框并按 Enter | `playwright-observation.integration.spec.ts` |
| 使用 action 返回的新 observation | `browser-tools.spec.ts`、`tool.integration.spec.ts` |
| 用已被替换的引用操作并得到 stale 错误 | `browser-tools.spec.ts`、`playwright-observation.integration.spec.ts` |
| 点击后页面异步更新 | `playwright-observation.integration.spec.ts` |
| 下拉框、复选框和滚动 | `playwright-observation.integration.spec.ts` |
| 完整页面截图 | `playwright.integration.spec.ts` |
| 私网默认拒绝、白名单允许 | `network-policy.spec.ts`；真实浏览器套件都在 `mode: allowlist` 下运行 |
| Cookie/localStorage checkpoint 恢复 | `playwright.integration.spec.ts`、`storage.integration.spec.ts` |
| 操作取消后 lease 重建 | `tool.integration.spec.ts` |
| 两个 Agent 并行隔离 | `browser-tools.spec.ts`、`runtime.spec.ts` |
| Provider 卸载与资源回收 | `runtime.spec.ts` |
| Chromium 缺失诊断 | `startup-diagnostics.spec.ts`、`cli-main.spec.ts` |
| 最终 tarball 能挂载并注册工具 | `verify:tarball` |

`verify:tarball` 会把打包后的归档挂载到真实 Cordis Context 中，使用真实的 DSH tool、system-prompt 与 attachment 服务，并对解压后的文件运行 `doctor`。它不是一次 `dsh` profile 安装：这里没有任何环节驱动 `dsh` CLI，因此最后一步——`dsh plugin --profile web add -w …` 之后真实启动 profile——仍需在装有 DSH 的机器上手动验证。

`verify:package` 针对构建产物运行发布物门禁，`verify:tarball` 则先打包、解压，再针对 profile 实际安装的那份归档重跑一遍：每个 `exports` 子路径都能解析、函数式插件入口没有 default 导出、真实的 `Loader.unwrapExports` 保留了它们的 `inject`/`Config`/`name`、三个入口都能在真实 Cordis Context 中挂载、`doctor` 针对解压后的文件运行，并输出包版本、源码提交和入口的完整性摘要。

### 打包约定

两个函数式插件入口只使用具名导出。DSH Loader 用 `exports.default ?? exports` 解析导入的模块，因此 default 导出会丢弃 `inject`、`Config` 和 `name`，Provider 会在 `ctx.browserRuntime` 处失败。default 导出只保留给把 `inject` 和 `Config` 作为静态属性携带的 Service 或 class 插件，所以 Runtime 入口保留 `export { BrowserRuntime as default }`。`pnpm run verify:tarball` 会针对打包后的归档执行这条规则。
