# Agent Note: Make private-network access an allowlist, not a switch

Status: implemented

English | [中文](2026-08-27-network-allowlist.zh.md)

## Problem

`allowPrivateNetwork` was one boolean, and setting it to `true` did far more than admit one address. It removed the authenticated loopback proxy, and with it the single-resolution DNS pinning that stops the browser from picking a different answer than the one policy approved. It removed the Chromium launch restrictions that disable QUIC and non-proxied WebRTC UDP, reopening WebTransport, HTTP/3, STUN, and TURN as unproxied paths. It admitted every non-public range at once, including link-local `169.254.0.0/16` — the cloud metadata endpoint — for a profile whose actual need was one internal hostname.

So a deployment that wanted an Agent to reach `dev.internal.example` had to pay for it with the entire egress control set, and nothing in the configuration recorded which host the exception was for.

## Decision

Egress is configured as a mode plus lists:

```yaml
network:
  mode: allowlist
  allowHosts: [localhost, .dev.internal.example]
  allowCidrs: [127.0.0.1/32]
  denyCidrs: [169.254.0.0/16]
```

`strict` is the default and behaves exactly as before: public unicast only. `allowlist` keeps every strict control — the proxy, the pinned DNS answer, the launch restrictions, the protocol and embedded-credential checks — and changes only which destinations pass admission. `unrestricted` is the honest name for the old `true`: no proxy, no launch restrictions.

An `allowHosts` entry matches a hostname exactly; a leading dot matches that host and its subdomains. A host admitted by name has its resolved addresses admitted with it, and because the proxy pins the addresses it resolved, a later DNS answer cannot redirect an established allowance. `allowCidrs` admits any hostname whose every resolved address falls inside a listed range.

`denyCidrs` is evaluated before any allowance and applies in every mode, including `unrestricted`. That ordering is the point: a profile can admit loopback for a local development server while keeping the metadata endpoint unreachable, and an operator can pin a deny range that no later allowance can undo. A malformed CIDR fails Provider construction rather than the first request that happens to touch it.

`allowPrivateNetwork: true` still maps to `unrestricted` so existing profiles keep working. Combining it with a contradicting `network.mode` fails at load rather than silently choosing one, because either choice would be a security decision the operator did not make.

## Alternatives considered

**Keep the boolean and add a separate host list.** Rejected because the two would have to be read together to know what is admitted, and the failure mode is a profile that sets the boolean for one host and never revisits it.

**Make the allowlist a Runtime concern.** Rejected because admission is enforced at the socket and at the Playwright route, both of which are Provider-owned. A Runtime-level list would describe a policy the Provider does not apply.

**Apply `denyCidrs` only where the proxy runs.** Rejected because a deny range is the control an operator is most likely to rely on, and it costs nothing to also check it on the Playwright route in `unrestricted` mode.

**Default `denyCidrs` to the cloud metadata ranges.** Rejected for this change: `strict` already rejects them, and a non-empty default in `unrestricted` mode would silently change behaviour for a profile upgrading from `allowPrivateNetwork: true`. Operators enabling `allowlist` or `unrestricted` should state the denials they want.

## Verification

Unit tests cover exact and suffix host matching, CIDR admission, a deny range overriding an allowance that would otherwise cover it, deny in `unrestricted` mode, and CIDR validation at construction. The real-Chromium observation and interaction suites now run under `mode: allowlist` with `allowCidrs: [127.0.0.1/32]`, so every one of those browser tests exercises the policy proxy path rather than bypassing it — previously they ran with the proxy removed. The startup report names the mode and, for an allowlist, what it admits and denies.

## Consequences

Reaching one internal host costs one entry instead of the whole control set, and the configuration records which host the exception is for. Profiles using `allowPrivateNetwork` keep working unchanged, and a contradictory pairing fails loudly.

`allowlist` still routes through an application-level proxy, not an operating-system network boundary; a deployment needing an independent boundary still needs a host firewall or container network policy. An admitted host is admitted for every page the Agent visits, because admission is per environment rather than per navigation.
