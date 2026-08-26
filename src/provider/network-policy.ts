/** DNS-aware network admission for the Playwright provider. */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { BrowserProviderPolicyError } from '../runtime/error.ts'

/** Network policy configuration. */
export interface NetworkPolicyConfig {
  readonly allowPrivateNetwork: boolean
}

/** Validate HTTP(S) destinations and reject local/private address ranges by default. */
export class NetworkPolicy {
  constructor(private readonly config: NetworkPolicyConfig) {}

  /**
   * Validate one navigation or request URL, including every resolved address.
   * @param rawUrl - absolute request URL.
   */
  async assertAllowed(rawUrl: string): Promise<void> {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch (error: unknown) {
      throw new BrowserProviderPolicyError(`browser blocked an invalid URL: ${rawUrl}`, { cause: error })
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BrowserProviderPolicyError(`browser blocked non-HTTP(S) URL: ${rawUrl}`)
    }
    if (url.username !== '' || url.password !== '') {
      throw new BrowserProviderPolicyError('browser blocked a URL containing embedded credentials')
    }
    if (this.config.allowPrivateNetwork) return

    const hostname = stripIpv6Brackets(url.hostname).toLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new BrowserProviderPolicyError(`browser blocked local hostname: ${hostname}`)
    }
    const addresses = isIP(hostname) === 0
      ? await resolveAddresses(hostname)
      : [hostname]
    for (const address of addresses) {
      if (!isPublicAddress(address)) {
        throw new BrowserProviderPolicyError(`browser blocked non-public address ${address} for ${hostname}`)
      }
    }
  }
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
