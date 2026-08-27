# dsh-browser-runtime

[English](README.md) | 中文

`dsh-browser-runtime` 为每个 DeepSeek Harness Agent 提供有租约、有状态的浏览器环境。它负责 Provider 选择、Agent 隔离、生命周期、操作串行化、过期引用检查、checkpoint 索引和 transition 证据；Playwright 只是该 API 后面的一个 Provider，模型工具则是独立 Consumer。

仓库是一个可安装的 DSH bundle，包含三个插件入口：

| 入口 | 角色 | Service 或工具 |
|---|---|---|
| `dsh-browser-runtime` | Service Definition 与控制面 | `ctx.browserRuntime` |
| `dsh-browser-runtime/playwright` | Playwright/Chromium Provider | Provider id `playwright` |
| `dsh-browser-runtime/tools` | 面向模型的 Consumer | 五个 `browser_*` 工具 |

单包结构支持 `dsh plugin add github:...`。源码仍按三个角色分目录；如果它们以后需要独立发布节奏，可以直接拆成不同 npm 包。

## v0.1 行为

- 每个精确 Agent 对象拥有一个隔离 BrowserContext 和一个 Page。
- 同一 owner 的并发 acquire 共享初始化并返回独立 lease；不同 owner 永不共享环境。
- 取消一个 acquire 或工具调用只终止该调用方的等待；其他等待方仍可完成 owner 共享初始化。
- 取消正在执行的浏览器操作会释放可能已不可用的 Agent lease；下一次工具调用会打开或恢复新环境。
- 同一环境的操作按 FIFO 执行；不同环境可以并行。
- 每次 observation 生成 `e1` 之类的局部引用；只有最新 observation 的引用可以执行。
- `navigate`、`click`、`fill` 生成 before/after transition 证据；fill 内容不会写入 Runtime 证据。
- 紧凑 transition 索引写入失败会记录一条运维警告，但不会改变 action 成功、Provider 失败或取消的结果；当前进程的查询会保留有界内存记录。
- 截图通过 `ctx.attachments` 保存为 PNG，模型不能指定宿主机路径。
- `resume` 保存 cookie 和 localStorage；恢复后 generation 增加，旧 page、observation、element 身份全部失效。同一 session 的 checkpoint payload 创建、索引提交或回滚以及旧 payload 清理会跨 owner 串行执行；一个 Provider 不能替换另一个 Provider 的 session checkpoint。
- Provider 卸载会在 Provider 级资源释放前中止并等待选择与初始化；最后一个 lease 释放、Agent 销毁和 Runtime 卸载也会等待浏览器资源清理完成。

模型工具：

| 工具 | 用途 |
|---|---|
| `browser_open` | 打开 HTTP(S) URL 并返回 observation |
| `browser_observe` | 刷新页面文本和交互元素引用 |
| `browser_click` | 点击最新 observation 中的引用 |
| `browser_fill` | 向非密码输入项写入非敏感文本 |
| `browser_screenshot` | 保存视口或整页 PNG attachment |

## 开发与测试

需要 Node.js `^22.19` 或 `>=24`，以及 pnpm 10。

```sh
pnpm install
pnpm exec playwright install chromium
pnpm run typecheck
pnpm run test:coverage
pnpm run build
pnpm run lint:package
pnpm pack
```

如果 Playwright 管理的 Chromium 存在，`pnpm test` 会启动真实本地 HTTP server 和 Chromium；没有 Chromium 时 Playwright 测试会自行跳过，CI 会明确安装 Chromium。

## 安装到 DeepSeek Harness

本地源码建议先打 tarball，再安装到 profile：

```sh
pnpm install
pnpm exec playwright install chromium
pnpm pack
dsh plugin --profile browser add ./dsh-browser-runtime-0.1.1.tgz
dsh plugin --profile browser exec playwright install chromium
dsh --profile browser --dump-config
```

从 GitHub 安装时应固定 commit：

```sh
dsh plugin --profile browser add github:YOUR_ACCOUNT/dsh-browser-runtime#COMMIT_SHA
dsh plugin --profile browser exec playwright install chromium
```

Git 安装会执行本包的 `prepare` 构建。pnpm 10 默认拒绝该脚本，需要在 profile 的 `pnpm-workspace.yaml` 中允许精确包名：

```yaml
allowBuilds:
  dsh-browser-runtime: true
```

授权构建前应审查并固定源码。发布到 npm 的包或 tarball 已携带构建产物，不需要该授权。

## 配置

Bundle 的 [`cordis.patch.yml`](cordis.patch.yml) 默认选择 Playwright、使用 ephemeral Agent 环境、阻止私网访问，并注册全部五个工具。用户 profile 可以按 id 替换任意行；DSH patch 会替换整段 `config`，因此覆盖时必须重述该行的全部字段。

Runtime 行：

```yaml
- id: browser-runtime
  config:
    provider: playwright
    maxTextChars: 60000
    maxTransitionsInMemory: 500
    cleanupTimeoutMs: 10000
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
    allowPrivateNetwork: false
    # checkpointRoot: /private/absolute/path
```

工具行：

```yaml
- id: tool-browser
  config:
    provider: playwright
    persistence: ephemeral # 或 resume
    timeoutMs: 30000
```

`persistence: resume` 可以在同一进程内从 Runtime 内存索引恢复。跨进程恢复还需要 DSH 的 `ctx.storageDomain`，Web profile 已经挂载该服务。Checkpoint 元数据写入 `browser_runtime` domain；Playwright 的敏感 storage-state payload 以 owner-only 权限存放在 `$DSH_HOME/browser-runtime/providers/playwright/v1/checkpoints`。

## 安全限制

默认 Provider 使用临时隔离的浏览器 profile 和经过清理的私有 `HOME`，阻止 service worker，不提供下载、上传、任意模型 JavaScript、模型 selector 或连接用户 Chrome profile 的 API。导航只接受不含内嵌凭据的 HTTP(S) URL。在 strict mode 中，每个 environment 都会把 HTTP(S)、`ws:`/`wss:` 和经代理的浏览器 TCP 流量发送到带认证的 loopback proxy。Proxy 只解析一次 hostname，要求全部结果符合地址策略，并只使用这些结果创建 upstream socket，避免浏览器选择另一条 DNS 结果。默认策略会拒绝 loopback、private、link-local、reserved 和 multicast 目标。

Strict mode 还会在受管理的 Chromium build 中禁用 QUIC 和直连 WebRTC UDP，因此 WebTransport、HTTP/3、STUN 和 TURN 不能建立未经过代理的路径。`allowPrivateNetwork` 是显式 opt-in；它不会启动 policy proxy，也不会加入这些启动限制，因此允许 HTTP、WebSocket、UDP 与 QUIC 直接连接私网等目标。Playwright request route 仍会拒绝不支持的协议和包含内嵌凭据的 URL。Provider 只支持由固定 Playwright 版本管理的 Chromium build。

Provider 只暴露一个页面。如果 click 的有效 link 或 form target 会创建另一个 browsing context，该操作会在 dispatch 前以 `BROWSER_POLICY_DENIED` 失败。页面脚本调用 `window.open` 会得到 `null`，触发它的 action 也会收到相同 policy failure。其他意外 Page 会被关闭，并在 action 或 environment cleanup 完成前排空；v0.1 不会把 popup 交还给 Agent。

页面 dialog 会被自动 dismiss，action 会等待 dismiss 完成后再返回。被 dismiss 的 confirm 结果为 `false`，prompt 结果为 `null`；v0.1 不提供接受 dialog 或输入 prompt 的 API。

文件输入会在 dispatch 前以 `BROWSER_POLICY_DENIED` 失败。初始化脚本还会阻止通过 `click()`、`showPicker()`、click event 和关联 label 激活文件输入；意外出现的 Playwright FileChooser 会作为兜底被清空。宿主机文件路径和文件 payload 都不会进入页面。

带 `download` attribute 的 link 会在 dispatch 前失败。`Content-Disposition` 为 `attachment` 的导航 response 会在 response header 到达后通过 Chromium control 停止；其他 Playwright Download event 会被取消。Provider 只为取得并取消 transfer 的所有权而启用 Playwright download，既不暴露路径，BrowserContext cleanup 也会删除所有 partial artifact。由 response 决定的 download 可能在 attachment header 被观察并停止前已经到达 server 并传输初始 bytes。

BrowserContext 不授予任何 Web permission，Chromium 也会拒绝 permission prompt。因此 geolocation、notification、camera、microphone、clipboard read、clipboard write 和其他由 permission 控制的 browser API 都会在不打开宿主 UI 的情况下报告 `denied`。请求 permission 的 page action 仍可作为普通 click 成功，而页面会收到 denial。

如果 observation 中 link 或 form submission 的有效 URL 使用 HTTP(S)、`javascript:`、`blob:`、`data:`、`about:` 以外的 protocol，该操作会在 dispatch 前以 `BROWSER_POLICY_DENIED` 失败。Init script 还会阻止 external-protocol anchor click、form activation 和 `form.submit()`；对于直接写入 `location.href` 等 renderer navigation，Chromium control 会在其继续前将其停止。这些受控路径不会为 `mailto:`、`tel:`、`file:` 或 custom protocol 调用宿主 handler。

Observation 正文会在 Chromium 内按照 Runtime 的 `maxTextChars` 截断，然后才跨越 Playwright protocol；`maxElements` 限制 target metadata 数量。截图会在 capture 前按照 device pixel 检查 `maxScreenshotPixels`，并在 PNG encoding 后检查 `maxScreenshotBytes`。超过任一限制都会返回 `BROWSER_POLICY_DENIED`，而且不会持久化 attachment。Encoded-byte 检查无法避免生成和接收 PNG 所需的瞬时 browser 与 Node.js 内存分配。

`browser_fill` 不是秘密输入通道。DSH 会在插件执行前记录原始 tool-call 参数，因此写入 `value` 的秘密仍会进入 Session log，即使 Runtime transition 证据已经隐藏该值。密码输入框会被直接拒绝。

Proxy 与浏览器启动限制属于应用层出站限制，不是操作系统网络 sandbox。如果部署需要独立的网络边界，应使用宿主机防火墙或容器网络策略。

## v0.1 不包含

popup 接管、下载、上传、任意 JavaScript、连接真实 Chrome、跨 Provider checkpoint 转换、IndexedDB/sessionStorage 恢复、凭据管理，以及通用的非浏览器 Environment API。Playwright 管理的 Chromium 需要单独安装。

Provider 扩展、所有权、失败与证据规则见[架构说明](docs/architecture.zh.md)。
