# Agent Note: Enforce policy across browser egress

Status: implemented

English | [中文](2026-08-27-browser-egress-policy.zh.md)

## Problem

Playwright HTTP request routing does not control every connection a page can create. WebSocket uses a separate routing lifecycle, WebRTC ICE can send UDP or open TURN over TCP, and WebTransport uses QUIC. A page admitted through the HTTP(S) policy could therefore contact loopback, private, link-local, reserved, or multicast destinations through another transport.

Resolving a hostname during route admission and allowing Chromium to resolve it again also left an interval in which DNS rebinding could select an address that the policy had not validated.

## Decision

Each strict Playwright environment owns an HTTP proxy on an ephemeral IPv4 loopback port with random per-environment Basic credentials. Chromium sends HTTP, HTTPS, WebSocket, and proxied WebRTC TCP traffic through that proxy. Before installing page routes, the Provider opens a temporary page against an empty document served by the proxy itself. This request establishes Chromium's proxy-authentication cache without contacting an upstream server, which is required because an initial `ws:` connection does not retry a proxy authentication challenge.

The proxy parses each destination, rejects embedded credentials, resolves its hostname once, requires every returned address to satisfy the configured address policy, and opens the upstream socket with only those validated addresses. A one-use HTTP Agent binds the forwarded request to that already-connected socket; request-level `createConnection` options do not provide that guarantee. Chromium and Node's HTTP client do not resolve the proxied destination again.

The default policy launches Chromium with QUIC disabled and non-proxied WebRTC UDP disabled. WebTransport and HTTP/3 therefore cannot create a direct QUIC path, while HTTPS fallback remains available. WebRTC may use a public TURN endpoint over the authenticated proxy. `allowPrivateNetwork` omits the proxy and both launch restrictions, allowing direct HTTP, WebSocket, UDP, and QUIC access to private and public destinations. Request and WebSocket routes continue to reject unsupported protocols and embedded URL credentials.

The context-wide WebSocket route remains registered before page creation. It applies the same URL policy before `connectToServer()`, closes a denied route with policy code `1008`, and preserves action attribution. In strict mode, the proxy is the connection enforcement point and repeats admission with pinned DNS results.

Proxy shutdown stops admission before destroying browser and upstream sockets, and Provider teardown closes the proxy before its BrowserContext and browser. A DNS operation that finishes after proxy shutdown or an observed browser-client abort cannot create a new upstream connection. The Provider uses Playwright-managed Chromium and pins Playwright `1.62.1`, so the browser behavior under these launch controls is part of the tested implementation.

## Alternatives considered

**Use Playwright request routing as the only network control.** Rejected because it does not own WebSocket, WebRTC, WebTransport, or the browser's second DNS lookup.

**Rely on Chromium IP-handling or Local Network Access settings.** Rejected because live Chromium probes still reached private STUN over UDP or TURN over TCP under the available settings.

**Hide browser APIs with an initialization script.** Rejected because page script mutation is not a network control and does not cover browser-internal or future transport paths.

**Run an unauthenticated loopback proxy.** Rejected because another local process could use it as an admitted outbound relay.

**Assume Chromium applies configured proxy credentials to an initial WebSocket.** Rejected because a real browser probe received the proxy challenge but did not retry it. A preceding authenticated HTTP exchange makes those credentials available to WebSocket connections in the same BrowserContext.

**Accept an arbitrary Chromium executable.** Rejected because another version or Chromium-derived browser could interpret the security launch controls differently from the browser exercised by integration tests.

## Verification

Policy tests cover protocols, credentials, private addresses, allowed connections, denial closure, and closure failure propagation. Proxy integration tests require authentication for HTTP, exercise admitted and denied CONNECT tunnels, and prove that proxy shutdown and an observed client abort win against pending DNS resolution. Real Chromium tests map a reserved `.invalid` hostname to a loopback test server only inside the policy result, then require HTTP and WebSocket to reach that server through the authenticated proxy. This proves the actual request uses the pinned address instead of another DNS lookup. Further probes observe private STUN UDP and WebTransport QUIC when private access is enabled; strict mode must produce zero STUN packets, zero private TURN TCP connections, and zero WebTransport UDP packets. The same secure page confirms that Direct Sockets APIs are unavailable outside an Isolated Web App.

## Consequences

The default Provider gives up direct QUIC and WebRTC UDP. A WebRTC stack that cannot answer proxy authentication may also fail to use TURN over TCP. Public HTTP(S), WebSocket, and compatible proxied TCP traffic remain available.

In strict mode, HTTP(S), WebSocket, and proxied TCP connections use one DNS result set for both policy admission and socket creation. `allowPrivateNetwork` is an explicit opt-in to direct browser networking and therefore does not provide proxy-level address filtering or DNS pinning. The Provider requires Playwright-managed Chromium rather than a caller-supplied executable.

Strict environment setup performs one proxy-owned empty-document request before creating the page exposed to the Runtime. Strict environment teardown closes proxy admission and sockets before waiting for browser cleanup.
