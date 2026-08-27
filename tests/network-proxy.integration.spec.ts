import dgram from 'node:dgram'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, request as createHttpRequest } from 'node:http'
import type { Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { NetworkPolicy } from '../src/provider/network-policy.ts'
import type { ResolvedNetworkTarget } from '../src/provider/network-policy.ts'
import {
  chromiumNetworkArgs,
  NETWORK_PROXY_AUTHENTICATION_URL,
  NetworkPolicyProxy,
} from '../src/provider/network-proxy.ts'
import type { NetworkProxySettings } from '../src/provider/network-proxy.ts'

const hasChromium = existsSync(chromium.executablePath())

describe('authenticated browser policy proxy', () => {
  it('requires per-environment credentials before forwarding HTTP', async () => {
    let targetRequests = 0
    const target = createServer((_request, response) => {
      targetRequests += 1
      response.end('proxied')
    })
    await listen(target)
    const proxy = new NetworkPolicyProxy(new NetworkPolicy({ allowPrivateNetwork: true }))
    const settings = await proxy.listen(new AbortController().signal)
    const targetUrl = `http://127.0.0.1:${portOf(target)}/resource`
    try {
      await expect(proxyRequest(settings, targetUrl, false)).resolves.toMatchObject({ status: 407 })
      expect(targetRequests).toBe(0)
      await expect(proxyRequest(settings, targetUrl, true)).resolves.toEqual({ status: 200, body: 'proxied' })
      expect(targetRequests).toBe(1)
    } finally {
      await proxy.close()
      await closeServer(target)
    }
  })

  it('rejects a private HTTP target before opening its server connection', async () => {
    let targetRequests = 0
    const target = createServer((_request, response) => {
      targetRequests += 1
      response.end('unexpected')
    })
    await listen(target)
    const proxy = new NetworkPolicyProxy(new NetworkPolicy({ allowPrivateNetwork: false }))
    const settings = await proxy.listen(new AbortController().signal)
    try {
      const result = await proxyRequest(settings, `http://127.0.0.1:${portOf(target)}/`, true)
      expect(result.status).toBe(403)
      expect(targetRequests).toBe(0)
    } finally {
      await proxy.close()
      await closeServer(target)
    }
  })

  it('forwards authenticated CONNECT only when the target is admitted', async () => {
    let targetConnections = 0
    const target = createTcpServer(socket => {
      targetConnections += 1
      socket.destroy()
    })
    await listen(target)
    const targetAuthority = `127.0.0.1:${portOf(target)}`
    const allowedProxy = new NetworkPolicyProxy(new NetworkPolicy({ allowPrivateNetwork: true }))
    const allowedSettings = await allowedProxy.listen(new AbortController().signal)
    try {
      await expect(proxyConnect(allowedSettings, targetAuthority)).resolves.toBe(200)
      expect(targetConnections).toBe(1)
    } finally {
      await allowedProxy.close()
    }

    targetConnections = 0
    const strictProxy = new NetworkPolicyProxy(new NetworkPolicy({ allowPrivateNetwork: false }))
    const strictSettings = await strictProxy.listen(new AbortController().signal)
    try {
      await expect(proxyConnect(strictSettings, targetAuthority)).resolves.toBe(403)
      expect(targetConnections).toBe(0)
    } finally {
      await strictProxy.close()
      await closeServer(target)
    }
  })

  it('cannot open an upstream connection after close wins pending resolution', async () => {
    let targetRequests = 0
    const target = createServer((_request, response) => {
      targetRequests += 1
      response.end('unexpected')
    })
    await listen(target)
    let announceResolution = () => {}
    const resolutionStarted = new Promise<void>(resolve => { announceResolution = resolve })
    let releaseResolution = () => {}
    const resolutionBarrier = new Promise<void>(resolve => { releaseResolution = resolve })
    class DelayedPolicy extends NetworkPolicy {
      override async resolveAllowed(rawUrl: string): Promise<ResolvedNetworkTarget> {
        announceResolution()
        await resolutionBarrier
        return {
          url: new URL(rawUrl),
          hostname: '127.0.0.1',
          addresses: ['127.0.0.1'],
        }
      }
    }
    const proxy = new NetworkPolicyProxy(new DelayedPolicy({ allowPrivateNetwork: true }))
    const settings = await proxy.listen(new AbortController().signal)
    const request = proxyRequest(settings, `http://127.0.0.1:${portOf(target)}/`, true)
      .then(() => 'fulfilled' as const, () => 'rejected' as const)
    await resolutionStarted
    await proxy.close()
    releaseResolution()

    await expect(request).resolves.toBe('rejected')
    expect(targetRequests).toBe(0)
    await closeServer(target)
  })

  it('does not contact an upstream after its browser client disconnects during resolution', async () => {
    let targetConnections = 0
    const target = createServer((_request, response) => { response.end('unexpected') })
    target.on('connection', () => { targetConnections += 1 })
    await listen(target)
    let announceResolution = () => {}
    const resolutionStarted = new Promise<void>(resolve => { announceResolution = resolve })
    let releaseResolution = () => {}
    const resolutionBarrier = new Promise<void>(resolve => { releaseResolution = resolve })
    class DelayedPolicy extends NetworkPolicy {
      override async resolveAllowed(rawUrl: string): Promise<ResolvedNetworkTarget> {
        announceResolution()
        await resolutionBarrier
        return mappedTarget(rawUrl)
      }
    }
    const proxy = new NetworkPolicyProxy(new DelayedPolicy({ allowPrivateNetwork: true }))
    const settings = await proxy.listen(new AbortController().signal)
    const proxyUrl = new URL(settings.server)
    const client = createHttpRequest({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port),
      path: `http://dsh-proxy.invalid:${portOf(target)}/`,
      method: 'GET',
      headers: {
        'proxy-authorization': `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`,
      },
    })
    const closed = new Promise<void>(resolve => { client.once('close', resolve) })
    client.on('error', () => {})
    client.end()
    await resolutionStarted
    client.destroy()
    await closed
    await delay(20)
    releaseResolution()
    await delay(20)

    expect(targetConnections).toBe(0)
    await proxy.close()
    await closeServer(target)
  })
})

describe.skipIf(!hasChromium)('Chromium browser egress policy modes', () => {
  it('uses proxy authentication and pinned addresses for browser HTTP traffic', async () => {
    let httpRequests = 0
    const target = createServer((_request, response) => {
      httpRequests += 1
      response.end('<!doctype html><title>Proxy target</title>')
    })
    await listen(target)
    const proxy = new NetworkPolicyProxy(new MappedPolicy({ allowPrivateNetwork: false }))
    const settings = await proxy.listen(new AbortController().signal)
    const browser = await chromium.launch({
      headless: true,
      proxy: settings,
      args: [...chromiumNetworkArgs(false)],
    })
    const origin = `http://dsh-proxy.invalid:${portOf(target)}`
    try {
      const page = await browser.newPage()
      const navigation = await page.goto(origin, { timeout: 5_000 })
      expect({
        httpRequests,
        status: navigation?.status(),
        title: await page.title(),
      }).toEqual({ httpRequests: 1, status: 200, title: 'Proxy target' })
    } finally {
      await proxy.close()
      await browser.close()
      await closeServer(target)
    }
  })

  it('uses proxy authentication and pinned addresses for browser WebSocket traffic', { timeout: 10_000 }, async () => {
    let upgrades = 0
    let policyCalls = 0
    const target = createServer()
    target.on('upgrade', (request, socket) => {
      upgrades += 1
      acceptWebSocket(request.headers['sec-websocket-key'], socket)
    })
    await listen(target)
    class CountingPolicy extends MappedPolicy {
      override async resolveWebSocketAllowed(rawUrl: string): Promise<ResolvedNetworkTarget> {
        policyCalls += 1
        return super.resolveWebSocketAllowed(rawUrl)
      }
    }
    const proxy = new NetworkPolicyProxy(new CountingPolicy({ allowPrivateNetwork: false }))
    const settings = await proxy.listen(new AbortController().signal)
    const browser = await chromium.launch({
      headless: true,
      proxy: settings,
      args: [...chromiumNetworkArgs(false)],
    })
    try {
      const page = await browser.newPage()
      const authentication = await page.goto(NETWORK_PROXY_AUTHENTICATION_URL)
      expect(authentication?.status()).toBe(200)
      const socketOpened = page.evaluate(async (url) => {
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(url)
          socket.addEventListener('open', () => { resolve() }, { once: true })
          socket.addEventListener('error', () => { reject(new Error('proxied WebSocket failed')) }, { once: true })
        })
      }, `ws://dsh-proxy.invalid:${portOf(target)}/socket`)
      try {
        await Promise.race([
          socketOpened,
          delay(5_000).then(() => { throw new Error('proxied WebSocket timed out') }),
        ])
      } catch (error: unknown) {
        throw new Error(
          `proxied WebSocket failed after ${policyCalls} policy calls and ${upgrades} target upgrades`,
          { cause: error },
        )
      }
      expect(upgrades).toBe(1)
    } finally {
      await proxy.close()
      await browser.close()
      await closeServer(target)
    }
  })

  it('allows explicit private WebRTC but blocks strict-mode STUN and TURN', { timeout: 20_000 }, async () => {
    expect(chromiumNetworkArgs(false)).toEqual([
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ])
    expect(chromiumNetworkArgs(true)).toEqual([])

    const allowed = await webRtcProbe(true)
    expect(allowed.udpPackets).toBeGreaterThan(0)

    const denied = await webRtcProbe(false)
    expect(denied).toEqual({ udpPackets: 0, tcpConnections: 0 })
  })

  it('allows explicit WebTransport QUIC but blocks it in strict mode', { timeout: 20_000 }, async () => {
    const allowed = await webTransportProbe(true)
    expect(allowed).toMatchObject({
      secureContext: true,
      webTransport: true,
      tcpSocket: false,
      udpSocket: false,
    })
    expect(allowed.udpPackets).toBeGreaterThan(0)

    const denied = await webTransportProbe(false)
    expect(denied).toEqual({
      udpPackets: 0,
      secureContext: true,
      webTransport: true,
      tcpSocket: false,
      udpSocket: false,
    })
  })
})

async function proxyRequest(
  settings: NetworkProxySettings,
  targetUrl: string,
  authenticate: boolean,
): Promise<{ status: number; body: string }> {
  const proxyUrl = new URL(settings.server)
  return new Promise((resolve, reject) => {
    const request = createHttpRequest({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port),
      path: targetUrl,
      method: 'GET',
      headers: authenticate
        ? { 'proxy-authorization': `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}` }
        : {},
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.once('error', reject)
    request.end()
  })
}

async function proxyConnect(settings: NetworkProxySettings, authority: string): Promise<number> {
  const proxyUrl = new URL(settings.server)
  return new Promise((resolve, reject) => {
    const request = createHttpRequest({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port),
      method: 'CONNECT',
      path: authority,
      headers: {
        'proxy-authorization': `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`,
      },
    })
    request.once('connect', (response, socket: Socket) => {
      const status = response.statusCode ?? 0
      socket.destroy()
      resolve(status)
    })
    request.once('response', (response) => {
      response.resume()
      response.once('end', () => { resolve(response.statusCode ?? 0) })
    })
    request.once('error', reject)
    request.end()
  })
}

async function webRtcProbe(allowPrivateNetwork: boolean): Promise<{
  udpPackets: number
  tcpConnections: number
}> {
  const udpServer = dgram.createSocket('udp4')
  let udpPackets = 0
  udpServer.on('message', () => { udpPackets += 1 })
  await new Promise<void>((resolve, reject) => {
    udpServer.once('error', reject)
    udpServer.bind(0, '127.0.0.1', resolve)
  })
  let tcpConnections = 0
  const tcpServer = createTcpServer(socket => {
    tcpConnections += 1
    socket.destroy()
  })
  await listen(tcpServer)
  const proxy = allowPrivateNetwork
    ? undefined
    : new NetworkPolicyProxy(new NetworkPolicy({ allowPrivateNetwork: false }))
  const settings = await proxy?.listen(new AbortController().signal)
  const browser = await chromium.launch({
    headless: true,
    ...(settings === undefined ? {} : { proxy: settings }),
    args: [...chromiumNetworkArgs(allowPrivateNetwork)],
  })
  try {
    const page = await browser.newPage()
    await page.evaluate(async ({ udpPort, tcpPort }) => {
      const udpPeer = new RTCPeerConnection({
        iceServers: [{ urls: `stun:127.0.0.1:${udpPort}` }],
        iceCandidatePoolSize: 1,
      })
      udpPeer.createDataChannel('udp-probe')
      await udpPeer.setLocalDescription(await udpPeer.createOffer())
      const tcpPeer = new RTCPeerConnection({
        iceServers: [{
          urls: `turn:127.0.0.1:${tcpPort}?transport=tcp`,
          username: 'probe',
          credential: 'probe',
        }],
        iceCandidatePoolSize: 1,
      })
      tcpPeer.createDataChannel('tcp-probe')
      await tcpPeer.setLocalDescription(await tcpPeer.createOffer())
      await new Promise(resolve => setTimeout(resolve, 1_000))
      udpPeer.close()
      tcpPeer.close()
    }, {
      udpPort: (udpServer.address() as AddressInfo).port,
      tcpPort: portOf(tcpServer),
    })
  } finally {
    await proxy?.close()
    await browser.close()
    await closeServer(tcpServer)
    await new Promise<void>(resolve => { udpServer.close(resolve) })
  }
  return { udpPackets, tcpConnections }
}

async function webTransportProbe(allowPrivateNetwork: boolean): Promise<{
  udpPackets: number
  secureContext: boolean
  webTransport: boolean
  tcpSocket: boolean
  udpSocket: boolean
}> {
  const udpServer = dgram.createSocket('udp4')
  let udpPackets = 0
  udpServer.on('message', () => { udpPackets += 1 })
  await new Promise<void>((resolve, reject) => {
    udpServer.once('error', reject)
    udpServer.bind(0, '127.0.0.1', resolve)
  })
  const pageServer = createServer((_request, response) => {
    response.end('<!doctype html><title>WebTransport probe</title>')
  })
  await listen(pageServer)
  const origin = `http://127.0.0.1:${portOf(pageServer)}`
  const proxy = allowPrivateNetwork
    ? undefined
    : new NetworkPolicyProxy(new MappedPolicy({ allowPrivateNetwork: false }))
  const settings = await proxy?.listen(new AbortController().signal)
  const browser = await chromium.launch({
    headless: true,
    ...(settings === undefined ? {} : { proxy: settings }),
    args: [...chromiumNetworkArgs(allowPrivateNetwork)],
  })
  try {
    const page = await browser.newPage()
    await page.goto(origin)
    const capabilities = await page.evaluate(async (url) => {
      const webTransport = typeof WebTransport === 'function'
      if (webTransport) {
        try {
          const transport = new WebTransport(url)
          void transport.ready.catch(() => {
            // The probe measures emitted UDP rather than handshake success.
          })
          void transport.closed.catch(() => {
            // The probe measures emitted UDP rather than connection lifetime.
          })
          await new Promise(resolve => setTimeout(resolve, 1_000))
          transport.close()
        } catch {
          // Endpoint and transport-policy failures are expected; only outbound UDP is measured.
        }
      }
      return {
        secureContext: globalThis.isSecureContext,
        webTransport,
        tcpSocket: Reflect.has(globalThis, 'TCPSocket'),
        udpSocket: Reflect.has(globalThis, 'UDPSocket'),
      }
    }, `https://127.0.0.1:${(udpServer.address() as AddressInfo).port}/probe`)
    return { udpPackets, ...capabilities }
  } finally {
    await proxy?.close()
    await browser.close()
    await closeServer(pageServer)
    await new Promise<void>(resolve => { udpServer.close(resolve) })
  }
}

function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function portOf(server: Server | ReturnType<typeof createTcpServer>): number {
  return (server.address() as AddressInfo).port
}

function closeServer(server: Server | ReturnType<typeof createTcpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })
}

function mappedTarget(rawUrl: string): ResolvedNetworkTarget {
  const url = new URL(rawUrl)
  return { url, hostname: url.hostname, addresses: ['127.0.0.1'] }
}

class MappedPolicy extends NetworkPolicy {
  override async resolveAllowed(rawUrl: string): Promise<ResolvedNetworkTarget> {
    return mappedTarget(rawUrl)
  }

  override async resolveWebSocketAllowed(rawUrl: string): Promise<ResolvedNetworkTarget> {
    return mappedTarget(rawUrl)
  }
}

function acceptWebSocket(key: string | string[] | undefined, socket: Duplex): void {
  if (typeof key !== 'string') {
    socket.destroy()
    return
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'))
  setTimeout(() => { socket.end() }, 20)
}
