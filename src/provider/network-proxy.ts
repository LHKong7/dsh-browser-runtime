/** Authenticated loopback proxy that pins every browser connection to policy-validated DNS results. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { Agent, createServer, request as createHttpRequest } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import { connect as connectSocket, isIP } from 'node:net'
import type { AddressInfo, LookupFunction, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { BrowserProviderPolicyError } from '../runtime/error.ts'
import { NetworkPolicy } from './network-policy.ts'
import type { NetworkPolicyMode, ResolvedNetworkTarget } from './network-policy.ts'

/** Browser launch proxy settings with per-environment credentials. */
export interface NetworkProxySettings {
  readonly server: string
  readonly username: string
  readonly password: string
}

const PROXY_AUTH_REALM = 'dsh-browser-runtime'
/** Internal empty document used to establish Chromium's proxy-authentication cache. */
export const NETWORK_PROXY_AUTHENTICATION_URL = 'http://dsh-browser-runtime.invalid/.proxy-authentication'
const STRICT_NETWORK_ARGS = [
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
] as const

/**
 * Return fixed Chromium egress controls for the configured egress mode.
 * @param allowPrivateNetwork - explicit opt-in to direct private UDP and QUIC.
 * @returns launch arguments owned by the policy proxy design.
 */
export function chromiumNetworkArgs(mode: NetworkPolicyMode): readonly string[] {
  return mode === 'unrestricted' ? [] : STRICT_NETWORK_ARGS
}

/** One owner-only HTTP proxy for browser HTTP, HTTPS, WebSocket, and proxied WebRTC traffic. */
export class NetworkPolicyProxy {
  private readonly server: Server
  private readonly sockets = new Set<Duplex>()
  private readonly username = `dsh-${randomBytes(12).toString('base64url')}`
  private readonly password = randomBytes(24).toString('base64url')
  private closePromise: Promise<void> | undefined
  private accepting = true

  constructor(private readonly policy: NetworkPolicy) {
    this.server = createServer((request, response) => {
      void this.handleHttpRequest(request, response)
    })
    this.server.on('connect', (request, socket, head) => {
      this.track(socket)
      void this.handleConnect(request, socket, head)
    })
    this.server.on('upgrade', (request, socket, head) => {
      this.track(socket)
      void this.handleUpgrade(request, socket, head)
    })
    this.server.on('connection', socket => { this.track(socket) })
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      else socket.destroy()
    })
  }

  /**
   * Bind the proxy to an ephemeral IPv4 loopback port.
   * @param signal - environment setup cancellation.
   * @returns authenticated settings for `chromium.launch()`.
   */
  async listen(signal: AbortSignal): Promise<NetworkProxySettings> {
    this.assertOpen()
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.server.removeListener('error', onError)
        this.server.removeListener('listening', onListening)
        signal.removeEventListener('abort', onAbort)
      }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const onListening = () => { cleanup(); resolve() }
      const onAbort = () => {
        cleanup()
        this.server.close(() => {})
        try {
          signal.throwIfAborted()
        } catch (error: unknown) {
          reject(error)
        }
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      signal.addEventListener('abort', onAbort, { once: true })
      this.server.listen(0, '127.0.0.1')
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('browser policy proxy did not bind an IP socket')
    }
    return {
      server: `http://127.0.0.1:${(address as AddressInfo).port}`,
      username: this.username,
      password: this.password,
    }
  }

  /** Close admission and destroy every client and upstream socket. */
  close(): Promise<void> {
    this.closePromise ??= this.closeNow()
    return this.closePromise
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorized(request)) {
      rejectProxyAuthentication(response)
      return
    }
    if (request.url === NETWORK_PROXY_AUTHENTICATION_URL) {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': '0',
        'content-type': 'text/html; charset=utf-8',
      })
      response.end()
      return
    }
    let openingSocket: Socket | undefined
    try {
      if (request.url === undefined) throw new Error('proxy request URL is missing')
      const target = await this.policy.resolveAllowed(request.url)
      this.assertRequestOpen(request, request.socket)
      if (target.url.protocol !== 'http:') {
        throw new BrowserProviderPolicyError('browser proxy requires CONNECT for HTTPS destinations')
      }
      const port = target.url.port === '' ? 80 : parsePort(target.url.port)
      openingSocket = await this.openPinnedSocket(target, port, request, request.socket)
      const upstreamSocket = openingSocket
      const upstream = createHttpRequest({
        host: target.hostname,
        port,
        method: request.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers: forwardRequestHeaders(request.headers, target.url.host, false),
        agent: pinnedAgent(upstreamSocket),
      })
      upstream.on('socket', socket => { this.track(socket) })
      upstream.on('response', upstreamResponse => {
        const headers = stripHopByHopHeaders(upstreamResponse.headers)
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage ?? 'Bad Gateway',
          headers,
        )
        upstreamResponse.pipe(response)
      })
      upstream.on('error', error => { rejectHttpFailure(response, error) })
      request.on('aborted', () => { upstream.destroy() })
      request.pipe(upstream)
      openingSocket = undefined
    } catch (error: unknown) {
      openingSocket?.destroy()
      rejectHttpFailure(response, error)
    }
  }

  private async handleConnect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (!this.authorized(request)) {
      rejectRawProxyAuthentication(client)
      return
    }
    let openingSocket: Socket | undefined
    try {
      if (request.url === undefined) throw new Error('proxy CONNECT authority is missing')
      const target = await this.policy.resolveAllowed(connectAuthorityUrl(request.url))
      this.assertRequestOpen(request, client)
      openingSocket = await this.openPinnedSocket(
        target,
        target.url.port === '' ? 443 : parsePort(target.url.port),
        request,
        client,
      )
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) openingSocket.write(head)
      pipeTunnel(client, openingSocket)
      openingSocket = undefined
    } catch (error: unknown) {
      openingSocket?.destroy()
      rejectRawFailure(client, error)
    }
  }

  private async handleUpgrade(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (!this.authorized(request)) {
      rejectRawProxyAuthentication(client)
      return
    }
    let openingSocket: Socket | undefined
    try {
      if (request.url === undefined) throw new Error('proxy WebSocket URL is missing')
      const target = await this.policy.resolveWebSocketAllowed(webSocketProxyUrl(request.url))
      this.assertRequestOpen(request, client)
      if (target.url.protocol !== 'ws:') {
        throw new BrowserProviderPolicyError('secure WebSockets require a CONNECT tunnel')
      }
      const port = target.url.port === '' ? 80 : parsePort(target.url.port)
      openingSocket = await this.openPinnedSocket(target, port, request, client)
      const upstreamSocket = openingSocket
      const upstream = createHttpRequest({
        host: target.hostname,
        port,
        method: request.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers: forwardRequestHeaders(request.headers, target.url.host, true),
        agent: pinnedAgent(upstreamSocket),
      })
      upstream.on('socket', socket => { this.track(socket) })
      upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
        this.track(upstreamSocket)
        writeRawResponseHead(client, upstreamResponse)
        if (upstreamHead.length > 0) client.write(upstreamHead)
        pipeTunnel(client, upstreamSocket)
      })
      upstream.on('response', upstreamResponse => {
        writeRawResponseHead(client, upstreamResponse)
        upstreamResponse.pipe(client)
      })
      upstream.on('error', error => { rejectRawFailure(client, error) })
      request.on('aborted', () => { upstream.destroy() })
      if (head.length > 0) upstream.write(head)
      upstream.end()
      openingSocket = undefined
    } catch (error: unknown) {
      openingSocket?.destroy()
      rejectRawFailure(client, error)
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const actual = request.headers['proxy-authorization']
    if (typeof actual !== 'string') return false
    const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`
    const actualBuffer = Buffer.from(actual)
    const expectedBuffer = Buffer.from(expected)
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  }

  private openPinnedSocket(
    target: ResolvedNetworkTarget,
    port: number,
    request: IncomingMessage,
    client: Duplex,
  ): Promise<Socket> {
    this.assertRequestOpen(request, client)
    return new Promise((resolve, reject) => {
      const socket = connectSocket({
        host: target.hostname,
        port,
        lookup: pinnedLookup(target),
        autoSelectFamily: true,
      })
      this.track(socket)
      const onConnect = () => { cleanup(); resolve(socket) }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const onClose = () => {
        cleanup()
        reject(new Error('browser policy proxy closed before the upstream connection opened'))
      }
      const onClientClose = () => {
        cleanup()
        socket.destroy()
        reject(new Error('browser policy proxy client closed before the upstream connection opened'))
      }
      const onRequestAborted = () => {
        cleanup()
        socket.destroy()
        reject(new Error('browser policy proxy request ended before the upstream connection opened'))
      }
      const cleanup = () => {
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
        client.removeListener('close', onClientClose)
        request.removeListener('aborted', onRequestAborted)
      }
      socket.once('connect', onConnect)
      socket.once('error', onError)
      socket.once('close', onClose)
      client.once('close', onClientClose)
      request.once('aborted', onRequestAborted)
    })
  }

  private track(socket: Duplex): void {
    if (!this.accepting) {
      socket.destroy()
      return
    }
    if (this.sockets.has(socket)) return
    this.sockets.add(socket)
    socket.once('close', () => { this.sockets.delete(socket) })
    socket.on('error', () => {
      // The owning HTTP request or tunnel reports socket failure to its browser peer.
    })
  }

  private async closeNow(): Promise<void> {
    this.accepting = false
    for (const socket of this.sockets) socket.destroy()
    if (!this.server.listening) return
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => { if (error === undefined) resolve(); else reject(error) })
    })
  }

  private assertOpen(): void {
    if (!this.accepting) throw new Error('browser policy proxy is closing')
  }

  private assertClientOpen(client: Duplex): void {
    this.assertOpen()
    if (client.destroyed || !client.writable) throw new Error('browser policy proxy client is closed')
  }

  private assertRequestOpen(request: IncomingMessage, client: Duplex): void {
    this.assertClientOpen(client)
    if (request.aborted) throw new Error('browser policy proxy request is closed')
  }
}

function pinnedLookup(target: ResolvedNetworkTarget): LookupFunction {
  const addresses: LookupAddress[] = target.addresses.map(address => ({
    address,
    family: isIP(address),
  }))
  if (addresses.some(address => address.family !== 4 && address.family !== 6) || addresses.length === 0) {
    throw new Error(`browser policy resolved an invalid address for ${target.hostname}`)
  }
  return (_hostname, options, callback) => {
    const candidates = options.family === 4 || options.family === 6
      ? addresses.filter(address => address.family === options.family)
      : addresses
    if (options.all) {
      callback(null, candidates)
      return
    }
    const selected = candidates[0]
    if (selected === undefined) {
      const error = Object.assign(new Error(`no validated address for ${target.hostname}`), { code: 'ENOTFOUND' })
      callback(error, '', 0)
      return
    }
    callback(null, selected.address, selected.family)
  }
}

function pinnedAgent(socket: Socket): Agent {
  const agent = new Agent({ keepAlive: false })
  agent.createConnection = () => socket
  return agent
}

function parsePort(rawPort: string): number {
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid proxy target port: ${rawPort}`)
  return port
}

function connectAuthorityUrl(authority: string): string {
  return new URL(`https://${authority}/`).href
}

function webSocketProxyUrl(rawUrl: string): string {
  const url = new URL(rawUrl)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  return url.href
}

function forwardRequestHeaders(
  source: IncomingHttpHeaders,
  host: string,
  preserveUpgrade: boolean,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...source, host }
  delete headers['proxy-authorization']
  delete headers['proxy-connection']
  if (!preserveUpgrade) return stripHopByHopHeaders(headers)
  return headers
}

function stripHopByHopHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...source }
  const connection = headers.connection
  if (typeof connection === 'string') {
    for (const token of connection.split(',')) delete headers[token.trim().toLowerCase()]
  }
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
    delete headers[name]
  }
  return headers
}

function rejectProxyAuthentication(response: ServerResponse): void {
  response.writeHead(407, {
    'proxy-authenticate': `Basic realm="${PROXY_AUTH_REALM}"`,
    connection: 'close',
  })
  response.end()
}

function rejectRawProxyAuthentication(socket: Duplex): void {
  if (!socket.writable) return
  socket.end(
    `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${PROXY_AUTH_REALM}"\r\nConnection: close\r\n\r\n`,
  )
}

function rejectHttpFailure(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) {
    response.destroy(error instanceof Error ? error : undefined)
    return
  }
  response.writeHead(error instanceof BrowserProviderPolicyError ? 403 : 502, { connection: 'close' })
  response.end()
}

function rejectRawFailure(socket: Duplex, error: unknown): void {
  if (!socket.writable) return
  const status = error instanceof BrowserProviderPolicyError ? '403 Forbidden' : '502 Bad Gateway'
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
}

function writeRawResponseHead(socket: Duplex, response: IncomingMessage): void {
  if (!socket.writable) return
  socket.write(`HTTP/${response.httpVersion} ${response.statusCode ?? 502} ${response.statusMessage ?? 'Bad Gateway'}\r\n`)
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`)
  }
  socket.write('\r\n')
}

function pipeTunnel(left: Duplex, right: Duplex): void {
  left.pipe(right)
  right.pipe(left)
  left.once('close', () => { right.destroy() })
  right.once('close', () => { left.destroy() })
}
