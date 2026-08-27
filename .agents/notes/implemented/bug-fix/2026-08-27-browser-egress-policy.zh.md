# Agent Note: 对全部浏览器出站通道执行策略

Status: implemented；其中关于 `allowPrivateNetwork` 的决定已被
[把私网访问改成白名单，而不是开关](2026-08-27-network-allowlist.zh.md)取代——
后者保留本文描述的全部控制，并用 `network.mode` 加主机、放行与拒绝列表替换该布尔值。

[English](2026-08-27-browser-egress-policy.md) | 中文

## Problem

Playwright 的 HTTP request route 并不控制页面能创建的全部连接。WebSocket 使用独立的路由生命周期，WebRTC ICE 可以发送 UDP 或通过 TCP 打开 TURN，WebTransport 则使用 QUIC。通过 HTTP(S) 策略准入的页面仍可借助其他 transport 连接 loopback、private、link-local、reserved 或 multicast 目标。

如果在 route admission 时解析 hostname，之后再让 Chromium 重新解析，还会留下 DNS rebinding 时间窗口，使 Chromium 可能选中未经策略验证的地址。

## Decision

每个 strict Playwright environment 都拥有一个绑定到临时 IPv4 loopback 端口的 HTTP proxy，并使用随机生成的 environment 专属 Basic 凭据。Chromium 会把 HTTP、HTTPS、WebSocket 和经代理的 WebRTC TCP 流量发送到该 proxy。Provider 会在安装页面 route 前，通过临时页面加载由 proxy 自己返回的空文档。该请求不会接触 upstream server，只用于建立 Chromium 的 proxy-authentication cache；这是因为最初的 `ws:` 连接不会重试 proxy authentication challenge。

Proxy 解析每个目标、拒绝内嵌凭据、只解析一次 hostname、要求全部解析地址符合配置的地址策略，并且只使用这些已验证地址打开 upstream socket。一次性 HTTP Agent 会把转发请求绑定到这个已经连接的 socket；request-level `createConnection` option 无法提供该保证。Chromium 和 Node HTTP client 都不会再次解析经过代理的目标。

默认策略会在启动 Chromium 时禁用 QUIC 和未经过代理的 WebRTC UDP。因此，WebTransport 与 HTTP/3 不能建立直连 QUIC 路径，HTTPS fallback 仍然可用。WebRTC 可以通过带认证的 proxy 使用公共 TURN endpoint。`allowPrivateNetwork` 不会启动 proxy，也不会加入这两个启动限制，因此允许 HTTP、WebSocket、UDP 和 QUIC 直接连接私网与公共目标。Request route 与 WebSocket route 仍会拒绝不支持的协议和包含内嵌凭据的 URL。

Provider 仍会在创建页面前注册 context 范围的 WebSocket route。它会在 `connectToServer()` 前应用相同 URL 策略，以策略代码 `1008` 关闭被拒绝的 route，并保留 action attribution。在 strict mode 中，proxy 是实际执行连接限制的位置，并使用固定 DNS 结果再次完成准入。

Proxy shutdown 会先停止 admission，再销毁浏览器和 upstream socket；Provider teardown 会先关闭 proxy，再关闭 BrowserContext 与 browser。Proxy shutdown 或已经观察到 browser-client abort 后才完成的 DNS 操作不能创建新的 upstream 连接。Provider 只使用 Playwright 管理的 Chromium，并把 Playwright 固定为 `1.62.1`，使这些启动限制对应的浏览器行为成为经过测试的实现组成部分。

## Alternatives considered

**只使用 Playwright request route 作为网络控制。** 不采用，因为它不拥有 WebSocket、WebRTC、WebTransport，也不能控制浏览器的第二次 DNS lookup。

**依赖 Chromium IP handling 或 Local Network Access 设置。** 不采用，因为真实 Chromium probe 在可用设置下仍能通过 UDP 到达 private STUN，或通过 TCP 到达 private TURN。

**使用初始化脚本隐藏浏览器 API。** 不采用，因为修改页面脚本环境不是网络控制，也不能覆盖浏览器内部或未来新增的 transport 路径。

**运行无认证的 loopback proxy。** 不采用，因为其他本地进程可能把它当作已经通过准入的出站 relay。

**假设 Chromium 会为最初的 WebSocket 使用已经配置的 proxy credential。** 不采用，因为真实浏览器 probe 收到 proxy challenge 后没有重试。在同一个 BrowserContext 中先完成一次认证 HTTP exchange，WebSocket 才能使用这些凭据。

**接受任意 Chromium executable。** 不采用，因为其他版本或 Chromium 衍生浏览器对安全启动参数的解释可能不同于集成测试覆盖的浏览器。

## Verification

策略测试覆盖协议、凭据、私网地址、允许连接、拒绝关闭以及关闭失败传播。Proxy 集成测试要求 HTTP 认证，覆盖允许和拒绝的 CONNECT tunnel，并证明 proxy shutdown 和已经观察到的 client abort 都能在 pending DNS resolution 期间获胜。真实 Chromium 测试只在 policy result 中把 reserved `.invalid` hostname 映射到 loopback 测试服务器，然后要求 HTTP 与 WebSocket 通过认证 proxy 到达该服务器。这证明实际请求使用固定地址，而不是再次执行 DNS lookup。其他 probe 会在启用私网访问时观察 private STUN UDP 与 WebTransport QUIC；strict mode 必须产生零个 STUN packet、零个 private TURN TCP connection 和零个 WebTransport UDP packet。同一个 secure page 还会确认 Direct Sockets API 在 Isolated Web App 之外不可用。

## Consequences

默认 Provider 放弃直连 QUIC 和 WebRTC UDP。无法响应 proxy authentication 的 WebRTC stack 也可能无法通过 TCP 使用 TURN。公共 HTTP(S)、WebSocket 和兼容的经代理 TCP 流量仍然可用。

在 strict mode 中，HTTP(S)、WebSocket 和经代理 TCP 连接会为策略准入与 socket 创建使用同一组 DNS 结果。`allowPrivateNetwork` 是显式允许浏览器直连的 opt-in，因此不再提供 proxy 级地址过滤或 DNS 固定。Provider 要求使用 Playwright 管理的 Chromium，不接受调用方提供的 executable。

Strict environment setup 会在创建向 Runtime 暴露的页面前完成一次 proxy 自有的空文档请求。Strict environment teardown 会先关闭 proxy admission 与 socket，再等待浏览器清理。
