import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import { Socket } from 'net'
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib'
import { createProxyMiddleware, fixRequestBody, type RequestHandler } from 'http-proxy-middleware'

interface ServerAPIWithServer extends ServerAPI {
  server?: Server
}

type AppScheme = 'http' | 'https'

interface AppConfig {
  name: string
  scheme: AppScheme
  host: string
  port: number
  path: string // base path from URL, e.g. '/' or '/admin'
  allowSelfSigned: boolean
  timeout: number // proxy connection timeout in ms; 0 means no timeout
  appPath: string // custom proxy path identifier; empty means index-only
  rewritePaths: boolean // inject script to rewrite absolute API paths through the proxy
}

const PLUGIN_ID = 'signalk-embedded-webapp-proxy'
const PLUGIN_NAME = 'Embedded Webapp Proxy'

const VALID_SCHEMES = new Set<string>(['http', 'https'])

const HOST_PATTERN = /^[a-zA-Z0-9._-]+$/
const CLOUD_METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal'])

// RFC 7230 §3.2.6 — characters valid in a header field name (HTTP token)
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// Maximum number of apps accepted from configuration.
const MAX_APP_SLOTS = 16

// Pattern for custom app path identifiers — must start with a letter so it
// cannot be confused with a numeric index.
const APP_PATH_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/

const PROXY_SUBPATH = '/proxy'
const PLUGIN_PATH_PREFIX = `/plugins/${PLUGIN_ID}`

function stripInvalidHeaders(req: IncomingMessage): void {
  if (!req.headers) return
  for (const key of Object.keys(req.headers)) {
    if (!HTTP_TOKEN_RE.test(key)) {
      delete req.headers[key]
    }
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '')
}

function isValidHost(host: string): boolean {
  const normalized = normalizeHost(host)
  if (!HOST_PATTERN.test(normalized)) return false
  if (CLOUD_METADATA_HOSTS.has(normalized)) return false
  return true
}

function buildTarget(appConfig: AppConfig): string {
  // Strip trailing slash from path so node-http-proxy doesn't produce double-slashes.
  // A root path '/' becomes '' so the target is scheme://host:port with no path suffix.
  const path = appConfig.path.replace(/\/$/, '')
  return `${appConfig.scheme}://${appConfig.host}:${String(appConfig.port)}${path}`
}

function parseAppConfig(raw: Record<string, unknown>, index: number): AppConfig {
  const rawUrl = typeof raw['url'] === 'string' ? raw['url'].trim() : ''
  if (rawUrl.length === 0) {
    throw new Error(`Missing URL at index ${index}`)
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid URL at index ${index}: "${rawUrl}"`)
  }

  // Only http and https are supported
  const scheme = parsed.protocol.replace(/:$/, '')
  if (!VALID_SCHEMES.has(scheme)) {
    throw new Error(`Unsupported scheme at index ${index}: "${scheme}"`)
  }

  // Reject embedded credentials — they would be forwarded to the target
  if (parsed.username || parsed.password) {
    throw new Error(`URL must not contain credentials at index ${index}`)
  }

  // Reject IPv6 — the URL API strips brackets and returns the bare address (e.g. "::1")
  if (parsed.hostname.includes(':')) {
    throw new Error(`IPv6 addresses are not supported at index ${index}`)
  }

  // Validate hostname (blocks cloud-metadata IPs and unusual characters)
  if (!isValidHost(parsed.hostname)) {
    throw new Error(`Invalid host at index ${index}: "${parsed.hostname}"`)
  }
  const host = normalizeHost(parsed.hostname)

  // URL.port is '' when the URL omits the port; fall back to the scheme default
  const port = parsed.port ? Number(parsed.port) : scheme === 'https' ? 443 : 80

  const path = parsed.pathname

  const allowSelfSigned =
    typeof raw['allowSelfSigned'] === 'boolean' ? raw['allowSelfSigned'] : false
  const rawName = typeof raw['name'] === 'string' ? raw['name'].trim() : ''
  const name = rawName.length > 0 ? rawName : `App ${index}`
  const rawTimeout = raw['timeout']
  if (
    rawTimeout !== undefined &&
    (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout < 0)
  ) {
    throw new Error(`Invalid timeout at index ${index}: must be a non-negative finite number`)
  }
  const timeout = typeof rawTimeout === 'number' ? Math.floor(rawTimeout) : 0

  const rawAppPath = typeof raw['appPath'] === 'string' ? raw['appPath'].trim() : ''
  if (rawAppPath.length > 0) {
    if (!APP_PATH_PATTERN.test(rawAppPath)) {
      throw new Error(
        `Invalid appPath at index ${index}: must start with a letter and contain only letters, digits, and hyphens`,
      )
    }
    if (rawAppPath.length > 64) {
      throw new Error(`appPath at index ${index} exceeds 64 characters`)
    }
  }

  const rewritePaths = typeof raw['rewritePaths'] === 'boolean' ? raw['rewritePaths'] : false

  return {
    name,
    scheme: scheme as AppScheme,
    host,
    port,
    path,
    allowSelfSigned,
    timeout,
    appPath: rawAppPath,
    rewritePaths,
  }
}

function parseConfig(config: object, onSkip: (index: number, err: unknown) => void): AppConfig[] {
  const raw = config as Record<string, unknown>
  const apps = Array.isArray(raw['apps']) ? raw['apps'] : []
  const validObjects = apps
    .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
    .slice(0, MAX_APP_SLOTS)
  const results: AppConfig[] = []
  const seenPaths = new Set<string>()
  for (let i = 0; i < validObjects.length; i++) {
    try {
      const appConfig = parseAppConfig(validObjects[i]!, i)
      if (appConfig.appPath.length > 0) {
        const lower = appConfig.appPath.toLowerCase()
        if (seenPaths.has(lower)) {
          throw new Error(`Duplicate appPath "${appConfig.appPath}" at index ${i}`)
        }
        seenPaths.add(lower)
      }
      results.push(appConfig)
    } catch (err) {
      onSkip(i, err)
    }
  }
  return results
}

function resolveAppIndex(appId: string, apps: AppConfig[]): number {
  if (/^\d+$/.test(appId)) {
    return Number(appId)
  }
  return apps.findIndex((a) => a.appPath.toLowerCase() === appId.toLowerCase())
}

/**
 * Build a <script> tag that patches fetch, XMLHttpRequest, WebSocket,
 * history.pushState/replaceState, and location.assign/replace so absolute
 * paths (e.g. POST /api/auth, history.push('/dashboard')) are routed through
 * the proxy instead of hitting the SignalK server root.  Injected into HTML
 * responses when rewritePaths is enabled.
 *
 * appBasePath is the app's configured URL path (e.g. "/grafana" or "/").
 * When the proxied app generates absolute URLs that include its own base path
 * (e.g. "/grafana/d/..."), the normaliser strips that prefix before prepending
 * the proxy path prefix — preventing double-prefixing like "/proxy/grafana/grafana/d/...".
 */
function buildRewriteScript(proxyPathPrefix: string, appBasePath: string): string {
  const prefix = JSON.stringify(proxyPathPrefix)
  // Normalise: strip trailing slash; "/" becomes "" (no stripping needed).
  const base = appBasePath === '/' ? '' : appBasePath.replace(/\/$/, '')
  const baseJson = JSON.stringify(base)
  return (
    '<script data-signalk-embedded-webapp-proxy="path-rewrite">' +
    '(function(){' +
    `var P=${prefix};` +
    `var B=${baseJson};` +
    // N: strip app base path prefix so we don't double-prefix (e.g. /grafana/d/... → /d/...)
    'function N(s){if(B){if(s.indexOf(B+"/")===0)return s.slice(B.length);if(s===B)return "/"}return s}' +
    // R: true for root-relative paths (/foo) but not protocol-relative (//host) or already-proxied
    "function R(s){return typeof s==='string'&&s.charAt(0)==='/'&&s.charAt(1)!=='/'&&s.indexOf(P)!==0}" +
    // --- fetch ---
    'var F=window.fetch;' +
    'window.fetch=function(u){' +
    'if(R(u)){var a=[P+N(u)];for(var i=1;i<arguments.length;i++)a.push(arguments[i]);' +
    'return F.apply(this,a)}' +
    'return F.apply(this,arguments)};' +
    // --- XMLHttpRequest ---
    'var X=XMLHttpRequest.prototype.open;' +
    'XMLHttpRequest.prototype.open=function(){' +
    'var a=[].slice.call(arguments);' +
    'if(R(a[1]))a[1]=P+N(a[1]);' +
    'return X.apply(this,a)};' +
    // --- WebSocket ---
    'var W=window.WebSocket;if(W){' +
    'window.WebSocket=function(u,p){' +
    'if(R(u)){var l=window.location;' +
    "u=(l.protocol==='https:'?'wss:':'ws:')+'//'+l.host+P+N(u)}" +
    'return p!==undefined?new W(u,p):new W(u)};' +
    'window.WebSocket.prototype=W.prototype;' +
    'window.WebSocket.CONNECTING=W.CONNECTING;' +
    'window.WebSocket.OPEN=W.OPEN;' +
    'window.WebSocket.CLOSING=W.CLOSING;' +
    'window.WebSocket.CLOSED=W.CLOSED}' +
    // --- history.pushState / replaceState ---
    // Intercept SPA navigation so URL bar reflects the proxied path, not the
    // bare app path.  Without this, pushState('/d/dashboard') would change the
    // iframe URL to /d/dashboard on the SignalK origin — causing "Cannot GET".
    'var H=window.history;if(H&&H.pushState){' +
    'var OP=H.pushState.bind(H);' +
    'var OR=H.replaceState.bind(H);' +
    'H.pushState=function(s,t,u){if(R(u))u=P+N(u);return OP(s,t,u)};' +
    'H.replaceState=function(s,t,u){if(R(u))u=P+N(u);return OR(s,t,u)};}' +
    // --- window.location.assign / replace ---
    // Catch hard-redirect style navigation (location.assign('/login')).
    'try{var L=window.location;' +
    'var LA=L.assign.bind(L);var LR=L.replace.bind(L);' +
    'L.assign=function(u){if(R(u))u=P+N(u);return LA(u)};' +
    'L.replace=function(u){if(R(u))u=P+N(u);return LR(u)};}catch(e){}' +
    // --- Location.prototype.href setter ---
    // Intercept location.href = '/path' so it navigates through the proxy.
    // The getter is NOT overridden — Angular and other frameworks need the
    // real pathname/href to match the rewritten <base> tag.
    'try{var LP=Location.prototype;' +
    'var hD=Object.getOwnPropertyDescriptor(LP,"href");' +
    'if(hD&&hD.set){var hS=hD.set;' +
    'Object.defineProperty(LP,"href",{get:hD.get,' +
    'set:function(v){if(R(v))v=P+N(v);return hS.call(this,v)},' +
    'configurable:true,enumerable:true})}' +
    '}catch(e){}' +
    // --- DOM MutationObserver ---
    // Rewrite href/src/action attributes on dynamically added elements so
    // frameworks (Angular, React) see proxy-prefixed URLs that match the
    // rewritten <base> tag.  Without this, links rendered from JS data
    // (e.g. navTree "/grafana/dashboards") escape the proxy.
    // R() returns false for already-proxied values, preventing infinite loops
    // when setAttribute triggers a new attribute mutation.
    'function RW(el){' +
    'if(el.nodeType!==1)return;' +
    'var aa=["href","src","action"];' +
    'for(var i=0;i<aa.length;i++){var v=el.getAttribute(aa[i]);if(v&&R(v))el.setAttribute(aa[i],P+N(v))}' +
    'var ch=el.querySelectorAll?el.querySelectorAll("[href],[src],[action]"):[];' +
    'for(var j=0;j<ch.length;j++){' +
    'for(var k=0;k<aa.length;k++){var w=ch[j].getAttribute(aa[k]);if(w&&R(w))ch[j].setAttribute(aa[k],P+N(w))}' +
    '}}' +
    'var MO=window.MutationObserver;if(MO){' +
    'new MO(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];' +
    'if(m.type==="childList"){for(var j=0;j<m.addedNodes.length;j++)RW(m.addedNodes[j])}' +
    'else if(m.type==="attributes"){var v=m.target.getAttribute(m.attributeName);' +
    'if(v&&R(v))m.target.setAttribute(m.attributeName,P+N(v))}' +
    '}}).observe(document.documentElement,{childList:true,subtree:true,' +
    'attributes:true,attributeFilter:["href","src","action"]})}' +
    '})()' +
    '</script>'
  )
}

module.exports = function (app: ServerAPIWithServer): Plugin {
  let proxies: RequestHandler[] = []
  let currentApps: AppConfig[] = []
  let started = false
  let upgradeHandler: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null = null

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'General reverse proxy — embed any web application as a webapp in SignalK',

    start(config: object, _restart: (newConfiguration: object) => void): void {
      // Remove any previous upgrade listener (handles plugin restart without an explicit stop)
      if (upgradeHandler && app.server) {
        app.server.removeListener('upgrade', upgradeHandler)
        upgradeHandler = null
      }

      currentApps = parseConfig(config, (i, err) => {
        app.error(`Skipping app at config index ${i}: ${String(err)}`)
      })

      proxies = currentApps.map((appConfig, appIndex) => {
        const proxyPathPrefix = `${PLUGIN_PATH_PREFIX}${PROXY_SUBPATH}/${appConfig.appPath || String(appIndex)}`

        return createProxyMiddleware({
          target: buildTarget(appConfig),
          changeOrigin: true,
          ws: false,
          secure: !(appConfig.scheme === 'https' && appConfig.allowSelfSigned),
          ...(appConfig.timeout > 0 ? { proxyTimeout: appConfig.timeout } : {}),
          // selfHandleResponse is required so the proxyRes handler below can
          // choose between streaming non-HTML responses and buffering HTML ones.
          ...(appConfig.rewritePaths ? { selfHandleResponse: true } : {}),
          on: {
            proxyReq(proxyReq, req): void {
              // Re-stream the request body when an upstream body-parser
              // (e.g. SignalK's global bodyParser.json()) has already
              // consumed the raw body.  Without this, POST/PUT/PATCH
              // requests (like Portainer's /api/auth login) arrive at
              // the target with an empty body.
              fixRequestBody(proxyReq, req)
              const remoteAddress = req.socket?.remoteAddress ?? ''
              proxyReq.setHeader('X-Real-IP', remoteAddress)
              const existing = req.headers['x-forwarded-for']
              const forwarded = existing ? `${String(existing)}, ${remoteAddress}` : remoteAddress
              proxyReq.setHeader('X-Forwarded-For', forwarded)
              const incomingProto = req.headers['x-forwarded-proto']
              const rawProto =
                typeof incomingProto === 'string' ? incomingProto : (incomingProto?.[0] ?? '')
              const proto =
                rawProto.split(',')[0]?.trim() ||
                ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http')
              proxyReq.setHeader('X-Forwarded-Proto', proto)
              if (appConfig.rewritePaths) {
                // Only advertise encodings we can decompress for HTML script injection.
                proxyReq.setHeader('Accept-Encoding', 'gzip, deflate, br, identity')
              }
            },
            ...(appConfig.rewritePaths
              ? {
                  proxyRes(
                    proxyRes: IncomingMessage,
                    _req: IncomingMessage,
                    res: ServerResponse,
                  ): void {
                    const ct = String(proxyRes.headers['content-type'] ?? '')
                    const status = proxyRes.statusCode ?? 200

                    // Rewrite Location headers on redirects so the browser
                    // follows through the proxy instead of hitting the host root.
                    // e.g. "Location: /grafana/login" → "Location: /plugins/signalk-embedded-webapp-proxy/proxy/grafana/login"
                    if (proxyRes.headers['location']) {
                      const loc = String(proxyRes.headers['location'])
                      // Only rewrite root-relative paths (not absolute URLs or protocol-relative)
                      if (
                        loc.charAt(0) === '/' &&
                        loc.charAt(1) !== '/' &&
                        !loc.startsWith(proxyPathPrefix)
                      ) {
                        const appPathBase =
                          appConfig.path === '/' ? '' : appConfig.path.replace(/\/$/, '')
                        const normalizedLoc =
                          appPathBase && loc.startsWith(appPathBase + '/')
                            ? loc.slice(appPathBase.length)
                            : appPathBase && loc === appPathBase
                              ? '/'
                              : loc
                        proxyRes.headers['location'] = `${proxyPathPrefix}${normalizedLoc}`
                      }
                    }

                    if (!ct.includes('text/html')) {
                      // Stream non-HTML (SSE, assets, API responses) directly without buffering.
                      const headers = { ...proxyRes.headers }
                      delete headers['transfer-encoding']
                      res.writeHead(status, headers)
                      proxyRes.pipe(res)
                      return
                    }

                    // HTML: decompress if needed, inject path-rewriting script, then send.
                    const encoding = String(
                      proxyRes.headers['content-encoding'] ?? '',
                    ).toLowerCase()
                    const stream: NodeJS.ReadableStream =
                      encoding === 'gzip' || encoding === 'x-gzip'
                        ? proxyRes.pipe(createGunzip())
                        : encoding === 'deflate'
                          ? proxyRes.pipe(createInflate())
                          : encoding === 'br'
                            ? proxyRes.pipe(createBrotliDecompress())
                            : proxyRes
                    const chunks: Buffer[] = []
                    stream.on('data', (chunk: Buffer) => {
                      chunks.push(chunk)
                    })
                    stream.on('end', () => {
                      const html = Buffer.concat(chunks).toString('utf-8')
                      const script = buildRewriteScript(proxyPathPrefix, appConfig.path)
                      const injected = html.replace(/<head[^>]*>/i, (m) => m + script)
                      // Rewrite absolute-path src/href/action attributes so static assets
                      // and form actions route through the proxy instead of hitting the
                      // host root.  Protocol-relative URLs (//…) are left untouched.
                      // When the app has a configured base path (e.g. /grafana), strip it
                      // from matching URLs before prepending the proxy prefix to prevent
                      // double-prefixing (e.g. /grafana/d/... → /proxy/grafana/d/..., not
                      // /proxy/grafana/grafana/d/...).
                      const appPathBase =
                        appConfig.path === '/' ? '' : appConfig.path.replace(/\/$/, '')
                      const rewritten = injected.replace(
                        /((?:src|href|action)=["'])(\/[^"']*)/gi,
                        (match, attr: string, url: string) => {
                          if (url.startsWith('//')) return match // protocol-relative
                          if (url.startsWith(proxyPathPrefix)) return match // already proxied
                          const normalizedUrl =
                            appPathBase && url.startsWith(appPathBase + '/')
                              ? url.slice(appPathBase.length)
                              : appPathBase && url === appPathBase
                                ? '/'
                                : url
                          return `${attr}${proxyPathPrefix}${normalizedUrl}`
                        },
                      )
                      const buf = Buffer.from(rewritten, 'utf-8')
                      const headers = { ...proxyRes.headers }
                      delete headers['content-encoding'] // we decompressed
                      delete headers['transfer-encoding']
                      headers['content-length'] = String(buf.length)
                      res.writeHead(status, headers)
                      res.end(buf)
                    })
                    stream.on('error', () => {
                      if (!res.headersSent) {
                        res.writeHead(502, { 'Content-Type': 'text/plain' })
                      }
                      res.end('Bad Gateway: decompression error')
                    })
                  },
                }
              : {}),
            error(err: Error, _req: IncomingMessage, res: ServerResponse | Socket): void {
              app.error(`Web proxy error: ${err.message}`)
              if (res instanceof Socket) {
                res.destroy()
                return
              }
              if (res.headersSent) {
                res.end()
                return
              }
              res.writeHead(502, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Application is not reachable' }))
            },
          },
        })
      })

      started = true

      if (app.server && proxies.length > 0) {
        // Forward WebSocket upgrades to the correct per-app proxy.
        // ws:false above means http-proxy-middleware does NOT auto-intercept
        // upgrades; we dispatch manually so only our plugin paths are affected.
        upgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
          const prefix = `${PLUGIN_PATH_PREFIX}${PROXY_SUBPATH}/`
          if (!req.url?.startsWith(prefix)) return // not our path — ignore
          // URL matched our prefix; any failure from here closes the socket with 404.
          const reject404 = (): void => {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
            socket.end()
          }
          const rest = req.url.substring(prefix.length) // e.g. "portainer/api/websocket/exec?token=x"
          const queryIdx = rest.indexOf('?')
          const pathPart = queryIdx >= 0 ? rest.substring(0, queryIdx) : rest
          const queryString = queryIdx >= 0 ? rest.substring(queryIdx) : ''
          const slash = pathPart.indexOf('/')
          const appId = slash >= 0 ? pathPart.substring(0, slash) : pathPart
          const index = resolveAppIndex(appId, currentApps)
          if (index < 0 || index >= proxies.length) {
            reject404()
            return
          }
          const targetProxy = proxies[index]
          if (!targetProxy) {
            reject404()
            return
          }
          const proxyUpgrade = targetProxy.upgrade
          if (!proxyUpgrade) {
            reject404()
            return
          }
          stripInvalidHeaders(req)
          req.url = (slash >= 0 ? pathPart.substring(slash) : '/') + queryString
          proxyUpgrade.call(targetProxy, req, socket, head)
        }
        app.server.on('upgrade', upgradeHandler)
      }
    },

    stop(): void {
      if (upgradeHandler && app.server) {
        app.server.removeListener('upgrade', upgradeHandler)
      }
      upgradeHandler = null
      proxies = []
      currentApps = []
      started = false
    },

    registerWithRouter(router: IRouter): void {
      // List configured apps — consumed by the React UI on load.
      router.get('/apps', (_req: Request, res: Response): void => {
        const list = currentApps.map((a, i) => ({
          index: i,
          name: a.name,
          ...(a.appPath ? { appPath: a.appPath } : {}),
        }))
        res.json(list)
      })

      // Single parameterized route handles both numeric indices (e.g. /proxy/0)
      // and custom appPath identifiers (e.g. /proxy/portainer).
      router.use(
        `${PROXY_SUBPATH}/:appId`,
        (req: Request, res: Response, next: () => void): void => {
          stripInvalidHeaders(req as unknown as IncomingMessage)
          const rawAppId = req.params['appId']
          const appId = typeof rawAppId === 'string' ? rawAppId : (rawAppId?.[0] ?? '')
          if (!started) {
            res.status(503).json({ error: 'Plugin is not started' })
            return
          }
          const idx = resolveAppIndex(appId, currentApps)
          const proxy = idx >= 0 && idx < proxies.length ? proxies[idx] : undefined
          if (proxy) {
            ;(proxy as (req: Request, res: Response, next: () => void) => void)(req, res, next)
          } else {
            res.status(404).json({ error: `No app found for "${appId}"` })
          }
        },
      )
    },

    schema() {
      return {
        type: 'object' as const,
        title: 'Embedded Webapp Proxy Configuration',
        description: 'Configure one or more web applications to embed in SignalK',
        properties: {
          apps: {
            type: 'array' as const,
            title: 'Web Applications',
            description: 'List of web applications to proxy',
            items: {
              type: 'object' as const,
              title: 'Application',
              required: ['url'] as const,
              properties: {
                name: {
                  type: 'string' as const,
                  title: 'Name',
                  description: 'Display name shown in the app selector',
                  default: 'My App',
                },
                appPath: {
                  type: 'string' as const,
                  title: 'Proxy Path',
                  description:
                    'Custom path identifier (e.g. "portainer"). When set, the app is accessible at /plugins/signalk-embedded-webapp-proxy/proxy/<appPath> in addition to its numeric index. Must start with a letter; only letters, digits, and hyphens allowed.',
                  pattern: '^[a-zA-Z][a-zA-Z0-9-]*$',
                  minLength: 1,
                  maxLength: 64,
                },
                url: {
                  type: 'string' as const,
                  title: 'Application URL',
                  description:
                    'URL of the application — protocol and host are required, port is optional (defaults to 80 for http, 443 for https), base path is optional — e.g. http://192.168.1.100:9000 or https://myapp.local/admin',
                  default: 'http://127.0.0.1',
                },
                allowSelfSigned: {
                  type: 'boolean' as const,
                  title: 'Allow Self-Signed Certificates',
                  description: 'Accept self-signed TLS certificates (HTTPS only)',
                  default: false,
                },
                rewritePaths: {
                  type: 'boolean' as const,
                  title: 'Rewrite Absolute Paths',
                  description:
                    'Inject a script into HTML responses that rewrites absolute API paths (e.g. /api/auth) so they route through the proxy. Enable this for SPAs like Portainer or Grafana whose frontend uses absolute paths — eliminates the need for --base-url on the target container.',
                  default: false,
                },
                timeout: {
                  type: 'number' as const,
                  title: 'Proxy Timeout',
                  description:
                    'Milliseconds to wait for the target to respond before returning a 502. 0 disables the timeout.',
                  default: 0,
                  minimum: 0,
                },
              },
            },
          },
        },
      }
    },

    statusMessage(): string {
      if (!started) return 'Not started'
      if (currentApps.length === 0) return 'No apps configured'
      const targets = currentApps.map((a) => buildTarget(a)).join(', ')
      return `Proxying to: ${targets}`
    },
  }

  return plugin
}
