/** DNS-aware network admission for the Playwright provider. */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { BrowserProviderPolicyError } from '../runtime/error.ts'

/**
 * How much of the address space an environment may reach.
 *
 * `strict` admits only globally routable unicast destinations. `allowlist`
 * keeps that default and adds named hosts and CIDRs, while retaining the policy
 * proxy, DNS pinning, and the Chromium egress restrictions. `unrestricted`
 * removes the proxy and those restrictions entirely and is the only mode where
 * an environment can open an unproxied connection.
 */
export type NetworkPolicyMode = 'strict' | 'allowlist' | 'unrestricted'

/** Network policy configuration. */
export interface NetworkPolicyConfig {
  readonly mode: NetworkPolicyMode
  /**
   * Hostnames admitted even when they resolve outside public unicast. An entry
   * matches exactly; a leading dot matches any subdomain of that suffix.
   */
  readonly allowHosts?: readonly string[]
  /** CIDRs admitted even when they fall outside public unicast. */
  readonly allowCidrs?: readonly string[]
  /** CIDRs rejected in every mode, ahead of any allowance. */
  readonly denyCidrs?: readonly string[]
}

type ParsedCidr = [ipaddr.IPv4 | ipaddr.IPv6, number]

/** Whether an environment routes through the policy proxy in this mode. */
export function usesPolicyProxy(mode: NetworkPolicyMode): boolean {
  return mode !== 'unrestricted'
}

/** Parsed destination with DNS results validated by the network policy. */
export interface ResolvedNetworkTarget {
  readonly url: URL
  readonly hostname: string
  readonly addresses: readonly string[]
}

interface RoutedRequest {
  readonly url: string
  continue(): Promise<void>
  abort(): Promise<void>
}

interface RoutedWebSocket {
  readonly url: string
  connect(): void
  close(): Promise<void>
}

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])
const WEBSOCKET_PROTOCOLS = new Set(['ws:', 'wss:'])

/** Validate HTTP(S) and WebSocket destinations and reject local/private address ranges by default. */
export class NetworkPolicy {
  private readonly allowHosts: readonly string[]
  private readonly allowCidrs: readonly ParsedCidr[]
  private readonly denyCidrs: readonly ParsedCidr[]

  constructor(private readonly config: NetworkPolicyConfig) {
    this.allowHosts = (config.allowHosts ?? []).map(host => host.trim().toLowerCase()).filter(host => host !== '')
    this.allowCidrs = parseCidrs(config.allowCidrs ?? [], 'allowCidrs')
    this.denyCidrs = parseCidrs(config.denyCidrs ?? [], 'denyCidrs')
  }

  /** The configured mode, used by the Provider to decide on proxy and launch controls. */
  get mode(): NetworkPolicyMode {
    return this.config.mode
  }

  /**
   * Validate one navigation or request URL, including every resolved address.
   * @param rawUrl - absolute request URL.
   */
  async assertAllowed(rawUrl: string): Promise<void> {
    await this.resolveAllowed(rawUrl)
  }

  /**
   * Parse and resolve one HTTP(S) URL for a pinned outbound connection.
   * @param rawUrl - absolute request URL.
   * @returns validated URL, hostname, and complete DNS result.
   */
  async resolveAllowed(rawUrl: string): Promise<ResolvedNetworkTarget> {
    return this.resolveProtocolAllowed(rawUrl, HTTP_PROTOCOLS, 'HTTP(S)')
  }

  /**
   * Validate one WebSocket URL, including every resolved address.
   * @param rawUrl - absolute WebSocket URL.
   */
  async assertWebSocketAllowed(rawUrl: string): Promise<void> {
    await this.resolveWebSocketAllowed(rawUrl)
  }

  /**
   * Parse and resolve one WebSocket URL for a pinned outbound connection.
   * @param rawUrl - absolute WebSocket URL.
   * @returns validated URL, hostname, and complete DNS result.
   */
  async resolveWebSocketAllowed(rawUrl: string): Promise<ResolvedNetworkTarget> {
    return this.resolveProtocolAllowed(rawUrl, WEBSOCKET_PROTOCOLS, 'WebSocket')
  }

  private async resolveProtocolAllowed(
    rawUrl: string,
    protocols: ReadonlySet<string>,
    protocolName: string,
  ): Promise<ResolvedNetworkTarget> {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch (error: unknown) {
      throw new BrowserProviderPolicyError(`browser blocked an invalid URL: ${rawUrl}`, { cause: error })
    }
    if (!protocols.has(url.protocol)) {
      throw new BrowserProviderPolicyError(`browser blocked non-${protocolName} URL: ${rawUrl}`)
    }
    if (url.username !== '' || url.password !== '') {
      throw new BrowserProviderPolicyError('browser blocked a URL containing embedded credentials')
    }
    const hostname = stripIpv6Brackets(url.hostname).toLowerCase()
    const hostAllowed = this.allowsHost(hostname)
    if (this.config.mode === 'strict'
      && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
      throw new BrowserProviderPolicyError(`browser blocked local hostname: ${hostname}`)
    }
    if (this.config.mode === 'allowlist' && !hostAllowed
      && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
      throw new BrowserProviderPolicyError(
        `browser blocked local hostname: ${hostname}; add it to network.allowHosts to permit it`,
      )
    }
    const addresses = [...new Set(isIP(hostname) === 0
      ? await resolveAddresses(hostname)
      : [hostname])]
    for (const address of addresses) {
      // A denied range wins in every mode, including an explicitly allowed host.
      if (matchesAny(address, this.denyCidrs)) {
        throw new BrowserProviderPolicyError(`browser blocked denied address ${address} for ${hostname}`)
      }
    }
    if (this.config.mode !== 'unrestricted') {
      for (const address of addresses) {
        if (isPublicAddress(address) || hostAllowed || matchesAny(address, this.allowCidrs)) continue
        throw new BrowserProviderPolicyError(
          this.config.mode === 'allowlist'
            ? `browser blocked non-public address ${address} for ${hostname};`
              + ' add the host to network.allowHosts or the range to network.allowCidrs'
            : `browser blocked non-public address ${address} for ${hostname}`,
        )
      }
    }
    return { url, hostname, addresses }
  }

  private allowsHost(hostname: string): boolean {
    return this.allowHosts.some(entry => (
      entry.startsWith('.') ? hostname === entry.slice(1) || hostname.endsWith(entry) : hostname === entry
    ))
  }
}

/**
 * Apply policy to one routed request without classifying route transport failures as policy denials.
 * @param policy - request admission policy.
 * @param request - routed request operations supplied by the browser provider.
 * @param onDenied - synchronous observer called before the denied request is aborted.
 */
export async function routeWithNetworkPolicy(
  policy: NetworkPolicy,
  request: RoutedRequest,
  onDenied: (error: BrowserProviderPolicyError) => void,
): Promise<void> {
  let denial: BrowserProviderPolicyError | undefined
  try {
    await policy.assertAllowed(request.url)
  } catch (error: unknown) {
    if (!(error instanceof BrowserProviderPolicyError)) throw error
    denial = error
  }
  if (denial !== undefined) {
    onDenied(denial)
    await request.abort()
    return
  }
  await request.continue()
}

/**
 * Apply policy before a routed WebSocket can connect to its server.
 * @param policy - WebSocket admission policy.
 * @param socket - routed WebSocket operations supplied by the browser provider.
 */
export async function routeWebSocketWithNetworkPolicy(
  policy: NetworkPolicy,
  socket: RoutedWebSocket,
): Promise<void> {
  try {
    await policy.assertWebSocketAllowed(socket.url)
  } catch (error: unknown) {
    if (!(error instanceof BrowserProviderPolicyError)) throw error
    await socket.close()
    return
  }
  socket.connect()
}

function parseCidrs(values: readonly string[], field: string): ParsedCidr[] {
  return values.map((value) => {
    try {
      return ipaddr.parseCIDR(value.trim())
    } catch (error: unknown) {
      throw new Error(`browser-playwright: network.${field} entry is not a CIDR: ${value}`, { cause: error })
    }
  })
}

function matchesAny(address: string, cidrs: readonly ParsedCidr[]): boolean {
  if (cidrs.length === 0) return false
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(address)
  } catch {
    return false
  }
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address()
  return cidrs.some((cidr) => {
    const [network] = cidr
    if (network.kind() !== parsed.kind()) return false
    try {
      return parsed.match(cidr as never)
    } catch {
      return false
    }
  })
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  try {
    const results = await lookup(hostname, { all: true, verbatim: true })
    if (results.length === 0) throw new Error('DNS returned no addresses')
    return results.map(result => result.address)
  } catch (error: unknown) {
    throw new BrowserProviderPolicyError(`browser could not resolve ${hostname}`, { cause: error })
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** Whether an IP address belongs to the globally routable unicast range. */
export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(address)
  } catch {
    return false
  }
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address()
  }
  return parsed.range() === 'unicast'
}
