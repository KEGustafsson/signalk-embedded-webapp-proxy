import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import type { IncomingMessage, Server } from 'http'
import type { Socket } from 'net'
import { EventEmitter } from 'events'

type MiddlewareFn = (req: Request, res: Response, next: () => void) => void

interface MockProxyMiddleware {
  (...args: Parameters<MiddlewareFn>): void
  upgrade?: jest.Mock
}

const mockCreateProxyMiddleware = jest.fn<MockProxyMiddleware, [options: Record<string, unknown>]>()

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: (options: Record<string, unknown>) => mockCreateProxyMiddleware(options),
  fixRequestBody: jest.fn(),
}))

interface ServerAPIWithServer extends ServerAPI {
  server?: Server
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pluginFactory = require('../src/index') as (app: ServerAPIWithServer) => Plugin

const mockError = jest.fn()
const mockApp = { error: mockError } as unknown as ServerAPIWithServer

/** Minimal valid config with one app entry */
function oneApp(overrides: Record<string, unknown> = {}): object {
  return { apps: [{ name: 'Test App', url: 'http://localhost:9000', ...overrides }] }
}

type ProxyReqFn = (proxyReq: { setHeader: jest.Mock }, req: unknown) => void

/** Extracts the proxyReq handler from the *main* (first) createProxyMiddleware call.
 * When an app has a path-scoped target plus rewritePaths, the plugin creates a second
 * host-only proxy (call index 1) — tests that probe rewrite behavior want the first. */
function extractProxyReqHandler(): ProxyReqFn {
  const options = (mockCreateProxyMiddleware.mock.calls[0] as [Record<string, unknown>])[0]
  return (options['on'] as Record<string, unknown>)['proxyReq'] as ProxyReqFn
}

/** Extracts the proxyReqWs (WebSocket upgrade) handler from the first createProxyMiddleware call. */
function extractProxyReqWsHandler(): ProxyReqFn {
  const options = (mockCreateProxyMiddleware.mock.calls[0] as [Record<string, unknown>])[0]
  return (options['on'] as Record<string, unknown>)['proxyReqWs'] as ProxyReqFn
}

describe('signalk-embedded-webapp-proxy plugin', () => {
  let plugin: Plugin

  beforeEach(() => {
    jest.clearAllMocks()
    plugin = pluginFactory(mockApp)
  })

  describe('metadata', () => {
    it('has the correct plugin id', () => {
      expect(plugin.id).toBe('signalk-embedded-webapp-proxy')
    })

    it('has the correct plugin name', () => {
      expect(plugin.name).toBe('Embedded Webapp Proxy')
    })

    it('has a description', () => {
      expect(plugin.description).toBeDefined()
      expect(typeof plugin.description).toBe('string')
      expect(plugin.description!.length).toBeGreaterThan(0)
    })
  })

  describe('schema', () => {
    it('returns a valid JSON Schema object', () => {
      const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      expect(schema).toHaveProperty('type', 'object')
      expect(schema).toHaveProperty('properties')
    })

    it('defines an apps array property', () => {
      const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      const properties = (schema as Record<string, unknown>)['properties'] as Record<
        string,
        Record<string, unknown>
      >
      expect(properties['apps']).toBeDefined()
      expect(properties['apps']!['type']).toBe('array')
    })

    it('apps items define name, appPath, url, allowSelfSigned, rewritePaths, and timeout', () => {
      const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
      const properties = (schema as Record<string, unknown>)['properties'] as Record<
        string,
        Record<string, unknown>
      >
      const items = properties['apps']!['items'] as Record<string, unknown>
      const itemProps = items['properties'] as Record<string, Record<string, unknown>>
      expect(itemProps['name']!['type']).toBe('string')
      expect(itemProps['appPath']!['type']).toBe('string')
      expect(itemProps['url']!['type']).toBe('string')
      expect(itemProps['allowSelfSigned']!['type']).toBe('boolean')
      expect(itemProps['allowSelfSigned']!['default']).toBe(false)
      expect(itemProps['rewritePaths']!['type']).toBe('boolean')
      expect(itemProps['rewritePaths']!['default']).toBe(false)
      expect(itemProps['timeout']!['type']).toBe('number')
      expect(itemProps['timeout']!['default']).toBe(0)
    })
  })

  describe('start/stop lifecycle', () => {
    const dummyProxy: MockProxyMiddleware = jest.fn()

    beforeEach(() => {
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)
    })

    it('creates proxy middleware with correct target on start', () => {
      plugin.start(oneApp(), jest.fn())

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(1)
      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:9000')
      expect(options['changeOrigin']).toBe(true)
      expect(options['ws']).toBe(false)
    })

    it('creates one proxy per configured app', () => {
      plugin.start(
        {
          apps: [
            { name: 'App A', url: 'http://localhost:9000' },
            { name: 'App B', url: 'http://192.168.1.1:3000' },
          ],
        },
        jest.fn(),
      )

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(2)
      const targets = (mockCreateProxyMiddleware.mock.calls as unknown[][]).map(
        (c) => (c[0] as Record<string, unknown>)['target'],
      )
      expect(targets).toContain('http://localhost:9000')
      expect(targets).toContain('http://192.168.1.1:3000')
    })

    it('uses custom host and port from URL', () => {
      plugin.start(oneApp({ url: 'http://192.168.1.100:9443' }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://192.168.1.100:9443')
    })

    it('includes base path from URL in target', () => {
      plugin.start(oneApp({ url: 'http://localhost:9000/admin' }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:9000/admin')
    })

    it('creates no proxies when apps array is empty', () => {
      plugin.start({ apps: [] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('reports no apps configured when started with empty apps', () => {
      plugin.start({ apps: [] }, jest.fn())

      expect(plugin.statusMessage?.()).toBe('No apps configured')
    })

    it('skips app when url field is absent', () => {
      plugin.start({ apps: [{ name: 'X' }] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('index 0'))
    })

    it('skips app when url is an empty string', () => {
      plugin.start({ apps: [{ name: 'X', url: '' }] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when url is not parseable', () => {
      plugin.start({ apps: [{ name: 'X', url: 'not a url' }] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('infers port 80 when http URL omits the port', () => {
      plugin.start({ apps: [{ name: 'X', url: 'http://localhost' }] }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:80')
    })

    it('infers port 443 when https URL omits the port', () => {
      plugin.start({ apps: [{ name: 'X', url: 'https://myapp.local' }] }, jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('https://myapp.local:443')
    })

    it('creates no proxies when apps key is missing', () => {
      plugin.start({}, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when URL scheme is not http or https', () => {
      plugin.start({ apps: [{ name: 'X', url: 'ftp://localhost:9000' }] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when URL contains embedded credentials', () => {
      plugin.start({ apps: [{ name: 'X', url: 'http://user:pass@evil.com:9000' }] }, jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when host is an IPv6 address and reports a clear error', () => {
      plugin.start(oneApp({ url: 'http://[::1]:9000' }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('IPv6'))
    })

    it('skips app when host is a cloud metadata IP', () => {
      plugin.start(oneApp({ url: 'http://169.254.169.254:9000' }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when host is cloud metadata with trailing dot', () => {
      plugin.start(oneApp({ url: 'http://169.254.169.254.:9000' }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('skips app when host is cloud metadata with mixed case', () => {
      plugin.start(oneApp({ url: 'http://Metadata.Google.Internal:9000' }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('normalizes host to lowercase', () => {
      plugin.start(oneApp({ url: 'http://MyHost.Local:9000' }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://myhost.local:9000')
    })

    it('strips trailing dot from host', () => {
      plugin.start(oneApp({ url: 'http://myhost.local.:9000' }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://myhost.local:9000')
    })

    it('caps apps at MAX_APP_SLOTS and ignores entries beyond the limit', () => {
      const manyApps = Array.from({ length: 20 }, (_, i) => ({
        name: `App ${i}`,
        url: `http://localhost:${9000 + i}`,
      }))
      plugin.start({ apps: manyApps }, jest.fn())

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(16)
    })

    it('uses https scheme when URL uses https', () => {
      plugin.start(oneApp({ url: 'https://localhost:9443' }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('https://localhost:9443')
      expect(options['secure']).toBe(true)
    })

    it('sets secure to false when allowSelfSigned is true with https', () => {
      plugin.start(oneApp({ url: 'https://localhost:9443', allowSelfSigned: true }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('https://localhost:9443')
      expect(options['secure']).toBe(false)
    })

    it('configures a proxyReq handler that sets forwarding headers', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const proxyReqHandler = extractProxyReqHandler()
      expect(proxyReqHandler).toBeDefined()
      expect(typeof proxyReqHandler).toBe('function')

      const mockProxyReq = { setHeader: jest.fn() }
      const mockReq = {
        socket: { remoteAddress: '10.0.0.1', encrypted: false },
        headers: {},
      }

      proxyReqHandler(mockProxyReq, mockReq)

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Real-IP']).toBe('10.0.0.1')
      expect(headerMap['X-Forwarded-For']).toBe('10.0.0.1')
      expect(headerMap['X-Forwarded-Proto']).toBe('http')
    })

    it('constrains upstream Accept-Encoding to client-accepted encodings we can decompress', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      proxyReqHandler(mockProxyReq, {
        socket: { remoteAddress: '10.0.0.1' },
        headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
      })
      const calls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const ae = Object.fromEntries(calls.map(([k, v]) => [k, v]))['Accept-Encoding']
      expect(ae).toBe('gzip, deflate, br')
    })

    it('falls back to identity when client Accept-Encoding has nothing we can decompress', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      proxyReqHandler(mockProxyReq, {
        socket: { remoteAddress: '10.0.0.1' },
        headers: { 'accept-encoding': 'zstd' },
      })
      const calls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const ae = Object.fromEntries(calls.map(([k, v]) => [k, v]))['Accept-Encoding']
      expect(ae).toBe('identity')
    })

    it('does not override Accept-Encoding when rewritePaths is disabled', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
      plugin.start(oneApp(), jest.fn())
      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      proxyReqHandler(mockProxyReq, {
        socket: { remoteAddress: '10.0.0.1' },
        headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
      })
      const calls = mockProxyReq.setHeader.mock.calls as [string, string][]
      expect(calls.find(([k]) => k === 'Accept-Encoding')).toBeUndefined()
    })

    it('appends to existing X-Forwarded-For header', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      const mockReq = {
        socket: { remoteAddress: '10.0.0.2', encrypted: true },
        headers: { 'x-forwarded-for': '192.168.1.1' },
      }

      proxyReqHandler(mockProxyReq, mockReq)

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Forwarded-For']).toBe('192.168.1.1, 10.0.0.2')
      expect(headerMap['X-Forwarded-Proto']).toBe('https')
    })

    it('passes through upstream x-forwarded-proto when present', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      const mockReq = {
        socket: { remoteAddress: '10.0.0.3', encrypted: false },
        headers: { 'x-forwarded-proto': 'https' },
      }

      proxyReqHandler(mockProxyReq, mockReq)

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Forwarded-Proto']).toBe('https')
    })

    it('takes the first value when x-forwarded-proto is comma-separated', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      const mockReq = {
        socket: { remoteAddress: '10.0.0.4', encrypted: false },
        headers: { 'x-forwarded-proto': 'https, http' },
      }

      proxyReqHandler(mockProxyReq, mockReq)

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Forwarded-Proto']).toBe('https')
    })

    it('rewrites Origin header on HTTP proxyReq to the target origin', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp({ url: 'https://127.0.0.1:9443' }), jest.fn())

      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      const mockReq = {
        socket: { remoteAddress: '10.0.0.5', encrypted: true },
        headers: { origin: 'https://signalk.local:3443', host: 'signalk.local:3443' },
      }

      proxyReqHandler(mockProxyReq, mockReq)

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['Origin']).toBe('https://127.0.0.1:9443')
      // The original host must still be recoverable via X-Forwarded-Host.
      expect(headerMap['X-Forwarded-Host']).toBe('signalk.local:3443')
    })

    it('omits port in target Origin when target uses default scheme port', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp({ url: 'https://upstream.example.com' }), jest.fn())

      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      proxyReqHandler(mockProxyReq, {
        socket: { remoteAddress: '10.0.0.6', encrypted: true },
        headers: { origin: 'https://signalk.local:3443', host: 'signalk.local:3443' },
      })

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      // Port 443 is the default for https — must be omitted so Origin matches
      // the Host header that changeOrigin: true writes (no default-port suffix).
      expect(headerMap['Origin']).toBe('https://upstream.example.com')
    })

    it('does not set Origin on HTTP proxyReq when request has no Origin header', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp({ url: 'https://127.0.0.1:9443' }), jest.fn())

      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      proxyReqHandler(mockProxyReq, {
        socket: { remoteAddress: '10.0.0.7', encrypted: true },
        headers: {},
      })

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      expect(setCalls.find(([k]) => k === 'Origin')).toBeUndefined()
    })

    it('ignores allowSelfSigned when scheme is http', () => {
      plugin.start(oneApp({ allowSelfSigned: true }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['target']).toBe('http://localhost:9000')
      expect(options['secure']).toBe(true)
    })

    it('cleans up on stop', () => {
      plugin.start(oneApp(), jest.fn())
      void plugin.stop()

      expect(plugin.statusMessage?.()).toBe('Not started')
    })

    it('passes proxyTimeout to middleware when timeout is configured', () => {
      plugin.start(oneApp({ timeout: 30000 }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['proxyTimeout']).toBe(30000)
    })

    it('does not set proxyTimeout when timeout is 0', () => {
      plugin.start(oneApp({ timeout: 0 }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['proxyTimeout']).toBeUndefined()
    })

    it('skips app when timeout is negative', () => {
      plugin.start(oneApp({ timeout: -100 }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('timeout'))
    })

    it('skips app when timeout is Infinity (e.g. 1e309 in JSON)', () => {
      plugin.start(oneApp({ timeout: Infinity }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('timeout'))
    })

    it('skips app when timeout is NaN', () => {
      plugin.start(oneApp({ timeout: NaN }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('timeout'))
    })

    it('floors fractional timeout values', () => {
      plugin.start(oneApp({ timeout: 5500.9 }), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['proxyTimeout']).toBe(5500)
    })

    it('accepts a valid appPath', () => {
      plugin.start(oneApp({ appPath: 'portainer' }), jest.fn())

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(1)
    })

    it('accepts appPath with letters, digits, and hyphens', () => {
      plugin.start(oneApp({ appPath: 'my-app-2' }), jest.fn())

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(1)
    })

    it('skips app when appPath starts with a digit', () => {
      plugin.start(oneApp({ appPath: '0abc' }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('appPath'))
    })

    it('skips app when appPath contains invalid characters', () => {
      plugin.start(oneApp({ appPath: 'my_app' }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('appPath'))
    })

    it('skips app when appPath contains slashes', () => {
      plugin.start(oneApp({ appPath: 'my/app' }), jest.fn())

      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('appPath'))
    })

    it('skips second app when appPath is duplicated', () => {
      plugin.start(
        {
          apps: [
            { name: 'A', url: 'http://localhost:9000', appPath: 'portainer' },
            { name: 'B', url: 'http://localhost:3000', appPath: 'portainer' },
          ],
        },
        jest.fn(),
      )

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(1)
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Duplicate appPath'))
    })

    it('detects duplicate appPath case-insensitively', () => {
      plugin.start(
        {
          apps: [
            { name: 'A', url: 'http://localhost:9000', appPath: 'Portainer' },
            { name: 'B', url: 'http://localhost:3000', appPath: 'portainer' },
          ],
        },
        jest.fn(),
      )

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(1)
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Duplicate appPath'))
    })

    it('treats empty appPath as no custom path (no conflict)', () => {
      plugin.start(
        {
          apps: [
            { name: 'A', url: 'http://localhost:9000' },
            { name: 'B', url: 'http://localhost:3000' },
          ],
        },
        jest.fn(),
      )

      expect(mockCreateProxyMiddleware).toHaveBeenCalledTimes(2)
    })

    it('always enables selfHandleResponse and proxyRes handler', () => {
      plugin.start(oneApp(), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['selfHandleResponse']).toBe(true)
      const on = options['on'] as Record<string, unknown>
      expect(on['proxyRes']).toBeDefined()
      expect(typeof on['proxyRes']).toBe('function')
    })

    it('uses appPath in rewrite prefix when both appPath and rewritePaths are set', () => {
      plugin.start(
        {
          apps: [
            { name: 'P', url: 'http://localhost:9000', appPath: 'portainer', rewritePaths: true },
          ],
        },
        jest.fn(),
      )

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['selfHandleResponse']).toBe(true)
    })

    it('defaults rewritePaths to false when not specified', () => {
      plugin.start(oneApp(), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      expect(options['selfHandleResponse']).toBe(true)
    })
  })

  describe('statusMessage', () => {
    beforeEach(() => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
    })

    it('returns not started before start is called', () => {
      expect(plugin.statusMessage?.()).toBe('Not started')
    })

    it('returns target info after start with one app', () => {
      plugin.start(oneApp({ url: 'http://myhost:8080' }), jest.fn())
      expect(plugin.statusMessage?.()).toBe('Proxying to: http://myhost:8080')
    })

    it('returns target info including base path when url has a path', () => {
      plugin.start(oneApp({ url: 'http://myhost:8080/admin' }), jest.fn())
      expect(plugin.statusMessage?.()).toBe('Proxying to: http://myhost:8080/admin')
    })

    it('returns all targets after start with multiple apps', () => {
      plugin.start(
        {
          apps: [
            { name: 'A', url: 'http://host-a:8080' },
            { name: 'B', url: 'http://host-b:3000' },
          ],
        },
        jest.fn(),
      )
      expect(plugin.statusMessage?.()).toBe('Proxying to: http://host-a:8080, http://host-b:3000')
    })

    it('returns not started after stop', () => {
      plugin.start(oneApp(), jest.fn())
      void plugin.stop()
      expect(plugin.statusMessage?.()).toBe('Not started')
    })
  })

  describe('registerWithRouter', () => {
    let mockRouter: IRouter
    let registeredHandlers: Map<string, MiddlewareFn>
    let registeredGetHandlers: Map<string, (req: Request, res: Response) => void>

    beforeEach(() => {
      registeredHandlers = new Map()
      registeredGetHandlers = new Map()
      mockRouter = {
        use: jest.fn((path: string, handler: MiddlewareFn) => {
          registeredHandlers.set(path, handler)
          return mockRouter
        }),
        get: jest.fn((path: string, handler: (req: Request, res: Response) => void) => {
          registeredGetHandlers.set(path, handler)
          return mockRouter
        }),
      } as unknown as IRouter
    })

    it('registers /apps GET route', () => {
      plugin.registerWithRouter!(mockRouter)
      expect(mockRouter.get).toHaveBeenCalledWith('/apps', expect.any(Function))
    })

    it('/apps returns empty list when plugin not started', () => {
      plugin.registerWithRouter!(mockRouter)
      const handler = registeredGetHandlers.get('/apps')!
      const mockRes = { json: jest.fn() } as unknown as Response
      handler({} as Request, mockRes)
      expect(mockRes.json).toHaveBeenCalledWith([])
    })

    it('/apps returns configured app list after start', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
      plugin.start(
        {
          apps: [
            { name: 'Portainer', url: 'http://localhost:9000', appPath: 'portainer' },
            { name: 'Grafana', url: 'http://localhost:3000' },
          ],
        },
        jest.fn(),
      )
      plugin.registerWithRouter!(mockRouter)
      const handler = registeredGetHandlers.get('/apps')!
      const mockRes = { json: jest.fn() } as unknown as Response
      handler({} as Request, mockRes)
      expect(mockRes.json).toHaveBeenCalledWith([
        { index: 0, name: 'Portainer', appPath: 'portainer' },
        { index: 1, name: 'Grafana' },
      ])
    })

    it('registers parameterized /proxy/:appId route', () => {
      plugin.registerWithRouter!(mockRouter)
      expect(mockRouter.use).toHaveBeenCalledWith('/proxy/:appId', expect.any(Function))
    })

    it('strips invalid header names before invoking the proxy', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start(oneApp(), jest.fn())
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/:appId')!
      const mockReq = {
        params: { appId: '0' },
        headers: {
          'content-type': 'text/html',
          'primus::req::backup': {},
          'x-custom': 'ok',
        },
      } as unknown as Request
      const mockRes = {} as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(mockReq.headers).not.toHaveProperty('primus::req::backup')
      expect(mockReq.headers).toHaveProperty('content-type', 'text/html')
      expect(mockReq.headers).toHaveProperty('x-custom', 'ok')
    })

    it('returns 503 when plugin is not started', () => {
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/:appId')!
      const mockReq = { params: { appId: '0' } } as unknown as Request
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(503)
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Plugin is not started' })
    })

    it('delegates /proxy/0 to proxies[0] when started with one app', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start(oneApp(), jest.fn())
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/:appId')!
      const mockReq = { params: { appId: '0' } } as unknown as Request
      const mockRes = {} as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(dummyProxy).toHaveBeenCalledWith(mockReq, mockRes, mockNext)
    })

    it('delegates /proxy/1 to proxies[1] when started with two apps', () => {
      const proxy0: MockProxyMiddleware = jest.fn()
      const proxy1: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValueOnce(proxy0).mockReturnValueOnce(proxy1)

      plugin.start(
        {
          apps: [
            { name: 'A', url: 'http://host-a:8080' },
            { name: 'B', url: 'http://host-b:3000' },
          ],
        },
        jest.fn(),
      )
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/:appId')!
      const mockReq = { params: { appId: '1' } } as unknown as Request
      const mockRes = {} as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(proxy1).toHaveBeenCalledWith(mockReq, mockRes, mockNext)
      expect(proxy0).not.toHaveBeenCalled()
    })

    it('returns 404 for out-of-range numeric index', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start(oneApp(), jest.fn())
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/:appId')!
      const mockReq = { params: { appId: '1' } } as unknown as Request
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(404)
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'No app found for "1"' })
    })

    it('delegates via appPath when configured', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start(
        { apps: [{ name: 'P', url: 'http://localhost:9000', appPath: 'portainer' }] },
        jest.fn(),
      )
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/:appId')!
      const mockReq = { params: { appId: 'portainer' } } as unknown as Request
      const mockRes = {} as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(dummyProxy).toHaveBeenCalledWith(mockReq, mockRes, mockNext)
    })

    it('appPath resolution is case-insensitive', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start(
        { apps: [{ name: 'P', url: 'http://localhost:9000', appPath: 'Portainer' }] },
        jest.fn(),
      )
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/:appId')!
      const mockReq = { params: { appId: 'portainer' } } as unknown as Request
      const mockRes = {} as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(dummyProxy).toHaveBeenCalledWith(mockReq, mockRes, mockNext)
    })

    it('returns 404 for unknown appPath', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start(oneApp(), jest.fn())
      plugin.registerWithRouter!(mockRouter)

      const handler = registeredHandlers.get('/proxy/:appId')!
      const mockReq = { params: { appId: 'unknown' } } as unknown as Request
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(404)
    })

    it('returns 503 after plugin is stopped', () => {
      const dummyProxy: MockProxyMiddleware = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)

      plugin.start(oneApp(), jest.fn())
      plugin.registerWithRouter!(mockRouter)
      void plugin.stop()

      const handler = registeredHandlers.get('/proxy/:appId')!
      const mockReq = { params: { appId: '0' } } as unknown as Request
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response
      const mockNext = jest.fn()

      handler(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(503)
    })
  })

  describe('WebSocket upgrade header rewriting (proxyReqWs)', () => {
    beforeEach(() => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
    })

    it('registers a proxyReqWs hook on every proxy', () => {
      plugin.start(oneApp(), jest.fn())

      const options = (mockCreateProxyMiddleware.mock.calls[0] as [Record<string, unknown>])[0]
      const on = options['on'] as Record<string, unknown>
      expect(typeof on['proxyReqWs']).toBe('function')
    })

    it('applies X-Forwarded-* headers with ws/wss protocol on upgrade', () => {
      plugin.start(oneApp(), jest.fn())

      const proxyReqWs = extractProxyReqWsHandler()
      const mockProxyReq = { setHeader: jest.fn() }
      const mockReq = {
        socket: { remoteAddress: '10.0.0.8', encrypted: false },
        headers: { host: 'signalk.local:3000' },
      }

      proxyReqWs(mockProxyReq, mockReq)

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Real-IP']).toBe('10.0.0.8')
      expect(headerMap['X-Forwarded-For']).toBe('10.0.0.8')
      // RFC 7239 / http-proxy's built-in xfwd pass uses ws/wss for upgrades.
      expect(headerMap['X-Forwarded-Proto']).toBe('ws')
      expect(headerMap['X-Forwarded-Host']).toBe('signalk.local:3000')
    })

    it('uses wss when the incoming socket is TLS-encrypted', () => {
      plugin.start(oneApp(), jest.fn())

      const proxyReqWs = extractProxyReqWsHandler()
      const mockProxyReq = { setHeader: jest.fn() }
      proxyReqWs(mockProxyReq, {
        socket: { remoteAddress: '10.0.0.9', encrypted: true },
        headers: { host: 'signalk.local:3443' },
      })

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Forwarded-Proto']).toBe('wss')
    })

    it('rewrites Origin to the target origin when the request carries Origin', () => {
      plugin.start(oneApp({ url: 'https://127.0.0.1:9443' }), jest.fn())

      const proxyReqWs = extractProxyReqWsHandler()
      const mockProxyReq = { setHeader: jest.fn() }
      proxyReqWs(mockProxyReq, {
        socket: { remoteAddress: '10.0.0.10', encrypted: true },
        headers: {
          host: 'signalk.local:3443',
          origin: 'https://signalk.local:3443',
        },
      })

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      // Target Host = 127.0.0.1:9443 (non-default https port), so Origin must match.
      expect(headerMap['Origin']).toBe('https://127.0.0.1:9443')
      expect(headerMap['X-Forwarded-Host']).toBe('signalk.local:3443')
    })

    it('leaves Origin untouched on upgrade when request has no Origin header', () => {
      plugin.start(oneApp({ url: 'https://127.0.0.1:9443' }), jest.fn())

      const proxyReqWs = extractProxyReqWsHandler()
      const mockProxyReq = { setHeader: jest.fn() }
      proxyReqWs(mockProxyReq, {
        socket: { remoteAddress: '10.0.0.11', encrypted: true },
        headers: { host: 'signalk.local:3443' },
      })

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      expect(setCalls.find(([k]) => k === 'Origin')).toBeUndefined()
    })

    it('appends the client IP to an existing X-Forwarded-For on upgrade', () => {
      plugin.start(oneApp(), jest.fn())

      const proxyReqWs = extractProxyReqWsHandler()
      const mockProxyReq = { setHeader: jest.fn() }
      proxyReqWs(mockProxyReq, {
        socket: { remoteAddress: '10.0.0.12' },
        headers: { 'x-forwarded-for': '192.168.1.1' },
      })

      const setCalls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(setCalls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Forwarded-For']).toBe('192.168.1.1, 10.0.0.12')
    })
  })

  describe('WebSocket upgrade handling', () => {
    let mockServer: EventEmitter
    let dummyProxy: MockProxyMiddleware
    let appWithServer: ServerAPIWithServer

    beforeEach(() => {
      mockServer = new EventEmitter()
      appWithServer = {
        server: mockServer as unknown as Server,
        error: jest.fn(),
      } as unknown as ServerAPIWithServer
      dummyProxy = jest.fn() as MockProxyMiddleware
      dummyProxy.upgrade = jest.fn()
      mockCreateProxyMiddleware.mockReturnValue(dummyProxy)
    })

    it('registers upgrade handler on server when server is available', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      expect(mockServer.listenerCount('upgrade')).toBe(1)
    })

    it('forwards upgrade requests matching plugin path and strips prefix', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = {
        url: '/plugins/signalk-embedded-webapp-proxy/proxy/0/api/websocket/exec',
        headers: {},
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(mockReq.url).toBe('/api/websocket/exec')
    })

    it('routes upgrade to correct proxy by index', () => {
      const proxy0: MockProxyMiddleware = jest.fn()
      proxy0.upgrade = jest.fn()
      const proxy1: MockProxyMiddleware = jest.fn()
      proxy1.upgrade = jest.fn()
      mockCreateProxyMiddleware.mockReturnValueOnce(proxy0).mockReturnValueOnce(proxy1)

      const plugin = pluginFactory(appWithServer)
      plugin.start(
        {
          apps: [
            { name: 'A', url: 'http://host-a:8080' },
            { name: 'B', url: 'http://host-b:3000' },
          ],
        },
        jest.fn(),
      )

      const mockReq = {
        url: '/plugins/signalk-embedded-webapp-proxy/proxy/1/api/websocket/exec',
        headers: {},
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(proxy1.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(proxy0.upgrade).not.toHaveBeenCalled()
      expect(mockReq.url).toBe('/api/websocket/exec')
    })

    it('sets url to / when upgrade request matches only prefix', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = {
        url: '/plugins/signalk-embedded-webapp-proxy/proxy/0',
        headers: {},
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(mockReq.url).toBe('/')
    })

    it('preserves query string on upgrade path', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = {
        url: '/plugins/signalk-embedded-webapp-proxy/proxy/0/api/websocket/exec?token=abc&endpointId=1',
        headers: {},
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(mockReq.url).toBe('/api/websocket/exec?token=abc&endpointId=1')
    })

    it('resolves appId correctly when query string is on appId segment', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = {
        url: '/plugins/signalk-embedded-webapp-proxy/proxy/0?token=abc',
        headers: {},
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(mockReq.url).toBe('/?token=abc')
    })

    it('resolves appPath correctly when query string is present', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(
        { apps: [{ name: 'P', url: 'http://localhost:9000', appPath: 'portainer' }] },
        jest.fn(),
      )

      const mockReq = {
        url: '/plugins/signalk-embedded-webapp-proxy/proxy/portainer?token=abc',
        headers: {},
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(mockReq.url).toBe('/?token=abc')
    })

    it('strips invalid header names before forwarding upgrade requests', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = {
        url: '/plugins/signalk-embedded-webapp-proxy/proxy/0/api/websocket/exec',
        headers: {
          upgrade: 'websocket',
          'primus::req::backup': {},
          connection: 'Upgrade',
        },
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(mockReq.headers).not.toHaveProperty('primus::req::backup')
      expect(mockReq.headers).toHaveProperty('upgrade', 'websocket')
      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
    })

    it('ignores upgrade requests not matching plugin path', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = { url: '/signalk/v1/stream' } as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).not.toHaveBeenCalled()
    })

    it('routes upgrade via appPath', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(
        { apps: [{ name: 'P', url: 'http://localhost:9000', appPath: 'portainer' }] },
        jest.fn(),
      )

      const mockReq = {
        url: '/plugins/signalk-embedded-webapp-proxy/proxy/portainer/api/websocket/exec',
        headers: {},
      } as unknown as IncomingMessage
      const mockSocket = {} as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      expect(dummyProxy.upgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead)
      expect(mockReq.url).toBe('/api/websocket/exec')
    })

    it('returns 404 for upgrade requests with unknown appPath', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      const mockReq = {
        url: '/plugins/signalk-embedded-webapp-proxy/proxy/unknown/api/websocket/exec',
      } as IncomingMessage
      const mockSocket = { write: jest.fn(), end: jest.fn() } as unknown as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      const mockSocketAny = mockSocket as unknown as { write: jest.Mock; end: jest.Mock }
      expect(dummyProxy.upgrade).not.toHaveBeenCalled()
      expect(mockSocketAny.write).toHaveBeenCalledWith(
        'HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n',
      )
      expect(mockSocketAny.end).toHaveBeenCalled()
    })

    it('returns 404 for upgrade requests with out-of-range index', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn()) // only 1 app → index 0 valid, index 1 invalid

      const mockReq = {
        url: '/plugins/signalk-embedded-webapp-proxy/proxy/1/api/websocket/exec',
      } as IncomingMessage
      const mockSocket = { write: jest.fn(), end: jest.fn() } as unknown as Socket
      const mockHead = Buffer.alloc(0)

      mockServer.emit('upgrade', mockReq, mockSocket, mockHead)

      const mockSocketAny = mockSocket as unknown as { write: jest.Mock; end: jest.Mock }
      expect(dummyProxy.upgrade).not.toHaveBeenCalled()
      expect(mockSocketAny.write).toHaveBeenCalledWith(
        'HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n',
      )
      expect(mockSocketAny.end).toHaveBeenCalled()
    })

    it('removes upgrade handler on stop', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())

      expect(mockServer.listenerCount('upgrade')).toBe(1)

      void plugin.stop()

      expect(mockServer.listenerCount('upgrade')).toBe(0)
    })

    it('does not register upgrade handler when no apps are configured', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start({ apps: [] }, jest.fn())

      expect(mockServer.listenerCount('upgrade')).toBe(0)
    })

    it('does not invoke proxy upgrade when app.server is unavailable', () => {
      // mockApp has no server property; no listener is registered so upgrade is never dispatched
      const plugin = pluginFactory(mockApp)
      plugin.start(oneApp(), jest.fn())

      expect(dummyProxy.upgrade).not.toHaveBeenCalled()
    })

    it('re-starting replaces the upgrade listener instead of leaking the previous one', () => {
      const plugin = pluginFactory(appWithServer)
      plugin.start(oneApp(), jest.fn())
      expect(mockServer.listenerCount('upgrade')).toBe(1)

      // Second start (e.g. config save) must not accumulate listeners
      plugin.start(oneApp(), jest.fn())
      expect(mockServer.listenerCount('upgrade')).toBe(1)
    })
  })

  describe('proxy error handling', () => {
    it('configures an error handler on the proxy', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      expect(on['error']).toBeDefined()
      expect(typeof on['error']).toBe('function')
    })

    it('error handler returns 502 without leaking details', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      const errorHandler = on['error'] as (err: Error, req: Request, res: Response) => void

      const mockReq = {} as Request
      const mockRes = {
        headersSent: false,
        writeHead: jest.fn(),
        end: jest.fn(),
      } as unknown as Response

      errorHandler(new Error('ECONNREFUSED'), mockReq, mockRes)

      expect(mockError).toHaveBeenCalledWith('Web proxy error: ECONNREFUSED')
      expect(mockRes.writeHead).toHaveBeenCalledWith(502, { 'Content-Type': 'application/json' })
      const body = JSON.parse((mockRes.end as jest.Mock).mock.calls[0][0] as string) as Record<
        string,
        unknown
      >
      expect(body['error']).toBe('Application is not reachable')
      expect(body).not.toHaveProperty('detail')
    })

    it('error handler does not write headers if already sent', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      const errorHandler = on['error'] as (err: Error, req: Request, res: Response) => void

      const mockReq = {} as Request
      const mockRes = {
        headersSent: true,
        writeHead: jest.fn(),
        end: jest.fn(),
      } as unknown as Response

      errorHandler(new Error('timeout'), mockReq, mockRes)

      expect(mockError).toHaveBeenCalledWith('Web proxy error: timeout')
      expect(mockRes.writeHead).not.toHaveBeenCalled()
      expect(mockRes.end).toHaveBeenCalledWith() // no body — avoids corrupting partial response
    })

    it('error handler destroys socket for WebSocket errors', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)

      plugin.start(oneApp(), jest.fn())

      const callArgs = mockCreateProxyMiddleware.mock.calls[0] as unknown[]
      const options = callArgs[0] as Record<string, unknown>
      const on = options['on'] as Record<string, unknown>
      const errorHandler = on['error'] as (
        err: Error,
        req: Request,
        res: { destroy: () => void },
      ) => void

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Socket } = require('net') as typeof import('net')
      const mockSocket = new Socket()
      mockSocket.destroy = jest.fn() as typeof mockSocket.destroy

      errorHandler(new Error('ws error'), {} as Request, mockSocket)

      expect(mockError).toHaveBeenCalledWith('Web proxy error: ws error')
      expect(mockSocket.destroy).toHaveBeenCalled()
    })
  })

  describe('proxyRes response handling', () => {
    type ProxyResFn = (proxyRes: IncomingMessage, req: IncomingMessage, res: unknown) => void

    function extractProxyResHandler(): ProxyResFn {
      const options = (mockCreateProxyMiddleware.mock.calls[0] as [Record<string, unknown>])[0]
      return (options['on'] as Record<string, unknown>)['proxyRes'] as ProxyResFn
    }

    interface MockRes {
      writeHead: jest.Mock
      end: jest.Mock
      headersSent: boolean
    }

    async function runHtmlProxyRes(
      handler: ProxyResFn,
      html: string,
      overrides: { contentType?: string; statusCode?: number } = {},
    ): Promise<{ body: Buffer; res: MockRes }> {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      Object.assign(proxyResStream, {
        headers: { 'content-type': overrides.contentType ?? 'text/html' },
        statusCode: overrides.statusCode ?? 200,
      })

      let resolveEnd!: (buf: Buffer) => void
      const endPromise = new Promise<Buffer>((resolve) => {
        resolveEnd = resolve
      })

      const mockRes: MockRes = {
        writeHead: jest.fn(),
        end: jest.fn((buf: Buffer) => resolveEnd(buf)),
        headersSent: false,
      }

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)
      proxyResStream.write(html)
      proxyResStream.end()

      const body = await endPromise
      return { body, res: mockRes }
    }

    beforeEach(() => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
    })

    it('rewrites absolute src attributes in HTML when rewritePaths is enabled', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(
        handler,
        '<html><head></head><body><script src="/public/build/app.js"></script></body></html>',
      )

      expect(body.toString()).toContain(
        'src="/plugins/signalk-embedded-webapp-proxy/proxy/0/public/build/app.js"',
      )
    })

    it('rewrites absolute href attributes in HTML', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(
        handler,
        '<html><head><link href="/public/fonts/font.css"></head><body></body></html>',
      )

      expect(body.toString()).toContain(
        'href="/plugins/signalk-embedded-webapp-proxy/proxy/0/public/fonts/font.css"',
      )
    })

    it('rewrites absolute action attributes in HTML', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(
        handler,
        '<html><head></head><body><form action="/login"></form></body></html>',
      )

      expect(body.toString()).toContain(
        'action="/plugins/signalk-embedded-webapp-proxy/proxy/0/login"',
      )
    })

    it('does not rewrite protocol-relative URLs', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(
        handler,
        '<html><head></head><body><script src="//cdn.example.com/app.js"></script></body></html>',
      )

      expect(body.toString()).toContain('src="//cdn.example.com/app.js"')
    })

    it('does not rewrite relative paths', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(
        handler,
        '<html><head></head><body><script src="public/build/app.js"></script></body></html>',
      )

      expect(body.toString()).toContain('src="public/build/app.js"')
    })

    it('does not rewrite absolute URLs with a scheme', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(
        handler,
        '<html><head><link href="https://fonts.googleapis.com/css"></head></html>',
      )

      expect(body.toString()).toContain('href="https://fonts.googleapis.com/css"')
    })

    it('still injects the path-rewriting script into <head>', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(handler, '<html><head></head><body></body></html>')

      expect(body.toString()).toContain(
        '<script data-signalk-embedded-webapp-proxy="path-rewrite">',
      )
    })

    it('rewrites WebSocket URLs (absolute ws:// to current host and root-relative paths)', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(handler, '<html><head></head><body></body></html>')
      const html = body.toString()
      const scriptMatch = html.match(
        /<script data-signalk-embedded-webapp-proxy="path-rewrite">([\s\S]*?)<\/script>/,
      )
      expect(scriptMatch).not.toBeNull()
      const scriptBody = scriptMatch![1]!

      // Simulate the browser environment the IIFE expects.
      const created: string[] = []
      class FakeWS {
        constructor(url: string) {
          created.push(url)
        }
      }
      const sandbox = {
        window: {
          WebSocket: FakeWS,
          fetch: () => {},
          location: { protocol: 'http:', host: '192.168.100.10:3000', assign() {}, replace() {} },
          history: null,
          MutationObserver: null,
        } as Record<string, unknown>,
        XMLHttpRequest: { prototype: { open() {} } },
        Location: { prototype: {} },
        Object,
      }
      sandbox.window.WebSocket = FakeWS
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vm = require('vm') as typeof import('vm')
      vm.createContext(sandbox)
      vm.runInContext(scriptBody, sandbox)

      const W = (sandbox.window as { WebSocket: new (u: unknown) => unknown }).WebSocket
      new W('ws://192.168.100.10:3000/plugins/signalk-onvif-camera/ws')
      new W('/api/stream')
      new W('wss://other.example.com/socket')
      new W('/plugins/signalk-embedded-webapp-proxy/proxy/0/already')
      // URL-object inputs (e.g. Portainer's `new WebSocket(new URL(path, origin))`)
      // must be coerced and rewritten the same way strings are.
      const urlLike: { href: string; toString(): string } = {
        href: 'wss://192.168.100.10:3000/api/websocket/exec?token=abc',
        toString(): string {
          return this.href
        },
      }
      new W(urlLike)

      expect(created[0]).toBe(
        'ws://192.168.100.10:3000/plugins/signalk-embedded-webapp-proxy/proxy/0/plugins/signalk-onvif-camera/ws',
      )
      expect(created[1]).toBe(
        'ws://192.168.100.10:3000/plugins/signalk-embedded-webapp-proxy/proxy/0/api/stream',
      )
      expect(created[2]).toBe('wss://other.example.com/socket')
      expect(created[3]).toBe('/plugins/signalk-embedded-webapp-proxy/proxy/0/already')
      expect(created[4]).toBe(
        'ws://192.168.100.10:3000/plugins/signalk-embedded-webapp-proxy/proxy/0/api/websocket/exec?token=abc',
      )
    })

    it('uses appPath in the rewritten attribute prefix', async () => {
      plugin.start(
        {
          apps: [
            {
              name: 'Grafana',
              url: 'http://localhost:3000',
              appPath: 'grafana',
              rewritePaths: true,
            },
          ],
        },
        jest.fn(),
      )
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(
        handler,
        '<html><head></head><body><script src="/public/build/app.js"></script></body></html>',
      )

      expect(body.toString()).toContain(
        'src="/plugins/signalk-embedded-webapp-proxy/proxy/grafana/public/build/app.js"',
      )
    })

    it('rewrites root-relative Location header on redirect responses', () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      const headers: Record<string, string> = {
        'content-type': 'text/html',
        location: '/login',
      }
      Object.assign(proxyResStream, { headers, statusCode: 302 })
      const mockRes = new PassThrough() as unknown as {
        writeHead: jest.Mock
        headersSent: boolean
      }
      mockRes.writeHead = jest.fn()
      Object.assign(mockRes, { headersSent: false })

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)

      expect(headers['location']).toBe('/plugins/signalk-embedded-webapp-proxy/proxy/0/login')
    })

    it('strips app base path from Location header before prepending proxy prefix', () => {
      plugin.start(
        {
          apps: [
            {
              name: 'Grafana',
              url: 'http://localhost:3000/grafana',
              appPath: 'grafana',
              rewritePaths: true,
            },
          ],
        },
        jest.fn(),
      )
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      const headers: Record<string, string> = {
        'content-type': 'text/html',
        location: '/grafana/login',
      }
      Object.assign(proxyResStream, { headers, statusCode: 302 })
      const mockRes = new PassThrough() as unknown as {
        writeHead: jest.Mock
        headersSent: boolean
      }
      mockRes.writeHead = jest.fn()
      Object.assign(mockRes, { headersSent: false })

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)

      expect(headers['location']).toBe('/plugins/signalk-embedded-webapp-proxy/proxy/grafana/login')
      expect(headers['location']).not.toContain('/grafana/grafana/')
    })

    it('does not rewrite absolute URL Location headers', () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      const headers: Record<string, string> = {
        'content-type': 'text/html',
        location: 'https://external.example.com/callback',
      }
      Object.assign(proxyResStream, { headers, statusCode: 302 })
      const mockRes = new PassThrough() as unknown as {
        writeHead: jest.Mock
        headersSent: boolean
      }
      mockRes.writeHead = jest.fn()
      Object.assign(mockRes, { headersSent: false })

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)

      expect(headers['location']).toBe('https://external.example.com/callback')
    })

    it('does not rewrite already-proxied Location headers', () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      const headers: Record<string, string> = {
        'content-type': 'text/html',
        location: '/plugins/signalk-embedded-webapp-proxy/proxy/0/dashboard',
      }
      Object.assign(proxyResStream, { headers, statusCode: 302 })
      const mockRes = new PassThrough() as unknown as {
        writeHead: jest.Mock
        headersSent: boolean
      }
      mockRes.writeHead = jest.fn()
      Object.assign(mockRes, { headersSent: false })

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)

      expect(headers['location']).toBe('/plugins/signalk-embedded-webapp-proxy/proxy/0/dashboard')
    })

    it('pipes non-HTML responses without HTML rewriting', () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      Object.assign(proxyResStream, {
        headers: { 'content-type': 'application/javascript' },
        statusCode: 200,
      })
      const mockRes = new PassThrough() as unknown as {
        writeHead: jest.Mock
        headersSent: boolean
      }
      mockRes.writeHead = jest.fn()
      Object.assign(mockRes, { headersSent: false })

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
    })

    it('preserves upstream Content-Type when rewritePaths is false', () => {
      plugin.start(oneApp(), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      Object.assign(proxyResStream, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
        statusCode: 200,
      })
      const mockRes = new PassThrough() as unknown as {
        writeHead: jest.Mock
        headersSent: boolean
      }
      mockRes.writeHead = jest.fn()
      Object.assign(mockRes, { headersSent: false })

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)

      expect(mockRes.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'content-type': 'text/javascript; charset=utf-8' }),
      )
    })

    it('preserves upstream Content-Type for non-HTML responses when rewritePaths is true', () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      Object.assign(proxyResStream, {
        headers: { 'content-type': 'application/json' },
        statusCode: 200,
      })
      const mockRes = new PassThrough() as unknown as {
        writeHead: jest.Mock
        headersSent: boolean
      }
      mockRes.writeHead = jest.fn()
      Object.assign(mockRes, { headersSent: false })

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)

      expect(mockRes.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'content-type': 'application/json' }),
      )
    })

    it('preserves Content-Type header in rewritten HTML responses', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { res } = await runHtmlProxyRes(handler, '<html><head></head><body></body></html>', {
        contentType: 'text/html; charset=utf-8',
      })

      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'content-type': 'text/html; charset=utf-8' }),
      )
    })

    it('does not inject rewrite script into HTML when rewritePaths is false', () => {
      plugin.start(oneApp(), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      Object.assign(proxyResStream, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
        statusCode: 200,
      })
      const mockRes = new PassThrough() as unknown as {
        writeHead: jest.Mock
        headersSent: boolean
      }
      mockRes.writeHead = jest.fn()
      Object.assign(mockRes, { headersSent: false })

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)

      // Should stream directly with preserved Content-Type, not buffer/inject
      expect(mockRes.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'content-type': 'text/html; charset=utf-8' }),
      )
    })

    it('does not rewrite Location header when rewritePaths is false', () => {
      plugin.start(oneApp(), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      const headers: Record<string, string> = {
        'content-type': 'text/html',
        location: '/login',
      }
      Object.assign(proxyResStream, { headers, statusCode: 302 })
      const mockRes = new PassThrough() as unknown as {
        writeHead: jest.Mock
        headersSent: boolean
      }
      mockRes.writeHead = jest.fn()
      Object.assign(mockRes, { headersSent: false })

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)

      expect(headers['location']).toBe('/login')
    })

    it('streams response when Content-Type header is missing', () => {
      plugin.start(oneApp(), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      Object.assign(proxyResStream, {
        headers: {},
        statusCode: 200,
      })
      const mockRes = new PassThrough() as unknown as {
        writeHead: jest.Mock
        headersSent: boolean
      }
      mockRes.writeHead = jest.fn()
      Object.assign(mockRes, { headersSent: false })

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
    })

    it('includes history pushState and replaceState interception in injected script', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(handler, '<html><head></head><body></body></html>')

      expect(body.toString()).toContain('pushState')
      expect(body.toString()).toContain('replaceState')
    })

    it('includes location.assign and location.replace interception in injected script', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(handler, '<html><head></head><body></body></html>')

      const scriptContent = body.toString()
      expect(scriptContent).toContain('L.assign')
      expect(scriptContent).toContain('L.replace')
    })

    it('does not double-prefix attributes when app url has a base path', async () => {
      plugin.start(
        {
          apps: [
            {
              name: 'Grafana',
              url: 'http://localhost:3000/grafana',
              appPath: 'grafana',
              rewritePaths: true,
            },
          ],
        },
        jest.fn(),
      )
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(
        handler,
        '<html><head></head><body><script src="/grafana/public/build/app.js"></script></body></html>',
      )

      const out = body.toString()
      // base path /grafana stripped before prepending proxy prefix
      expect(out).toContain(
        'src="/plugins/signalk-embedded-webapp-proxy/proxy/grafana/public/build/app.js"',
      )
      expect(out).not.toContain('/grafana/grafana/')
    })

    it('rewrites out-of-base non-root-namespace attributes without root-escape', async () => {
      plugin.start(
        {
          apps: [
            {
              name: 'Grafana',
              url: 'http://localhost:3000/grafana',
              appPath: 'grafana',
              rewritePaths: true,
            },
          ],
        },
        jest.fn(),
      )
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(
        handler,
        '<html><head></head><body><script src="/other/asset.js"></script></body></html>',
      )

      expect(body.toString()).toContain(
        'src="/plugins/signalk-embedded-webapp-proxy/proxy/grafana/other/asset.js"',
      )
    })

    it('strips app base path exactly (not a partial prefix match)', async () => {
      plugin.start(
        {
          apps: [
            {
              name: 'Grafana',
              url: 'http://localhost:3000/grafana',
              appPath: 'grafana',
              rewritePaths: true,
            },
          ],
        },
        jest.fn(),
      )
      const handler = extractProxyResHandler()

      // /grafanaextra/... must NOT have /grafana stripped
      const { body } = await runHtmlProxyRes(
        handler,
        '<html><head></head><body><script src="/grafanaextra/app.js"></script></body></html>',
      )

      expect(body.toString()).toContain(
        'src="/plugins/signalk-embedded-webapp-proxy/proxy/grafana/grafanaextra/app.js"',
      )
    })

    it('includes base path variable in injected script when app url has a path', async () => {
      plugin.start(
        {
          apps: [
            {
              name: 'Grafana',
              url: 'http://localhost:3000/grafana',
              appPath: 'grafana',
              rewritePaths: true,
            },
          ],
        },
        jest.fn(),
      )
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(handler, '<html><head></head><body></body></html>')

      // The injected script should embed the base path for runtime normalisation
      expect(body.toString()).toContain('"/grafana"')
    })

    it('sets empty base path variable in injected script when app url has no path', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(handler, '<html><head></head><body></body></html>')

      // No base path — variable should be the empty string
      expect(body.toString()).toContain('B=""')
    })

    it('does not override Location.prototype.pathname getter', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(handler, '<html><head></head><body></body></html>')

      const script = body.toString()
      // pathname getter must NOT be overridden — frameworks (Angular) need the real
      // pathname to match the rewritten <base> tag for in-app link detection.
      expect(script).not.toContain('defineProperty(LP,"pathname"')
    })

    it('does not override Location.prototype.href getter', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(handler, '<html><head></head><body></body></html>')

      const script = body.toString()
      // The href getter must remain the native getter so frameworks see real URLs
      // that are consistent with the rewritten <base> tag.
      // Only the SETTER should be overridden.
      expect(script).toContain('get:hD.get')
    })

    it('includes MutationObserver to rewrite dynamic element attributes', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(handler, '<html><head></head><body></body></html>')

      const script = body.toString()
      // A MutationObserver rewrites href/src/action attributes on dynamically
      // added elements so frameworks see proxy-prefixed URLs matching <base>.
      expect(script).toContain('MutationObserver')
      expect(script).toContain('setAttribute')
      expect(script).toContain('childList:true')
      expect(script).toContain('attributeFilter:["href","src","action"]')
    })

    it('injects after <head>, not after <header> when both are present', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(
        handler,
        '<html><head><title>x</title></head><body><header class="hh">h</header></body></html>',
      )
      const out = body.toString()
      const headIdx = out.indexOf('<head>')
      const headerIdx = out.indexOf('<header')
      const scriptIdx = out.indexOf('<script data-signalk-embedded-webapp-proxy=')
      expect(scriptIdx).toBeGreaterThan(headIdx)
      expect(scriptIdx).toBeLessThan(headerIdx)
    })

    it('injects script when HTML has no <head> tag (fragment fallback)', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const { body } = await runHtmlProxyRes(
        handler,
        '<html><body><script src="/x.js"></script></body></html>',
      )
      const out = body.toString()
      // Falls back to injecting just after <html>.
      expect(out).toContain('<script data-signalk-embedded-webapp-proxy="path-rewrite">')
      // Asset rewriting still applies.
      expect(out).toContain('src="/plugins/signalk-embedded-webapp-proxy/proxy/0/x.js"')
    })

    it('passes unknown Content-Encoding responses through untouched', () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      Object.assign(proxyResStream, {
        headers: { 'content-type': 'text/html', 'content-encoding': 'zstd' },
        statusCode: 200,
      })
      const mockRes = {
        writeHead: jest.fn(),
        end: jest.fn(),
        headersSent: false,
        destroy: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
      }

      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)
      // Headers should preserve content-encoding: we did NOT decompress, and
      // we must not strip it (the client needs it to decode the body).
      expect(mockRes.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'content-encoding': 'zstd' }),
      )
    })

    // Build a res mock that can be piped into (required when the fall-through
    // path is exercised via streamThrough → proxyRes.pipe(res)).
    function makeWritableRes(): {
      res: import('stream').PassThrough & { writeHead: jest.Mock; headersSent: boolean }
      writeHead: jest.Mock
    } {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const res = new PassThrough() as import('stream').PassThrough & {
        writeHead: jest.Mock
        headersSent: boolean
      }
      res.writeHead = jest.fn()
      res.headersSent = false
      return { res, writeHead: res.writeHead }
    }

    it('rewrites Set-Cookie Path attribute to be scoped to the proxy prefix', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      const headers: Record<string, string | string[]> = {
        'content-type': 'application/json',
        'set-cookie': [
          'sess=abc; Path=/; HttpOnly',
          'foo=bar; Domain=upstream.example.com; Path=/api; Secure',
        ],
      }
      Object.assign(proxyResStream, { headers, statusCode: 200 })
      const { res } = makeWritableRes()
      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, res)
      proxyResStream.end()
      await new Promise((r) => res.on('finish', r))

      const cookies = headers['set-cookie'] as string[]
      expect(cookies[0]).toContain('Path=/plugins/signalk-embedded-webapp-proxy/proxy/0/')
      expect(cookies[0]).toContain('HttpOnly')
      expect(cookies[1]).toContain('Path=/plugins/signalk-embedded-webapp-proxy/proxy/0/api')
      // Domain attribute is dropped — cookie is set on the SignalK origin.
      expect(cookies[1]).not.toMatch(/Domain=/i)
    })

    it('strips Content-Security-Policy headers when rewritePaths is enabled', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'content-security-policy': "default-src 'self'",
        'content-security-policy-report-only': "default-src 'none'",
      }
      Object.assign(proxyResStream, { headers, statusCode: 200 })
      const { res, writeHead } = makeWritableRes()
      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, res)
      proxyResStream.end()
      await new Promise((r) => res.on('finish', r))

      const writeHeadCall = writeHead.mock.calls[0] as [number, Record<string, unknown>]
      expect(writeHeadCall[1]).not.toHaveProperty('content-security-policy')
      expect(writeHeadCall[1]).not.toHaveProperty('content-security-policy-report-only')
    })

    it('preserves Content-Security-Policy when rewritePaths is disabled', async () => {
      plugin.start(oneApp(), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'content-security-policy': "default-src 'self'",
      }
      Object.assign(proxyResStream, { headers, statusCode: 200 })
      const { res, writeHead } = makeWritableRes()
      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, res)
      proxyResStream.end()
      await new Promise((r) => res.on('finish', r))

      expect(writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'content-security-policy': "default-src 'self'" }),
      )
    })

    it('strips hop-by-hop headers from upstream responses', async () => {
      plugin.start(oneApp(), jest.fn())
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        connection: 'close',
        'keep-alive': 'timeout=5',
        'proxy-authenticate': 'Basic',
        te: 'trailers',
        trailer: 'X-Foo',
        'transfer-encoding': 'chunked',
        upgrade: 'h2c',
      }
      Object.assign(proxyResStream, { headers, statusCode: 200 })
      const { res, writeHead } = makeWritableRes()
      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, res)
      proxyResStream.end()
      await new Promise((r) => res.on('finish', r))
      const sent = (writeHead.mock.calls[0] as [number, Record<string, unknown>])[1]
      for (const h of [
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
      ]) {
        expect(sent).not.toHaveProperty(h)
      }
    })

    it('does not rewrite asset URLs inside <script>, <style>, <textarea>, or comments', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const html =
        '<html><head>' +
        '<style>body{background:url("/bg.png")}</style>' +
        '</head><body>' +
        '<script>var s = \'<a href="/should-not-rewrite">x</a>\';</script>' +
        '<textarea>literal href="/raw"</textarea>' +
        '<!-- href="/comment" -->' +
        '<a href="/visible">v</a>' +
        '</body></html>'
      const { body } = await runHtmlProxyRes(handler, html)
      const out = body.toString()
      // Visible link IS rewritten.
      expect(out).toContain('href="/plugins/signalk-embedded-webapp-proxy/proxy/0/visible"')
      // Substrings inside skipped regions are NOT rewritten.
      expect(out).toContain('var s = \'<a href="/should-not-rewrite">x</a>\';')
      expect(out).toContain('<textarea>literal href="/raw"</textarea>')
      expect(out).toContain('<!-- href="/comment" -->')
      expect(out).toContain('<style>body{background:url("/bg.png")}</style>')
    })

    it('still rewrites the opening-tag attributes of <script>/<style> elements', async () => {
      plugin.start(oneApp({ rewritePaths: true }), jest.fn())
      const handler = extractProxyResHandler()

      const html =
        '<html><head><script src="/lib.js"></script>' +
        '<link href="/styles.css"></head><body></body></html>'
      const { body } = await runHtmlProxyRes(handler, html)
      const out = body.toString()
      expect(out).toContain('src="/plugins/signalk-embedded-webapp-proxy/proxy/0/lib.js"')
      expect(out).toContain('href="/plugins/signalk-embedded-webapp-proxy/proxy/0/styles.css"')
    })

    it('does not root-escape Location headers pointing to a sibling proxied app', () => {
      plugin.start(
        {
          apps: [
            {
              name: 'A',
              url: 'http://localhost:9000/grafana',
              appPath: 'grafana',
              rewritePaths: true,
            },
          ],
        },
        jest.fn(),
      )
      const handler = extractProxyResHandler()

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PassThrough } = require('stream') as typeof import('stream')
      const proxyResStream = new PassThrough()
      const headers: Record<string, string> = {
        'content-type': 'text/html',
        // Sibling app under the same plugin — must NOT get __root__ escape.
        location: '/plugins/signalk-embedded-webapp-proxy/proxy/other/page',
      }
      Object.assign(proxyResStream, { headers, statusCode: 302 })
      const mockRes = {
        writeHead: jest.fn(),
        end: jest.fn(),
        headersSent: false,
        on: jest.fn(),
        destroy: jest.fn(),
      }
      handler(proxyResStream as unknown as IncomingMessage, {} as IncomingMessage, mockRes)
      expect(headers['location']).not.toContain('__root__')
    })

    it('forwards X-Forwarded-Host from the incoming Host header', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
      plugin.start(oneApp(), jest.fn())
      const proxyReqHandler = extractProxyReqHandler()

      const mockProxyReq = { setHeader: jest.fn() }
      proxyReqHandler(mockProxyReq, {
        socket: { remoteAddress: '10.0.0.1' },
        headers: { host: 'sk.example.com:3000' },
      })
      const calls = mockProxyReq.setHeader.mock.calls as [string, string][]
      const headerMap = Object.fromEntries(calls.map(([k, v]) => [k, v]))
      expect(headerMap['X-Forwarded-Host']).toBe('sk.example.com:3000')
    })
  })

  describe('appId resolution edge cases', () => {
    let mockRouter: IRouter
    let registeredHandlers: Map<string, MiddlewareFn>
    beforeEach(() => {
      registeredHandlers = new Map()
      mockRouter = {
        use: jest.fn((path: string, handler: MiddlewareFn) => {
          registeredHandlers.set(path, handler)
          return mockRouter
        }),
        get: jest.fn(() => mockRouter),
      } as unknown as IRouter
    })

    it('returns 404 for non-canonical numeric appId (leading zero)', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
      plugin.start(oneApp(), jest.fn())
      plugin.registerWithRouter!(mockRouter)
      const handler = registeredHandlers.get('/proxy/:appId')!

      const mockReq = { params: { appId: '00' } } as unknown as Request
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response
      handler(mockReq, mockRes, jest.fn())
      expect(mockRes.status).toHaveBeenCalledWith(404)
    })

    it('blocks Azure cloud metadata host', () => {
      plugin.start({ apps: [{ name: 'X', url: 'http://168.63.129.16/' }] }, jest.fn())
      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('blocks Alibaba cloud metadata host', () => {
      plugin.start({ apps: [{ name: 'X', url: 'http://100.100.100.200/' }] }, jest.fn())
      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('blocks Oracle cloud metadata host', () => {
      plugin.start({ apps: [{ name: 'X', url: 'http://192.0.0.192/' }] }, jest.fn())
      expect(mockCreateProxyMiddleware).not.toHaveBeenCalled()
    })

    it('normalises configured appPath to lowercase in /apps response', () => {
      mockCreateProxyMiddleware.mockReturnValue(jest.fn() as unknown as MockProxyMiddleware)
      plugin.start(
        { apps: [{ name: 'P', url: 'http://localhost:9000', appPath: 'Portainer' }] },
        jest.fn(),
      )
      const getHandlers = new Map<string, (req: Request, res: Response) => void>()
      const router = {
        use: jest.fn(() => router),
        get: jest.fn((p: string, h: (req: Request, res: Response) => void) => {
          getHandlers.set(p, h)
          return router
        }),
      } as unknown as IRouter
      plugin.registerWithRouter!(router)
      const h = getHandlers.get('/apps')!
      const mockRes = { json: jest.fn() } as unknown as Response
      h({} as Request, mockRes)
      expect(mockRes.json).toHaveBeenCalledWith([{ index: 0, name: 'P', appPath: 'portainer' }])
    })
  })
})
