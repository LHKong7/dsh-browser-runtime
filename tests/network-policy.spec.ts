import { describe, expect, it } from 'vitest'
import { isPublicAddress, NetworkPolicy } from 'dsh-browser-runtime/playwright'
import { routeWebSocketWithNetworkPolicy, routeWithNetworkPolicy } from '../src/provider/network-policy.ts'

describe('Playwright network policy', () => {
  it('classifies public and non-public address ranges', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('127.0.0.1')).toBe(false)
    expect(isPublicAddress('10.0.0.1')).toBe(false)
    expect(isPublicAddress('169.254.1.1')).toBe(false)
    expect(isPublicAddress('::1')).toBe(false)
    expect(isPublicAddress('fc00::1')).toBe(false)
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false)
  })

  it('rejects local hosts and non-HTTP protocols in strict mode', async () => {
    const strict = new NetworkPolicy({ mode: 'strict' })
    await expect(strict.assertAllowed('http://localhost/')).rejects.toThrow(/local hostname/)
    await expect(strict.assertAllowed('http://127.0.0.1/')).rejects.toThrow(/non-public address/)
    await expect(strict.assertAllowed('file:///etc/passwd')).rejects.toThrow(/non-HTTP/)
    await expect(strict.assertAllowed('https://user:pass@example.com/')).rejects.toThrow(/credentials/)

    const local = new NetworkPolicy({ mode: 'unrestricted' })
    await expect(local.assertAllowed('http://127.0.0.1/')).resolves.toBeUndefined()
  })

  it('applies equivalent protocol, credential, and private-address checks to WebSockets', async () => {
    const strict = new NetworkPolicy({ mode: 'strict' })
    await expect(strict.assertWebSocketAllowed('ws://localhost/socket')).rejects.toThrow(/local hostname/)
    await expect(strict.assertWebSocketAllowed('wss://127.0.0.1/socket')).rejects.toThrow(/non-public address/)
    await expect(strict.assertWebSocketAllowed('https://example.com/')).rejects.toThrow(/non-WebSocket/)
    await expect(strict.assertWebSocketAllowed('wss://user:pass@example.com/')).rejects.toThrow(/credentials/)

    const local = new NetworkPolicy({ mode: 'unrestricted' })
    await expect(local.assertWebSocketAllowed('ws://127.0.0.1/socket')).resolves.toBeUndefined()
  })

  it('admits only the named hosts and ranges an allowlist declares', async () => {
    const policy = new NetworkPolicy({
      mode: 'allowlist',
      allowHosts: ['localhost', '.internal.example'],
      allowCidrs: ['10.1.0.0/16'],
      denyCidrs: ['169.254.0.0/16', '10.1.9.0/24'],
    })
    // A named host is admitted even though it resolves to loopback.
    await expect(policy.assertAllowed('http://localhost:8080/')).resolves.toBeUndefined()
    await expect(policy.assertAllowed('http://127.0.0.1:8080/')).rejects.toThrow(/network.allowHosts/)
    // A CIDR allowance covers any address inside it.
    await expect(policy.assertAllowed('http://10.1.2.3/')).resolves.toBeUndefined()
    await expect(policy.assertAllowed('http://10.2.2.3/')).rejects.toThrow(/non-public address/)
    // A deny range wins over an allowance that would otherwise cover it.
    await expect(policy.assertAllowed('http://10.1.9.4/')).rejects.toThrow(/denied address/)
    await expect(policy.assertAllowed('http://169.254.169.254/')).rejects.toThrow(/denied address/)
    // Public destinations remain admitted, and protocol rules still apply.
    await expect(policy.assertAllowed('http://8.8.8.8/')).resolves.toBeUndefined()
    await expect(policy.assertAllowed('file:///etc/passwd')).rejects.toThrow(/non-HTTP/)
    await expect(policy.assertWebSocketAllowed('ws://localhost:8080/socket')).resolves.toBeUndefined()
    await expect(policy.assertWebSocketAllowed('ws://127.0.0.1:8080/socket')).rejects.toThrow(/allowHosts/)
  })

  it('matches a leading-dot allowHosts entry against the host and its subdomains', async () => {
    const policy = new NetworkPolicy({ mode: 'allowlist', allowHosts: ['.internal.example'] })
    // Resolution is what decides admission, so an unresolvable name still fails.
    await expect(policy.assertAllowed('http://internal.example/')).rejects.toThrow(/could not resolve/)
    await expect(policy.assertAllowed('http://dev.internal.example/')).rejects.toThrow(/could not resolve/)
    await expect(policy.assertAllowed('http://other.example/')).rejects.toThrow(/could not resolve/)
  })

  it('applies a deny range even when the mode is unrestricted', async () => {
    const policy = new NetworkPolicy({ mode: 'unrestricted', denyCidrs: ['169.254.0.0/16'] })
    await expect(policy.assertAllowed('http://169.254.169.254/')).rejects.toThrow(/denied address/)
    await expect(policy.assertAllowed('http://127.0.0.1/')).resolves.toBeUndefined()
  })

  it('rejects a malformed CIDR at construction rather than at request time', () => {
    expect(() => new NetworkPolicy({ mode: 'allowlist', allowCidrs: ['10.0.0.1'] }))
      .toThrow(/network.allowCidrs entry is not a CIDR/)
    expect(() => new NetworkPolicy({ mode: 'strict', denyCidrs: ['not-a-range'] }))
      .toThrow(/network.denyCidrs entry is not a CIDR/)
  })

  it('aborts policy denials without absorbing route transport failures', async () => {
    const denied: Error[] = []
    let continued = 0
    let aborted = 0
    await routeWithNetworkPolicy(
      new NetworkPolicy({ mode: 'strict' }),
      {
        url: 'http://127.0.0.1/',
        continue: async () => { continued += 1 },
        abort: async () => { aborted += 1 },
      },
      error => { denied.push(error) },
    )
    expect({ continued, aborted, denied: denied.length }).toEqual({ continued: 0, aborted: 1, denied: 1 })

    const routeFailure = new Error('route transport closed')
    await expect(routeWithNetworkPolicy(
      new NetworkPolicy({ mode: 'unrestricted' }),
      {
        url: 'https://example.com/',
        continue: async () => { throw routeFailure },
        abort: async () => { aborted += 1 },
      },
      error => { denied.push(error) },
    )).rejects.toBe(routeFailure)
    expect({ aborted, denied: denied.length }).toEqual({ aborted: 1, denied: 1 })

    const abortFailure = new Error('route abort closed')
    await expect(routeWithNetworkPolicy(
      new NetworkPolicy({ mode: 'strict' }),
      {
        url: 'http://127.0.0.1/',
        continue: async () => { continued += 1 },
        abort: async () => { throw abortFailure },
      },
      error => { denied.push(error) },
    )).rejects.toBe(abortFailure)
    expect({ continued, denied: denied.length }).toEqual({ continued: 0, denied: 2 })
  })

  it('closes denied WebSockets before connecting and preserves route transport failures', async () => {
    let connected = 0
    let closed = 0
    await routeWebSocketWithNetworkPolicy(
      new NetworkPolicy({ mode: 'strict' }),
      {
        url: 'ws://127.0.0.1/socket',
        connect: () => { connected += 1 },
        close: async () => { closed += 1 },
      },
    )
    expect({ connected, closed }).toEqual({ connected: 0, closed: 1 })

    await routeWebSocketWithNetworkPolicy(
      new NetworkPolicy({ mode: 'unrestricted' }),
      {
        url: 'ws://127.0.0.1/socket',
        connect: () => { connected += 1 },
        close: async () => { closed += 1 },
      },
    )
    expect({ connected, closed }).toEqual({ connected: 1, closed: 1 })

    const closeFailure = new Error('WebSocket route close failed')
    await expect(routeWebSocketWithNetworkPolicy(
      new NetworkPolicy({ mode: 'strict' }),
      {
        url: 'ws://127.0.0.1/socket',
        connect: () => { connected += 1 },
        close: async () => { throw closeFailure },
      },
    )).rejects.toBe(closeFailure)
  })
})
