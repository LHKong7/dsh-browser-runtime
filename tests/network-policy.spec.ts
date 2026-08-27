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

  it('rejects local hosts and non-HTTP protocols unless private access is enabled', async () => {
    const strict = new NetworkPolicy({ allowPrivateNetwork: false })
    await expect(strict.assertAllowed('http://localhost/')).rejects.toThrow(/local hostname/)
    await expect(strict.assertAllowed('http://127.0.0.1/')).rejects.toThrow(/non-public address/)
    await expect(strict.assertAllowed('file:///etc/passwd')).rejects.toThrow(/non-HTTP/)
    await expect(strict.assertAllowed('https://user:pass@example.com/')).rejects.toThrow(/credentials/)

    const local = new NetworkPolicy({ allowPrivateNetwork: true })
    await expect(local.assertAllowed('http://127.0.0.1/')).resolves.toBeUndefined()
  })

  it('applies equivalent protocol, credential, and private-address checks to WebSockets', async () => {
    const strict = new NetworkPolicy({ allowPrivateNetwork: false })
    await expect(strict.assertWebSocketAllowed('ws://localhost/socket')).rejects.toThrow(/local hostname/)
    await expect(strict.assertWebSocketAllowed('wss://127.0.0.1/socket')).rejects.toThrow(/non-public address/)
    await expect(strict.assertWebSocketAllowed('https://example.com/')).rejects.toThrow(/non-WebSocket/)
    await expect(strict.assertWebSocketAllowed('wss://user:pass@example.com/')).rejects.toThrow(/credentials/)

    const local = new NetworkPolicy({ allowPrivateNetwork: true })
    await expect(local.assertWebSocketAllowed('ws://127.0.0.1/socket')).resolves.toBeUndefined()
  })

  it('aborts policy denials without absorbing route transport failures', async () => {
    const denied: Error[] = []
    let continued = 0
    let aborted = 0
    await routeWithNetworkPolicy(
      new NetworkPolicy({ allowPrivateNetwork: false }),
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
      new NetworkPolicy({ allowPrivateNetwork: true }),
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
      new NetworkPolicy({ allowPrivateNetwork: false }),
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
      new NetworkPolicy({ allowPrivateNetwork: false }),
      {
        url: 'ws://127.0.0.1/socket',
        connect: () => { connected += 1 },
        close: async () => { closed += 1 },
      },
    )
    expect({ connected, closed }).toEqual({ connected: 0, closed: 1 })

    await routeWebSocketWithNetworkPolicy(
      new NetworkPolicy({ allowPrivateNetwork: true }),
      {
        url: 'ws://127.0.0.1/socket',
        connect: () => { connected += 1 },
        close: async () => { closed += 1 },
      },
    )
    expect({ connected, closed }).toEqual({ connected: 1, closed: 1 })

    const closeFailure = new Error('WebSocket route close failed')
    await expect(routeWebSocketWithNetworkPolicy(
      new NetworkPolicy({ allowPrivateNetwork: false }),
      {
        url: 'ws://127.0.0.1/socket',
        connect: () => { connected += 1 },
        close: async () => { throw closeFailure },
      },
    )).rejects.toBe(closeFailure)
  })
})
