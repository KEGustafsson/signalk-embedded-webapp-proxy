import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import type { ClientRequest, IncomingMessage, Server, ServerResponse } from 'http'
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
// Hostnames that resolve to cloud-instance metadata services. Blocking these
// at config-validation time prevents the most common SSRF target. DNS
// rebinding (a configured hostname later resolving to one of these IPs) is
// not addressed here — operators should restrict the plugin to trusted
// internal apps as documented in the README.
const CLOUD_METADATA_HOSTS = new Set([
  '169.254.169.254', // AWS, GCP, OpenStack, DigitalOcean
  'metadata.google.internal', // GCP
  '100.100.100.200', // Alibaba Cloud
  '192.0.0.192', // Oracle Cloud
  '168.63.129.16', // Azure (wireserver)
])

// RFC 7230 §3.2.6 — characters valid in a header field name (HTTP token)
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// Hop-by-hop headers per RFC 7230 §6.1 — must not be forwarded across a proxy.
// (Some, like 'connection' and 'transfer-encoding', are also handled by the
// underlying proxy library; explicit removal here is defensive.)
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

// Maximum number of apps accepted from configuration.
const MAX_APP_SLOTS = 16

// Cap the in-memory buffer used when injecting the path-rewrite script into
// HTML responses.  Anything larger streams through unmodified to avoid OOM
// from a misbehaving or hostile upstream.
const MAX_HTML_REWRITE_BYTES = 10 * 1024 * 1024 // 10 MiB

// Pattern for custom app path identifiers — must start with a letter so it
// cannot be confused with a numeric index.
const APP_PATH_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/

const PROXY_SUBPATH = '/proxy'
const PLUGIN_PATH_PREFIX = `/plugins/${PLUGIN_ID}`

// Escape segment used to route paths that fall outside the app's configured
// base path directly to the target host root. The rewrite script emits
// /<proxyPrefix>/__root__/<path> for those URLs; the HTTP and WS upgrade
// handlers strip the marker and dispatch to a host-only proxy.
const ROOT_ESCAPE = '/__root__'

// SignalK server root namespaces that sit above any embedded app's base path.
// Only URLs starting with one of these get routed through the host-only proxy
// via /__root__. Other outside-of-base URLs are left to the main proxy so
// embedded apps with sub-path APIs (e.g. Grafana /api/...) keep working.
const ROOT_NAMESPACES = ['/plugins/', '/signalk/', '/admin/', '/skServer/']

function isRootNamespace(path: string): boolean {
  // Never escape paths that already belong to this plugin — preserves routing
  // between sibling apps configured on the same plugin instance.
  if (path.startsWith(`${PLUGIN_PATH_PREFIX}/`) || path === PLUGIN_PATH_PREFIX) return false
  return ROOT_NAMESPACES.some((ns) => path.startsWith(ns))
}

// Compute the suffix that should follow proxyPathPrefix for a root-relative
// URL — strips the app's base path, escapes SignalK root namespaces, and
// passes everything else through unchanged. Centralises the logic shared by
// Location, attribute, and Set-Cookie rewriting paths.
function computeProxiedSuffix(url: string, appBasePath: string): string {
  const base = appBasePath === '/' ? '' : appBasePath.replace(/\/$/, '')
  // When the app has no base path, the main proxy already targets the host
  // root, so there is nothing to escape — return the URL unchanged. This
  // mirrors the client-side T() in buildRewriteScript, which also short-circuits
  // on empty base. Emitting /__root__ here would route to pair.root, which is
  // never created when path='/' (needsRoot is false), yielding a 404.
  if (!base) return url
  if (url.startsWith(base + '/')) return url.slice(base.length)
  if (url === base) return '/'
  if (isRootNamespace(url)) return `${ROOT_ESCAPE}${url}`
  return url
}

// Rewrite the Path attribute of one or more Set-Cookie header values so the
// browser sends the cookie back when requesting the proxied app.  Without
// this, upstream cookies set with Path=/ (or Path=/api) would be stored
// against the SignalK origin but with paths that never match the proxy URL
// space, silently breaking session-based auth (e.g. Portainer login).
//
// Also strips Domain attributes — at this layer the cookie will be set on the
// SignalK origin regardless, and a stale Domain pointing at the upstream host
// would just cause the browser to drop the cookie.
function rewriteSetCookie(
  values: string[],
  proxyPathPrefix: string,
  appBasePath: string,
): string[] {
  return values.map((cookie) => {
    const parts = cookie.split(';')
    const out: string[] = []
    for (const raw of parts) {
      const part = raw.trim()
      if (!part) continue
      const eq = part.indexOf('=')
      const name = (eq >= 0 ? part.slice(0, eq) : part).trim().toLowerCase()
      if (name === 'domain') {
        // Drop Domain — the cookie is being set at the SignalK origin.
        continue
      }
      if (name === 'path') {
        const value = eq >= 0 ? part.slice(eq + 1).trim() : ''
        if (
          value.charAt(0) === '/' &&
          !value.startsWith(proxyPathPrefix + '/') &&
          value !== proxyPathPrefix
        ) {
          const suffix = computeProxiedSuffix(value, appBasePath)
          out.push(`Path=${proxyPathPrefix}${suffix}`)
          continue
        }
      }
      out.push(part)
    }
    return out.join('; ')
  })
}

// Rewrite absolute-path values in src/href/action HTML attributes while
// preserving the *bodies* of <script>, <style>, <textarea>, and HTML
// comments verbatim — those can contain URL-attribute-shaped substrings
// (string literals, CSS, escaped sample text) that must not be touched.
// Opening-tag attributes (e.g. <script src="…">) are still rewritten.
function rewriteHtmlAttributes(html: string, proxyPathPrefix: string, appBasePath: string): string {
  const attrRe = /((?:src|href|action)=["'])(\/[^"']*)/gi
  const replaceAttr = (_m: string, attr: string, url: string): string => {
    if (url.startsWith('//')) return `${attr}${url}` // protocol-relative
    if (url.startsWith(proxyPathPrefix)) return `${attr}${url}` // already proxied
    return `${attr}${proxyPathPrefix}${computeProxiedSuffix(url, appBasePath)}`
  }
  // Match an HTML comment OR the opening tag of an element whose contents we
  // must preserve verbatim.  Comments are kept as-is; opening tags are
  // attribute-rewritten and their bodies passed through unchanged.
  const boundaryRe = /<!--[\s\S]*?-->|<(script|style|textarea)\b[^>]*>/gi
  let out = ''
  let i = 0
  let m: RegExpExecArray | null
  while ((m = boundaryRe.exec(html)) !== null) {
    out += html.slice(i, m.index).replace(attrRe, replaceAttr)
    if (!m[1]) {
      // Comment — append verbatim.
      out += m[0]
      i = m.index + m[0].length
      boundaryRe.lastIndex = i
      continue
    }
    // Opening <script>/<style>/<textarea> — rewrite its attributes, then skip
    // until the matching closing tag.
    out += m[0].replace(attrRe, replaceAttr)
    const bodyStart = m.index + m[0].length
    const closeRe = new RegExp(`</${m[1]}\\s*>`, 'i')
    const closeMatch = closeRe.exec(html.slice(bodyStart))
    if (!closeMatch) {
      // No closing tag — keep the rest of the document verbatim.
      out += html.slice(bodyStart)
      i = html.length
      break
    }
    const closeEnd = bodyStart + closeMatch.index + closeMatch[0].length
    out += html.slice(bodyStart, closeEnd)
    i = closeEnd
    boundaryRe.lastIndex = closeEnd
  }
  out += html.slice(i).replace(attrRe, replaceAttr)
  return out
}

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

function buildRootTarget(appConfig: AppConfig): string {
  // Host-only target for root-escaped requests (e.g. /plugins/<other>/ws calls
  // from within a path-scoped proxied webapp).
  return `${appConfig.scheme}://${appConfig.host}:${String(appConfig.port)}`
}

// Build the http(s)://host[:port] string that matches what `changeOrigin:true`
// writes into the outgoing Host header (see http-proxy common.js setupOutgoing).
// When the port is the scheme default (80/443), http-proxy omits it from Host;
// mirror that here so Origin and Host stay in sync on strict upstreams.
function computeTargetOrigin(appConfig: AppConfig): string {
  const isDefaultPort =
    (appConfig.scheme === 'http' && appConfig.port === 80) ||
    (appConfig.scheme === 'https' && appConfig.port === 443)
  const hostPort = isDefaultPort ? appConfig.host : `${appConfig.host}:${String(appConfig.port)}`
  return `${appConfig.scheme}://${hostPort}`
}

// Apply X-Real-IP / X-Forwarded-* to an outgoing proxied request. Shared between
// HTTP (`proxyReq`) and WebSocket upgrade (`proxyReqWs`) hooks — the only
// difference is the default protocol label ("http"/"https" vs "ws"/"wss").
// If the incoming request already carries X-Forwarded-Proto (we're behind
// another reverse proxy), its first value wins so the full chain is preserved.
function applyForwardedHeaders(
  proxyReq: ClientRequest,
  req: IncomingMessage,
  defaultProto: string,
): void {
  const remoteAddress = req.socket?.remoteAddress ?? ''
  proxyReq.setHeader('X-Real-IP', remoteAddress)
  const existing = req.headers['x-forwarded-for']
  const forwarded = existing ? `${String(existing)}, ${remoteAddress}` : remoteAddress
  proxyReq.setHeader('X-Forwarded-For', forwarded)
  const incomingProto = req.headers['x-forwarded-proto']
  const rawProto = typeof incomingProto === 'string' ? incomingProto : (incomingProto?.[0] ?? '')
  const proto = rawProto.split(',')[0]?.trim() || defaultProto
  proxyReq.setHeader('X-Forwarded-Proto', proto)
  // Forward the original Host so upstream apps that build absolute URLs (share
  // links, OAuth callbacks) can still reach this proxy. changeOrigin: true
  // rewrites the wire Host header to the target, so X-Forwarded-Host is the
  // only way to communicate the original.
  const incomingHost = req.headers['host']
  if (typeof incomingHost === 'string' && incomingHost.length > 0) {
    proxyReq.setHeader('X-Forwarded-Host', incomingHost)
  }
}

// Rewrite the outgoing Origin header so upstream apps that enforce same-origin
// WebSocket / CORS policy see a value matching the target host (which
// changeOrigin:true has already rewritten into the Host header). The original
// Origin is preserved in X-Forwarded-Host via applyForwardedHeaders, so apps
// that need it can still recover it.
//
// SECURITY: Only rewrite when the incoming Origin matches the proxy's own
// origin (a legitimate same-site request from the embedded iframe).
// Cross-origin values MUST be passed through unchanged so upstream CSRF /
// origin-based protections can evaluate them — an unconditional rewrite would
// forge cross-site requests into same-origin ones and bypass those defenses
// whenever auth cookies are attached. Leaves Origin untouched when the
// incoming request has no Origin header (non-browser clients).
function rewriteOriginHeader(
  proxyReq: ClientRequest,
  req: IncomingMessage,
  targetOrigin: string,
): void {
  const incoming = req.headers['origin']
  const origin =
    typeof incoming === 'string' ? incoming : Array.isArray(incoming) ? (incoming[0] ?? '') : ''
  if (origin.length === 0) return

  const host = req.headers['host']
  if (typeof host !== 'string' || host.length === 0) return

  // Trust X-Forwarded-Proto if SignalK itself sits behind a TLS terminator,
  // otherwise fall back to the socket's encrypted flag.
  const xfp = req.headers['x-forwarded-proto']
  const rawProto = typeof xfp === 'string' ? xfp : Array.isArray(xfp) ? (xfp[0] ?? '') : ''
  const fwdProto = rawProto.split(',')[0]?.trim()
  const scheme =
    fwdProto === 'http' || fwdProto === 'https'
      ? fwdProto
      : (req.socket as { encrypted?: boolean }).encrypted
        ? 'https'
        : 'http'

  const proxyOrigin = `${scheme}://${host}`
  if (origin !== proxyOrigin) return

  proxyReq.setHeader('Origin', targetOrigin)
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
  // Normalise to lowercase so the URL space is canonical — prevents two
  // distinct cache/cookie scopes (/proxy/Portainer vs /proxy/portainer) for
  // the same app while preserving the case-insensitive duplicate check below.
  const appPath = rawAppPath.toLowerCase()

  const rewritePaths = typeof raw['rewritePaths'] === 'boolean' ? raw['rewritePaths'] : false

  return {
    name,
    scheme: scheme as AppScheme,
    host,
    port,
    path,
    allowSelfSigned,
    timeout,
    appPath,
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
        // appConfig.appPath is already lowercased by parseAppConfig.
        if (seenPaths.has(appConfig.appPath)) {
          throw new Error(`Duplicate appPath "${appConfig.appPath}" at index ${i}`)
        }
        seenPaths.add(appConfig.appPath)
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
    // Reject non-canonical numeric forms (e.g. "00", "01") so the URL space
    // remains 1:1 with the app — distinct cache/cookie scopes for the same
    // index are otherwise possible.
    if (appId.length > 1 && appId.startsWith('0')) return -1
    return Number(appId)
  }
  return apps.findIndex((a) => a.appPath === appId.toLowerCase())
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
// Escape '<' so JSON-stringified literals embedded in an inline <script> tag
// cannot break out via "</script>". URL pathnames and validated appPath values
// never contain '<' in practice, but defensive escaping is cheap insurance.
function jsLiteral(s: string): string {
  return JSON.stringify(s).replace(/</g, '\\u003c')
}

function buildRewriteScript(proxyPathPrefix: string, appBasePath: string): string {
  const prefix = jsLiteral(proxyPathPrefix)
  // Normalise: strip trailing slash; "/" becomes "" (no stripping needed).
  const base = appBasePath === '/' ? '' : appBasePath.replace(/\/$/, '')
  const baseJson = jsLiteral(base)
  return (
    '<script data-signalk-embedded-webapp-proxy="path-rewrite">' +
    '(function(){' +
    `var P=${prefix};` +
    `var B=${baseJson};` +
    // T: transform a root-relative path into the suffix that follows the proxy prefix.
    //    - Inside B (app base): strip B so the upstream target's base path isn't double-prefixed.
    //    - Outside B but inside a known SignalK-server root namespace (/plugins/, /signalk/,
    //      /admin/, /skServer/): prepend __root__ so the server routes through the host-only
    //      proxy (e.g. onvif webapp reaching /plugins/signalk-onvif-camera/ws).
    //    - Otherwise: pass through unchanged so the main proxy forwards the path to
    //      target+base (e.g. Grafana XHR to /api/frontend/settings → upstream /grafana/api/...).
    //    - When B is empty, the target has no base path so nothing to strip or escape.
    'function T(s){if(!B)return s;' +
    'if(s.indexOf(B+"/")===0)return s.slice(B.length);' +
    'if(s===B)return "/";' +
    'if(s.indexOf("/plugins/")===0||s.indexOf("/signalk/")===0||s.indexOf("/admin/")===0||s.indexOf("/skServer/")===0)return "/__root__"+s;' +
    'return s}' +
    // R: true for root-relative paths (/foo) but not protocol-relative (//host) or already-proxied
    "function R(s){return typeof s==='string'&&s.charAt(0)==='/'&&s.charAt(1)!=='/'&&s.indexOf(P)!==0}" +
    // X: normalize a URL string (root-relative OR absolute same-origin) and apply
    // proxy prefix + T. Returns input unchanged if it's not something we rewrite.
    'function Y(s){if(typeof s!=="string")return s;' +
    'if(s.indexOf(P)===0)return s;' +
    'var p=null;' +
    'if(s.charAt(0)==="/"&&s.charAt(1)!=="/")p=s;' +
    'else{var mm=s.match(/^https?:\\/\\/([^\\/?#]+)(.*)$/);' +
    'if(mm&&mm[1]===location.host)p=mm[2]||"/"}' +
    'if(p===null)return s;' +
    'if(p.indexOf(P)===0)return s;' +
    'return P+T(p)}' +
    // --- fetch ---
    'var F=window.fetch;' +
    'window.fetch=function(u){' +
    'var nu=Y(u);if(nu!==u){var a=[nu];for(var i=1;i<arguments.length;i++)a.push(arguments[i]);' +
    'return F.apply(this,a)}' +
    'return F.apply(this,arguments)};' +
    // --- XMLHttpRequest ---
    'var X=XMLHttpRequest.prototype.open;' +
    'XMLHttpRequest.prototype.open=function(){' +
    'var a=[].slice.call(arguments);' +
    'if(typeof a[1]==="string")a[1]=Y(a[1]);' +
    'return X.apply(this,a)};' +
    // --- WebSocket ---
    // Apps often build WS URLs as full strings (ws://<location.host>/path) before
    // calling new WebSocket(), so we also match full ws(s):// URLs whose host
    // matches the current page host and rewrite them through the proxy.
    // URL objects (new WebSocket(new URL(...))) are coerced to strings so the
    // same rewrite applies — without this, apps like Portainer that build WS
    // URLs via the URL constructor would bypass the proxy.
    'var W=window.WebSocket;if(W){' +
    'window.WebSocket=function(u,p){' +
    'var l=window.location;' +
    'var us=(typeof u==="string")?u:(u&&typeof u.href==="string")?String(u):null;' +
    'if(us!==null){' +
    'var m=us.match(/^wss?:\\/\\/([^/?#]+)([/?#].*)?$/);' +
    'if(m&&m[1]===l.host){var pt=m[2]||"/";' +
    'if(pt.charAt(0)==="/"&&pt.indexOf(P)!==0)' +
    "u=(l.protocol==='https:'?'wss:':'ws:')+'//'+l.host+P+T(pt)}" +
    'else if(R(us))' +
    "u=(l.protocol==='https:'?'wss:':'ws:')+'//'+l.host+P+T(us)}" +
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
    'H.pushState=function(s,t,u){if(typeof u==="string")u=Y(u);return OP(s,t,u)};' +
    'H.replaceState=function(s,t,u){if(typeof u==="string")u=Y(u);return OR(s,t,u)};}' +
    // --- window.location.assign / replace ---
    // Catch hard-redirect style navigation (location.assign('/login')).
    'try{var L=window.location;' +
    'var LA=L.assign.bind(L);var LR=L.replace.bind(L);' +
    'L.assign=function(u){if(typeof u==="string")u=Y(u);return LA(u)};' +
    'L.replace=function(u){if(typeof u==="string")u=Y(u);return LR(u)};}catch(e){}' +
    // --- Location.prototype.href setter ---
    // Intercept location.href = '/path' so it navigates through the proxy.
    // The getter is NOT overridden — Angular and other frameworks need the
    // real pathname/href to match the rewritten <base> tag.
    'try{var LP=Location.prototype;' +
    'var hD=Object.getOwnPropertyDescriptor(LP,"href");' +
    'if(hD&&hD.set){var hS=hD.set;' +
    'Object.defineProperty(LP,"href",{get:hD.get,' +
    'set:function(v){if(typeof v==="string")v=Y(v);return hS.call(this,v)},' +
    'configurable:true,enumerable:true})}' +
    '}catch(e){}' +
    // --- HTMLImageElement.prototype.src setter ---
    // MutationObserver fires asynchronously, so by the time we rewrite an
    // attribute mutation the browser has already kicked off the image request
    // with the unrewritten URL.  Override the src setter synchronously so
    // img.src = "/plugins/foo/snapshot" is rewritten before the request fires.
    'try{var imgEls=[window.HTMLImageElement,window.HTMLSourceElement,window.HTMLIFrameElement];' +
    'for(var ii=0;ii<imgEls.length;ii++){var EC=imgEls[ii];if(!EC)continue;' +
    'var sD=Object.getOwnPropertyDescriptor(EC.prototype,"src");' +
    'if(sD&&sD.set){(function(EC,sD){var sS=sD.set;' +
    'Object.defineProperty(EC.prototype,"src",{get:sD.get,' +
    'set:function(v){if(typeof v==="string")v=Y(v);return sS.call(this,v)},' +
    'configurable:true,enumerable:true})})(EC,sD)}}}catch(e){}' +
    // --- Element.prototype.setAttribute override (src only) ---
    // Synchronously rewrite "src" so assignments via setAttribute are caught
    // before the browser fires the resource request.  Deliberately NOT applied
    // to href/action: doing so makes frameworks (Grafana, others) read back a
    // proxy-prefixed value from the DOM and then re-prepend their own sub-path
    // config, yielding a doubled prefix.  Let href/action go through the async
    // MutationObserver path instead.
    'try{var SA=Element.prototype.setAttribute;' +
    'Element.prototype.setAttribute=function(n,v){' +
    'if(typeof n==="string"&&typeof v==="string"&&n.toLowerCase()==="src")v=Y(v);' +
    'return SA.call(this,n,v)};}catch(e){}' +
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
    'for(var i=0;i<aa.length;i++){var v=el.getAttribute(aa[i]);if(v){var nv=Y(v);if(nv!==v)el.setAttribute(aa[i],nv)}}' +
    'var ch=el.querySelectorAll?el.querySelectorAll("[href],[src],[action]"):[];' +
    'for(var j=0;j<ch.length;j++){' +
    'for(var k=0;k<aa.length;k++){var w=ch[j].getAttribute(aa[k]);if(w){var nw=Y(w);if(nw!==w)ch[j].setAttribute(aa[k],nw)}}' +
    '}}' +
    'var MO=window.MutationObserver;if(MO){' +
    'new MO(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];' +
    'if(m.type==="childList"){for(var j=0;j<m.addedNodes.length;j++)RW(m.addedNodes[j])}' +
    'else if(m.type==="attributes"){var v=m.target.getAttribute(m.attributeName);' +
    'if(v){var nv2=Y(v);if(nv2!==v)m.target.setAttribute(m.attributeName,nv2)}}' +
    '}}).observe(document.documentElement,{childList:true,subtree:true,' +
    'attributes:true,attributeFilter:["href","src","action"]})}' +
    '})()' +
    '</script>'
  )
}

interface ProxyPair {
  main: RequestHandler
  // Host-only proxy for /__root__-escaped requests. Only created when the app
  // target has a non-root base path AND rewritePaths is enabled — otherwise no
  // /__root__ URLs are ever generated and the secondary proxy is redundant.
  root?: RequestHandler
}

// Pipe an upstream response through to the client untouched (apart from
// stripping hop-by-hop headers).  Centralised so the body-rewriting and
// fall-through paths share the same header-handling and error semantics.
function streamThrough(proxyRes: IncomingMessage, res: ServerResponse, status: number): void {
  const headers: Record<string, string | string[] | undefined> = { ...proxyRes.headers }
  for (const h of HOP_BY_HOP_HEADERS) {
    delete headers[h]
  }
  res.writeHead(status, headers)
  proxyRes.on('error', () => {
    // Upstream errored mid-stream.  Headers are already sent so the best we
    // can do is destroy the connection so the client knows the body is
    // truncated rather than receive a silently-incomplete payload.
    try {
      res.destroy()
    } catch {
      // already destroyed
    }
  })
  proxyRes.pipe(res)
}

module.exports = function (app: ServerAPIWithServer): Plugin {
  let proxies: ProxyPair[] = []
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
        // Compute the rewrite script once per app — its inputs are static for
        // the life of the plugin instance, so re-building it on every HTML
        // response is wasted work.
        const rewriteScript = appConfig.rewritePaths
          ? buildRewriteScript(proxyPathPrefix, appConfig.path)
          : ''
        const targetOrigin = computeTargetOrigin(appConfig)
        const makeProxy = (target: string, enableRewrite: boolean): RequestHandler =>
          createProxyMiddleware({
            target,
            changeOrigin: true,
            ws: false,
            secure: !(appConfig.scheme === 'https' && appConfig.allowSelfSigned),
            ...(appConfig.timeout > 0 ? { proxyTimeout: appConfig.timeout } : {}),
            // Always self-handle responses so upstream headers (especially
            // Content-Type) are forwarded faithfully and not overwritten by
            // middleware in the pipeline.
            selfHandleResponse: true,
            on: {
              proxyReq(proxyReq, req): void {
                const defaultProto = (req.socket as { encrypted?: boolean }).encrypted
                  ? 'https'
                  : 'http'
                applyForwardedHeaders(proxyReq, req, defaultProto)
                // Realign Origin with the upstream Host that changeOrigin
                // wrote. Apps that enforce same-origin WebSocket/CORS policy
                // (and CSRF-preflight checks) reject cross-origin POSTs when
                // Origin doesn't match. The original value is retained in
                // X-Forwarded-Host for apps that need to recover it.
                rewriteOriginHeader(proxyReq, req, targetOrigin)
                if (enableRewrite) {
                  // Constrain Accept-Encoding to encodings we can decompress for HTML
                  // script injection (br, gzip, deflate). Must honor what the *client*
                  // accepts — if we upgrade the client's Accept-Encoding and upstream
                  // compresses, the client will receive bytes it can't decode (e.g. a
                  // sandboxed iframe module import that sent Accept-Encoding: identity
                  // would see raw brotli and fail with an illegal-character error).
                  const clientAE = String(req.headers['accept-encoding'] ?? '')
                    .toLowerCase()
                    .split(',')
                    .map((s) => s.split(';')[0]!.trim())
                    .filter(Boolean)
                  const supported = clientAE.filter((e) =>
                    ['gzip', 'deflate', 'br', 'identity'].includes(e),
                  )
                  proxyReq.setHeader(
                    'Accept-Encoding',
                    supported.length > 0 ? supported.join(', ') : 'identity',
                  )
                }
                // Re-stream the request body when an upstream body-parser
                // (e.g. SignalK's global bodyParser.json()) has already
                // consumed the raw body.  Must be called after all setHeader()
                // calls — fixRequestBody writes to the proxy request which
                // locks headers; calling setHeader afterwards throws ERR_HTTP_HEADERS_SENT.
                fixRequestBody(proxyReq, req)
              },
              // WebSocket upgrade hook — fires just before http-proxy sends
              // the GET … HTTP/1.1 upgrade request to the target. Mirrors the
              // header rewriting the HTTP proxyReq hook does so WS upgrades
              // carry the same X-Forwarded-* metadata and realigned Origin
              // (critical for apps like Portainer's container exec: without
              // these, strict upstreams silently drop the connection). No
              // fixRequestBody / Accept-Encoding — upgrades have no body and
              // no Content-Encoding to negotiate.
              proxyReqWs(proxyReq, req): void {
                const defaultProto = (req.socket as { encrypted?: boolean }).encrypted
                  ? 'wss'
                  : 'ws'
                applyForwardedHeaders(proxyReq, req, defaultProto)
                rewriteOriginHeader(proxyReq, req, targetOrigin)
              },
              proxyRes(
                proxyRes: IncomingMessage,
                _req: IncomingMessage,
                res: ServerResponse,
              ): void {
                const ct = String(proxyRes.headers['content-type'] ?? '')
                const status = proxyRes.statusCode ?? 200

                if (enableRewrite) {
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
                      proxyRes.headers['location'] =
                        `${proxyPathPrefix}${computeProxiedSuffix(loc, appConfig.path)}`
                    }
                  }

                  // Rewrite Set-Cookie Path attributes so cookies set by the
                  // upstream app are scoped to the proxy URL space.  Without
                  // this, cookies with Path=/ or Path=/api/ would be saved
                  // against the SignalK origin but never sent back through
                  // the proxy — silently breaking session-based auth.
                  const sc = proxyRes.headers['set-cookie']
                  if (sc && sc.length > 0) {
                    proxyRes.headers['set-cookie'] = rewriteSetCookie(
                      sc,
                      proxyPathPrefix,
                      appConfig.path,
                    )
                  }

                  // Strip Content-Security-Policy headers so the injected
                  // inline script is not blocked by a strict upstream CSP.
                  // (The proxied app runs sandboxed inside an iframe at the
                  // SignalK origin; the parent page's CSP still applies.)
                  delete proxyRes.headers['content-security-policy']
                  delete proxyRes.headers['content-security-policy-report-only']

                  if (ct.includes('text/html')) {
                    const encoding = String(
                      proxyRes.headers['content-encoding'] ?? '',
                    ).toLowerCase()
                    // Pick a decompression stream for known encodings; for
                    // unknown non-empty encodings (e.g. zstd, compress) we
                    // can't safely modify the body — fall through to a raw
                    // pipe so the client receives the original bytes
                    // intact, with the original Content-Encoding preserved.
                    const knownEncoding =
                      encoding === '' ||
                      encoding === 'identity' ||
                      encoding === 'gzip' ||
                      encoding === 'x-gzip' ||
                      encoding === 'deflate' ||
                      encoding === 'br'
                    if (!knownEncoding) {
                      streamThrough(proxyRes, res, status)
                      return
                    }
                    const stream: NodeJS.ReadableStream =
                      encoding === 'gzip' || encoding === 'x-gzip'
                        ? proxyRes.pipe(createGunzip())
                        : encoding === 'deflate'
                          ? proxyRes.pipe(createInflate())
                          : encoding === 'br'
                            ? proxyRes.pipe(createBrotliDecompress())
                            : proxyRes
                    const chunks: Buffer[] = []
                    let totalBytes = 0
                    let aborted = false
                    let pipedThrough = false
                    stream.on('data', (chunk: Buffer) => {
                      if (aborted) return
                      totalBytes += chunk.length
                      if (totalBytes > MAX_HTML_REWRITE_BYTES) {
                        // Body exceeded the rewrite cap.  Stop buffering and
                        // forward the rest of the (original, still-encoded)
                        // upstream stream untouched so the client at least
                        // sees a valid response — even though it won't be
                        // path-rewritten.
                        aborted = true
                        if (!pipedThrough) {
                          pipedThrough = true
                          // Discard any decompression pipeline we set up;
                          // give the client the original bytes verbatim.
                          streamThrough(proxyRes, res, status)
                        }
                        return
                      }
                      chunks.push(chunk)
                    })
                    stream.on('end', () => {
                      if (aborted) return
                      const html = Buffer.concat(chunks).toString('utf-8')
                      // <head[\s/>] disambiguates from <header...> while
                      // still matching <head>, <head class="...">, and the
                      // self-closing <head/> form.
                      const headRe = /<head(?=[\s/>])[^>]*>/i
                      let injected: string
                      if (headRe.test(html)) {
                        injected = html.replace(headRe, (m) => m + rewriteScript)
                      } else {
                        // No <head> — fall back to injecting at the start of
                        // <html> (for fragments) or at the document start.
                        // This keeps the runtime XHR/fetch/WebSocket patches
                        // active even when the upstream emits malformed HTML.
                        const htmlRe = /<html\b[^>]*>/i
                        injected = htmlRe.test(html)
                          ? html.replace(htmlRe, (m) => m + rewriteScript)
                          : rewriteScript + html
                      }
                      const rewritten = rewriteHtmlAttributes(
                        injected,
                        proxyPathPrefix,
                        appConfig.path,
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
                      if (aborted) return
                      if (!res.headersSent) {
                        res.writeHead(502, { 'Content-Type': 'text/plain' })
                      }
                      res.end('Bad Gateway: decompression error')
                    })
                    // If the *source* stream errors after we've started
                    // piping into a decoder, surface it to the same handler.
                    proxyRes.on('error', () => {
                      if (aborted || res.headersSent) return
                      try {
                        res.writeHead(502, { 'Content-Type': 'text/plain' })
                      } catch {
                        // headers already sent
                      }
                      try {
                        res.end('Bad Gateway: upstream error')
                      } catch {
                        // already ended
                      }
                    })
                    return
                  }
                }

                streamThrough(proxyRes, res, status)
              },
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
        const needsRoot = appConfig.rewritePaths && appConfig.path !== '/'
        return {
          main: makeProxy(buildTarget(appConfig), appConfig.rewritePaths),
          ...(needsRoot ? { root: makeProxy(buildRootTarget(appConfig), false) } : {}),
        }
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
          const pair = proxies[index]
          if (!pair) {
            reject404()
            return
          }
          let afterAppId = slash >= 0 ? pathPart.substring(slash) : '/'
          // Root escape: strip the /__root__ marker and dispatch via the host-only proxy.
          const useRoot = afterAppId === ROOT_ESCAPE || afterAppId.startsWith(ROOT_ESCAPE + '/')
          if (useRoot) {
            afterAppId = afterAppId.slice(ROOT_ESCAPE.length) || '/'
          }
          const targetProxy = useRoot ? pair.root : pair.main
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
          req.url = afterAppId + queryString
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
          const pair = idx >= 0 && idx < proxies.length ? proxies[idx] : undefined
          if (!pair) {
            res.status(404).json({ error: `No app found for "${appId}"` })
            return
          }
          // After express has matched /proxy/:appId, req.url is the remaining
          // suffix (e.g. "/__root__/plugins/foo/ws" or "/api/bar"). Strip the
          // root escape and dispatch to the host-only proxy when present.
          const u = req.url ?? ''
          const useRoot = u === ROOT_ESCAPE || u.startsWith(ROOT_ESCAPE + '/')
          if (useRoot) {
            req.url = u.slice(ROOT_ESCAPE.length) || '/'
          }
          const proxy = useRoot ? pair.root : pair.main
          if (!proxy) {
            res.status(404).json({ error: `No app found for "${appId}"` })
            return
          }
          ;(proxy as unknown as (req: Request, res: Response, next: () => void) => void)(
            req,
            res,
            next,
          )
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
