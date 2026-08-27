/** DNS-aware network admission for the Playwright provider. */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { BrowserProviderPolicyError } from '../runtime/error.ts'

/** Network policy configuration. */
export interface NetworkPolicyConfig {
  readonly allowPrivateNetwork: boolean
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
  constructor(private readonly config: NetworkPolicyConfig) {}

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
    if (!this.config.allowPrivateNetwork
      && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
      throw new BrowserProviderPolicyError(`browser blocked local hostname: ${hostname}`)
    }
    const addresses = [...new Set(isIP(hostname) === 0
      ? await resolveAddresses(hostname)
      : [hostname])]
    if (!this.config.allowPrivateNetwork) {
      for (const address of addresses) {
        if (isPublicAddress(address)) continue
        throw new BrowserProviderPolicyError(`browser blocked non-public address ${address} for ${hostname}`)
      }
    }
    return { url, hostname, addresses }
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
