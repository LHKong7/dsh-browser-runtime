# Agent Note: 把私网访问改成白名单，而不是开关

Status: implemented

[English](2026-08-27-network-allowlist.md) | 中文

## Problem

`allowPrivateNetwork` 是一个布尔值，把它设为 `true` 做的事情远不止放行一个地址。它移除了带认证的 loopback proxy，也就一并移除了"只解析一次并固定结果"的 DNS pinning——那是阻止浏览器选择与策略批准结果不同的答案的机制。它移除了禁用 QUIC 和未经代理的 WebRTC UDP 的 Chromium 启动限制，重新打开了 WebTransport、HTTP/3、STUN 和 TURN 这些未经代理的路径。它一次性放行了全部非公网网段，包括 link-local 的 `169.254.0.0/16`——云元数据端点——而该 profile 实际需要的只是一个内网主机名。

于是，只想让 Agent 访问 `dev.internal.example` 的部署，必须用整套出站控制去交换，而且配置里没有任何地方记录这个例外是为哪个主机开的。

## Decision

出站策略配置为一个模式加若干列表：

```yaml
network:
  mode: allowlist
  allowHosts: [localhost, .dev.internal.example]
  allowCidrs: [127.0.0.1/32]
  denyCidrs: [169.254.0.0/16]
```

`strict` 是默认值，行为与之前完全一致：只允许公网 unicast。`allowlist` 保留 strict 的全部控制——proxy、固定的 DNS 答案、启动限制、协议与内嵌凭据检查——只改变哪些目标能通过准入。`unrestricted` 是旧 `true` 的诚实名字：没有 proxy，没有启动限制。

`allowHosts` 条目按 hostname 精确匹配；以点开头的条目同时匹配该主机及其子域。按名放行的主机连同其解析出的地址一起被放行，并且由于 proxy 会固定它解析到的地址，之后的 DNS 应答无法把已建立的放行改写到别处。`allowCidrs` 放行所有解析结果全部落在所列网段内的主机名。

`denyCidrs` 在任何放行之前求值，并在所有模式下生效，包括 `unrestricted`。这个顺序正是要点：profile 可以为本地开发服务器放行 loopback，同时让元数据端点保持不可达；运维也可以固定一个任何后续放行都无法撤销的拒绝网段。格式错误的 CIDR 会让 Provider 构造失败，而不是让第一个碰巧触及它的请求失败。

`allowPrivateNetwork: true` 仍映射到 `unrestricted`，以便现有 profile 继续工作。把它与相互矛盾的 `network.mode` 一起配置会在加载时失败，而不是悄悄选择其中之一，因为任何一种选择都是运维没有做出的安全决定。

## Alternatives considered

**保留布尔值并另加一个主机列表。** 已否决，因为必须同时读取两者才能知道放行了什么，而典型故障恰恰是 profile 为某个主机打开了布尔值之后再也没有回头检查。

**把白名单放在 Runtime 层。** 已否决，因为准入是在 socket 和 Playwright route 上执行的，两者都归 Provider 所有。Runtime 层的列表只会描述一个 Provider 并不执行的策略。

**只在 proxy 运行时应用 `denyCidrs`。** 已否决，因为拒绝网段最可能是运维真正依赖的那个控制，而在 `unrestricted` 模式下顺便在 Playwright route 上也检查一次几乎没有成本。

**把 `denyCidrs` 默认设为云元数据网段。** 本次改动否决：`strict` 已经拒绝它们，而在 `unrestricted` 模式下给出非空默认值，会悄悄改变从 `allowPrivateNetwork: true` 升级上来的 profile 的行为。启用 `allowlist` 或 `unrestricted` 的运维应当明确写出他们想要的拒绝项。

## Verification

单元测试覆盖精确与后缀主机匹配、CIDR 放行、拒绝网段压过本会覆盖它的放行、`unrestricted` 模式下的拒绝，以及构造时的 CIDR 校验。真实 Chromium 的 observation 与交互套件现在都在 `mode: allowlist` 加 `allowCidrs: [127.0.0.1/32]` 下运行，因此这些浏览器测试全部走 policy proxy 路径而不是绕过它——此前它们是在移除 proxy 的情况下运行的。启动报告会给出模式，并在 allowlist 下给出它放行与拒绝了什么。

## Consequences

访问一个内网主机只需一条条目，而不是整套控制，配置也记录了这个例外是为哪个主机开的。使用 `allowPrivateNetwork` 的 profile 保持原样工作，相互矛盾的组合会显式失败。

`allowlist` 仍然经由应用层 proxy，而不是操作系统网络边界；需要独立边界的部署仍然需要宿主机防火墙或容器网络策略。被放行的主机对该 Agent 访问的每个页面都放行，因为准入以 environment 为单位，而不是以每次导航为单位。
