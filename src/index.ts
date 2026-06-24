import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import type { ClientRequest, IncomingMessage, Server, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { Socket } from 'net'
import { Readable } from 'stream'
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

// Aggregate cap across all *concurrent* HTML rewrites. The per-response cap
// above bounds one request; this bounds total buffered memory so many
// simultaneous large-HTML requests (reachable by an authenticated admin)
// can't exhaust RAM on a small device. Over the cap, a request degrades to a
// 503 rather than buffering unboundedly.
const MAX_TOTAL_REWRITE_BYTES = 64 * 1024 * 1024 // 64 MiB

// Opening tag of the injected rewrite <script>. Shared between buildRewriteScript
// (which emits it) and the response path (which splices a per-response nonce in
// after `<script `), so the two stay in lockstep.
const REWRITE_SCRIPT_MARKER = 'data-signalk-embedded-webapp-proxy="path-rewrite"'
const REWRITE_SCRIPT_OPEN = `<script ${REWRITE_SCRIPT_MARKER}>`

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

/**
 * True when `path` is a SignalK server root namespace (`/plugins/`, `/signalk/`,
 * `/admin/`, `/skServer/`) that an embedded app may need to reach via the
 * host-only proxy — excluding this plugin's own prefix.
 */
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

// Split a Set-Cookie header value into its attributes, respecting the
// RFC 6265 quoted-string rule for cookie-value (the first segment). This
// prevents a malicious upstream from embedding a `;` inside a quoted
// cookie-value to inject a fake `Path=` attribute that would otherwise
// shadow the legitimate one.
function splitCookieAttributes(cookie: string): string[] {
  const parts: string[] = []
  let buf = ''
  let inQuotes = false
  // The cookie-value may be a quoted string but only for the *first*
  // attribute (cookie-pair). After that, attribute values are unquoted per
  // the grammar in RFC 6265 §5.2 — but in practice browsers tolerate
  // quoting elsewhere. To stay safe we honour quotes wherever they appear.
  for (let i = 0; i < cookie.length; i++) {
    const ch = cookie.charAt(i)
    if (ch === '"') {
      inQuotes = !inQuotes
      buf += ch
      continue
    }
    if (ch === ';' && !inQuotes) {
      parts.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.length > 0) parts.push(buf)
  return parts
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
//
// Defends against two upstream-controlled attacks: (1) splitting the
// cookie on raw `;` would break apart quoted cookie-values like
// `data="a;b"`, so we use splitCookieAttributes which honours quotes;
// (2) only the FIRST Path attribute is honoured — additional Path tokens
// (legal per the grammar but rejected by browsers) are dropped so an
// attacker can't push a real Path off the relevant position.
function rewriteSetCookie(
  values: string[],
  proxyPathPrefix: string,
  appBasePath: string,
): string[] {
  return values.map((cookie) => {
    const parts = splitCookieAttributes(cookie)
    const out: string[] = []
    let sawPath = false
    // A "__Host-" prefixed cookie is only accepted by the browser when it has
    // Path=/ (and no Domain, and Secure). Rewriting its Path to the proxy
    // subtree would make the browser reject the cookie outright, silently
    // breaking auth. So for these we keep Path=/ — the cookie ends up scoped to
    // the whole SignalK origin, which is acceptable under the documented
    // same-origin "only proxy trusted apps" model and strictly better than a
    // dropped cookie. ("__Secure-" has no Path constraint, so it needs no
    // special-casing.) The prefix match is case-insensitive per RFC 6265bis.
    const firstPart = parts[0] ?? ''
    const firstEq = firstPart.indexOf('=')
    const cookieName = (firstEq >= 0 ? firstPart.slice(0, firstEq) : firstPart).trim()
    const isHostPrefixed = /^__Host-/i.test(cookieName)
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
        if (sawPath) continue // drop duplicates; first Path wins
        sawPath = true
        if (isHostPrefixed) {
          // Preserve Path=/ so the __Host- cookie stays valid (see above).
          out.push(part)
          continue
        }
        let value = eq >= 0 ? part.slice(eq + 1).trim() : ''
        // Strip surrounding quotes (RFC 6265 doesn't allow it, but real
        // upstreams sometimes emit Path="…"; honouring the quotes prevents
        // the leading `"` from defeating the `/` check below).
        if (
          value.length >= 2 &&
          value.charAt(0) === '"' &&
          value.charAt(value.length - 1) === '"'
        ) {
          value = value.slice(1, -1)
        }
        if (value.charAt(0) !== '/') {
          // Not a root-relative path — leave as-is.
          out.push(part)
          continue
        }
        // If the Path is already correctly scoped to this app's proxy
        // subtree, leave it untouched. Anything else — including paths
        // that target the parent plugin prefix or a sibling app's prefix
        // — gets rewritten so a malicious upstream cannot scope cookies
        // to read another proxied app's traffic.
        if (value === proxyPathPrefix || value.startsWith(proxyPathPrefix + '/')) {
          out.push(`Path=${value}`)
          continue
        }
        const suffix = computeProxiedSuffix(value, appBasePath)
        out.push(`Path=${proxyPathPrefix}${suffix}`)
        continue
      }
      out.push(part)
    }
    return out.join('; ')
  })
}

// Precompiled closing-tag matchers for the verbatim-body elements, keyed by
// lowercased tag name — avoids compiling a fresh RegExp per matched tag.
const CLOSE_TAG_RE: Record<string, RegExp> = {
  script: /<\/script\s*>/i,
  style: /<\/style\s*>/i,
  textarea: /<\/textarea\s*>/i,
}

// Rewrite absolute-path values in src/href/action HTML attributes (and the
// URLs inside srcset) while preserving the *bodies* of <script>, <style>,
// <textarea>, and HTML comments verbatim — those can contain URL-attribute-
// shaped substrings (string literals, CSS, escaped sample text) that must not
// be touched.  Opening-tag attributes (e.g. <script src="…">) are still
// rewritten. Both quoted (src="/x") and unquoted (href=/x) attribute values
// are handled; the runtime patches in the injected script cover values set
// dynamically from JS.
function rewriteHtmlAttributes(html: string, proxyPathPrefix: string, appBasePath: string): string {
  const toProxy = (url: string): string => {
    if (url.startsWith('//')) return url // protocol-relative
    if (url.startsWith(proxyPathPrefix)) return url // already proxied
    return `${proxyPathPrefix}${computeProxiedSuffix(url, appBasePath)}`
  }
  // Quoted absolute-path src/href/action values: src="/x", href='/y'.
  const attrRe = /((?:src|href|action)=["'])(\/[^"']*)/gi
  const replaceAttr = (_m: string, attr: string, url: string): string => `${attr}${toProxy(url)}`
  // Unquoted absolute-path values: <a href=/login>. Stops at whitespace or '>'.
  // Mutually exclusive with attrRe, which requires a quote right after '='.
  const attrReUnquoted = /((?:src|href|action)=)(\/[^\s"'>]*)/gi
  const replaceAttrUnquoted = (_m: string, attr: string, url: string): string =>
    `${attr}${toProxy(url)}`
  // srcset is a comma-separated list of "url [descriptor]" entries; rewrite
  // each absolute-path URL while preserving its descriptor (e.g. "2x", "640w").
  const srcsetRe = /(srcset=["'])([^"']*)(["'])/gi
  const replaceSrcset = (_m: string, open: string, list: string, close: string): string => {
    const rewritten = list
      .split(',')
      .map((entry) => {
        const trimmed = entry.trim()
        if (!trimmed) return entry
        const sp = trimmed.search(/\s/)
        const u = sp >= 0 ? trimmed.slice(0, sp) : trimmed
        const desc = sp >= 0 ? trimmed.slice(sp) : ''
        if (u.charAt(0) === '/' && u.charAt(1) !== '/' && !u.startsWith(proxyPathPrefix)) {
          return `${proxyPathPrefix}${computeProxiedSuffix(u, appBasePath)}${desc}`
        }
        return trimmed
      })
      .join(', ')
    return `${open}${rewritten}${close}`
  }
  const rewriteChunk = (s: string): string =>
    s
      .replace(attrRe, replaceAttr)
      .replace(attrReUnquoted, replaceAttrUnquoted)
      .replace(srcsetRe, replaceSrcset)

  // Match an HTML comment OR the opening tag of an element whose contents we
  // must preserve verbatim.  Comments are kept as-is; opening tags are
  // attribute-rewritten and their bodies passed through unchanged.
  const boundaryRe = /<!--[\s\S]*?-->|<(script|style|textarea)\b[^>]*>/gi
  let out = ''
  let i = 0
  let m: RegExpExecArray | null
  while ((m = boundaryRe.exec(html)) !== null) {
    out += rewriteChunk(html.slice(i, m.index))
    if (!m[1]) {
      // Comment — append verbatim.
      out += m[0]
      i = m.index + m[0].length
      boundaryRe.lastIndex = i
      continue
    }
    // Opening <script>/<style>/<textarea> — rewrite its attributes, then skip
    // until the matching closing tag.
    out += rewriteChunk(m[0])
    const bodyStart = m.index + m[0].length
    const closeRe = CLOSE_TAG_RE[m[1].toLowerCase()]!
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
  out += rewriteChunk(html.slice(i))
  return out
}

/**
 * Delete any request header whose name is not a valid HTTP token, so a malformed
 * header cannot smuggle past the proxy into the upstream request.
 */
function stripInvalidHeaders(req: IncomingMessage): void {
  if (!req.headers) return
  for (const key of Object.keys(req.headers)) {
    if (!HTTP_TOKEN_RE.test(key)) {
      delete req.headers[key]
    }
  }
}

/** Canonicalise a hostname for comparison: trim, lowercase, and strip trailing dots. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '')
}

/** Validate a hostname: permitted characters only, and not a known cloud-metadata endpoint. */
function isValidHost(host: string): boolean {
  const normalized = normalizeHost(host)
  if (!HOST_PATTERN.test(normalized)) return false
  if (CLOUD_METADATA_HOSTS.has(normalized)) return false
  return true
}

/** Build the upstream target URL (scheme://host:port + base path) for an app's main proxy. */
function buildTarget(appConfig: AppConfig): string {
  // Strip trailing slash from path so node-http-proxy doesn't produce double-slashes.
  // A root path '/' becomes '' so the target is scheme://host:port with no path suffix.
  const path = appConfig.path.replace(/\/$/, '')
  return `${appConfig.scheme}://${appConfig.host}:${String(appConfig.port)}${path}`
}

/** Build the host-only upstream target (no base path) used for `/__root__`-escaped requests. */
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

// Coerce a Node header value (string | string[] | undefined) to its first
// string value. Centralises the origin/host/proto narrowing that was
// otherwise spelled three slightly different ways.
function firstHeaderValue(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? ''
  return ''
}

// True when the incoming request arrived over a TLS socket. `req.socket` is
// typed as net.Socket, which lacks `encrypted` (a tls.TLSSocket field), so the
// cast is unavoidable; isolating it here keeps the call sites clean and the
// intent ("is this a TLS connection?") self-documenting.
function isEncrypted(req: IncomingMessage): boolean {
  return (req.socket as Partial<{ encrypted: boolean }>).encrypted === true
}

// Apply X-Real-IP / X-Forwarded-* to an outgoing proxied request. Shared between
// HTTP (`proxyReq`) and WebSocket upgrade (`proxyReqWs`) hooks — the only
// difference is the default protocol label ("http"/"https" vs "ws"/"wss").
//
// SECURITY: Do not extend an attacker-controllable X-Forwarded-For chain.
// Upstream apps commonly trust the LEFTMOST value as the "real" client IP;
// accepting client-supplied entries lets the caller spoof that field. The
// chain is overwritten with `<remoteAddress>` — the only value this proxy
// has actually observed. If this plugin is ever deployed behind another
// trusted reverse proxy that the operator wants to inherit a chain from,
// that's a configuration knob to add explicitly, not a default behaviour.
// X-Forwarded-Proto is similarly validated against a strict allow-list
// because some upstreams use it for HTTPS-only cookie decisions.
function applyForwardedHeaders(
  proxyReq: ClientRequest,
  req: IncomingMessage,
  defaultProto: string,
): void {
  const remoteAddress = req.socket?.remoteAddress ?? ''
  proxyReq.setHeader('X-Real-IP', remoteAddress)
  proxyReq.setHeader('X-Forwarded-For', remoteAddress)
  const rawProto = firstHeaderValue(req.headers['x-forwarded-proto'])
  const firstProto = rawProto.split(',')[0]?.trim().toLowerCase() ?? ''
  const validProto =
    firstProto === 'http' || firstProto === 'https' || firstProto === 'ws' || firstProto === 'wss'
      ? firstProto
      : defaultProto
  proxyReq.setHeader('X-Forwarded-Proto', validProto)
  // Forward the original Host so upstream apps that build absolute URLs (share
  // links, OAuth callbacks) can still reach this proxy. changeOrigin: true
  // rewrites the wire Host header to the target, so X-Forwarded-Host is the
  // only way to communicate the original.
  const incomingHost = firstHeaderValue(req.headers['host'])
  if (incomingHost.length > 0) {
    proxyReq.setHeader('X-Forwarded-Host', incomingHost)
  }
}

// Rewrite the outgoing Origin header so upstream apps that enforce same-origin
// WebSocket / CORS policy see a value matching the target host (which
// changeOrigin:true has already rewritten into the Host header). The original
// Host is preserved in X-Forwarded-Host via applyForwardedHeaders, so apps
// that need it can still recover it. Leaves Origin untouched when the
// incoming request has no Origin header (non-browser clients).
//
// SECURITY TRADEOFF: This rewrites Origin unconditionally — mirroring the
// canonical reverse-proxy recipe for apps like Portainer and Grafana
// (`proxy_set_header Origin $host;` in nginx). That means if an upstream app
// uses cookie-based auth *and* relies on Origin for CSRF protection *and*
// sets its cookies with SameSite=None, a cross-site credentialed request
// would have its Origin forged into a same-site one. In practice this vector
// is narrow: modern browsers default cookies to SameSite=Lax (blocking
// cross-site credentialed POSTs outright), Portainer uses JWT-in-header
// rather than cookies, and this plugin is documented for trusted-network
// deployments. We prefer compatibility with real apps over defense against
// this specific layered failure. A conditional rewrite (0.3.2) broke
// Portainer deletes in the field; unconditional rewrite is the pragmatic
// choice.
function rewriteOriginHeader(
  proxyReq: ClientRequest,
  req: IncomingMessage,
  targetOrigin: string,
): void {
  const origin = firstHeaderValue(req.headers['origin'])
  if (origin.length > 0) {
    proxyReq.setHeader('Origin', targetOrigin)
  }
}

/**
 * Validate and normalise one raw app-config entry into an {@link AppConfig}.
 * Throws if the entry is invalid (missing/blocked URL, scheme, host, appPath, timeout).
 */
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

/**
 * Parse the plugin configuration into a position-stable array of app slots. Each
 * slot is an {@link AppConfig}, or `null` when that config entry failed validation
 * — the null placeholders keep the surviving apps' numeric indices stable.
 */
function parseConfig(
  config: object,
  onSkip: (index: number, err: unknown) => void,
): (AppConfig | null)[] {
  const raw = config as Record<string, unknown>
  const apps: unknown[] = Array.isArray(raw['apps']) ? raw['apps'] : []
  // Cap the number of configured apps to avoid pathological config sizes
  // exhausting resources. Silently dropping the overflow would be confusing
  // for an operator wondering why their 17th app isn't reachable — surface
  // the truncation via the skip callback so it lands in the SignalK log.
  if (apps.length > MAX_APP_SLOTS) {
    for (let i = MAX_APP_SLOTS; i < apps.length; i++) {
      onSkip(i, new Error(`exceeds MAX_APP_SLOTS=${String(MAX_APP_SLOTS)}; ignored`))
    }
  }
  const slots = apps.slice(0, MAX_APP_SLOTS)
  // Push a null placeholder for any slot that is invalid — whether it's a
  // non-object entry or an object that fails validation — so the surviving
  // apps keep their original positional index. Compacting the array (e.g. by
  // filtering out non-objects first) would silently shift every later app
  // down — a bad entry at index 1 would move the app the operator configured
  // at index 2 to /proxy/1, breaking bookmarked numeric URLs and serving the
  // wrong target. Callers treat a null slot as "no app" (404).
  const results: (AppConfig | null)[] = []
  const seenPaths = new Set<string>()
  for (let i = 0; i < slots.length; i++) {
    try {
      const candidate = slots[i]
      if (typeof candidate !== 'object' || candidate === null) {
        throw new Error(`Invalid app entry at index ${i}: expected an object`)
      }
      const appConfig = parseAppConfig(candidate as Record<string, unknown>, i)
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
      results.push(null)
    }
  }
  return results
}

/**
 * Resolve a proxy path segment — a canonical numeric index or a custom appPath —
 * to its app index, or -1 when unknown, out of range, or a null placeholder slot.
 */
function resolveAppIndex(appId: string, apps: (AppConfig | null)[]): number {
  if (/^\d+$/.test(appId)) {
    // Reject non-canonical numeric forms (e.g. "00", "01") so the URL space
    // remains 1:1 with the app — distinct cache/cookie scopes for the same
    // index are otherwise possible.
    if (appId.length > 1 && appId.startsWith('0')) return -1
    const n = Number(appId)
    // Range-check here rather than relying on every caller, so correctness
    // never hinges on the apps/proxies arrays staying the same length, and a
    // null placeholder slot (an app that failed validation) resolves to 404
    // instead of indexing past the proxies array.
    return n < apps.length && apps[n] != null ? n : -1
  }
  return apps.findIndex((a) => a != null && a.appPath === appId.toLowerCase())
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
// Escape characters that would otherwise let a JSON-stringified literal
// embedded in an inline <script> tag break out of script context:
//   - '<'   prevents "</script>" termination
//   - '-->' prevents premature end of an HTML comment wrapping the script
//   - U+2028 / U+2029 are paragraph/line separators that JSON.stringify
//     emits raw but ES <=2018 parses as newlines inside string literals,
//     which would terminate the literal early
// Today's inputs (validated appPath, URL pathname) cannot produce these,
// but the cost of insulation is one regex pass.
function jsLiteral(s: string): string {
  // Avoid raw U+2028/U+2029 in regex literals (TS parses them as line
  // terminators); use new RegExp with \u escapes inside a string instead.
  const lineSep = new RegExp('[\\u2028\\u2029]', 'g')
  return JSON.stringify(s)
    .replace(/</g, '\\u003c')
    .replace(/-->/g, '--\\u003e')
    .replace(lineSep, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}
/**
 * Build the inline `<script>` injected into HTML responses (when rewritePaths is
 * enabled) that patches fetch/XHR/WebSocket/history/location and the DOM so the
 * app's absolute paths route through the proxy. See the block comment above for detail.
 */
function buildRewriteScript(proxyPathPrefix: string, appBasePath: string): string {
  const prefix = jsLiteral(proxyPathPrefix)
  // Normalise: strip trailing slash; "/" becomes "" (no stripping needed).
  const base = appBasePath === '/' ? '' : appBasePath.replace(/\/$/, '')
  const baseJson = jsLiteral(base)
  // Generate the root-namespace check from ROOT_NAMESPACES so the client-side T()
  // stays automatically in sync with the server-side isRootNamespace().
  const rootCheckJs = ROOT_NAMESPACES.map((ns) => `s.indexOf(${jsLiteral(ns)})===0`).join('||')
  // Plugin prefix used to mirror isRootNamespace()'s exclusion: paths that
  // belong to this plugin are never root-escaped on the server, so they must
  // not be root-escaped on the client either.
  const pluginPrefix = jsLiteral(PLUGIN_PATH_PREFIX)
  return (
    REWRITE_SCRIPT_OPEN +
    '(function(){' +
    `var P=${prefix};` +
    `var B=${baseJson};` +
    `var PP=${pluginPrefix};` +
    // T: transform a root-relative path into the suffix that follows the proxy prefix.
    //    - Inside B (app base): strip B so the upstream target's base path isn't double-prefixed.
    //    - Belongs to this plugin (PP): never root-escape — mirrors isRootNamespace() exclusion.
    //    - Outside B but inside a known SignalK-server root namespace (/plugins/, /signalk/,
    //      /admin/, /skServer/): prepend __root__ so the server routes through the host-only
    //      proxy (e.g. onvif webapp reaching /plugins/signalk-onvif-camera/ws).
    //    - Otherwise: pass through unchanged so the main proxy forwards the path to
    //      target+base (e.g. Grafana XHR to /api/frontend/settings → upstream /grafana/api/...).
    //    - When B is empty, the target has no base path so nothing to strip or escape.
    'function T(s){if(!B)return s;' +
    'if(s.indexOf(B+"/")===0)return s.slice(B.length);' +
    'if(s===B)return "/";' +
    'if(s===PP||s.indexOf(PP+"/")===0)return s;' +
    `if(${rootCheckJs})return "/__root__"+s;` +
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
function streamThrough(proxyRes: IncomingMessage, res: ServerResponse): void {
  const headers: Record<string, string | string[] | undefined> = { ...proxyRes.headers }
  for (const h of HOP_BY_HOP_HEADERS) {
    delete headers[h]
  }
  // Attach error handlers BEFORE pipe so a synchronous error doesn't become
  // an unhandled 'error' event (which would crash the process).
  proxyRes.on('error', () => {
    // Upstream errored mid-stream.  Headers may already be sent so the best
    // we can do is destroy the connection so the client knows the body is
    // truncated rather than receive a silently-incomplete payload.
    try {
      res.destroy()
    } catch {
      // already destroyed
    }
  })
  // If the client (iframe) disconnects, stop reading the upstream so it doesn't
  // leak, and swallow the 'error' that the aborted write would otherwise emit.
  res.on('error', () => {
    try {
      proxyRes.destroy()
    } catch {
      // already destroyed
    }
  })
  // The client may already be gone by the time the upstream is readable; calling
  // writeHead on a finished/destroyed response throws synchronously.
  if (res.headersSent || res.writableEnded || res.destroyed) {
    proxyRes.destroy()
    return
  }
  try {
    res.writeHead(proxyRes.statusCode ?? 200, headers)
  } catch {
    proxyRes.destroy()
    return
  }
  proxyRes.pipe(res)
}

// Resolve the /__root__ escape: strip the marker from `path` and select the
// host-only `root` proxy (else the `main` proxy). Shared by the HTTP route and
// the WS upgrade handler so this security-relevant routing decision lives in
// one place. `proxy` is undefined when a root escape is requested but the app
// has no root proxy — callers turn that into a 404.
function resolveRootEscape(
  path: string,
  pair: ProxyPair,
): { path: string; proxy: RequestHandler | undefined } {
  if (path === ROOT_ESCAPE || path.startsWith(ROOT_ESCAPE + '/')) {
    return { path: path.slice(ROOT_ESCAPE.length) || '/', proxy: pair.root }
  }
  return { path, proxy: pair.main }
}

// Total bytes currently buffered across all concurrent HTML rewrites; bounded
// by MAX_TOTAL_REWRITE_BYTES (see rewriteHtmlResponse).
let inFlightRewriteBytes = 0

// Add a nonce-source to a CSP's script directive so the injected inline rewrite
// <script> is allowed, WITHOUT deleting the upstream policy. Deleting CSP would
// also remove the proxied app's own XSS containment — and because the app runs
// at the SignalK admin origin under allow-same-origin, that containment is the
// only thing keeping an app-level XSS from reaching the admin session. Skips the
// change when inline scripts are already allowed via 'unsafe-inline' without a
// nonce/strict-dynamic, since adding a nonce there would *disable* the
// 'unsafe-inline' under CSP Level 3 and break the app's own inline scripts.
function addCspNonce(csp: string, nonce: string): string {
  const directives = csp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
  const nonceSrc = `'nonce-${nonce}'`
  const inlineAlreadyAllowed = (tokens: string[]): boolean => {
    const lower = tokens.map((t) => t.toLowerCase())
    return (
      lower.includes("'unsafe-inline'") &&
      !lower.some((t) => t.startsWith("'nonce-") || t === "'strict-dynamic'")
    )
  }
  // Track script-src and script-src-elem separately. An inline <script> element
  // is governed by script-src-elem when present (it overrides script-src for
  // script elements), so both must get the nonce — patching only the last-seen
  // one would leave the governing directive unpatched depending on header order.
  let scriptIdx = -1
  let scriptElemIdx = -1
  let defaultIdx = -1
  for (let i = 0; i < directives.length; i++) {
    const name = directives[i]!.split(/\s+/)[0]?.toLowerCase() ?? ''
    if (name === 'script-src') scriptIdx = i
    else if (name === 'script-src-elem') scriptElemIdx = i
    else if (name === 'default-src') defaultIdx = i
  }
  const patchAt = (idx: number): void => {
    const dir = directives[idx]!
    if (!inlineAlreadyAllowed(dir.split(/\s+/).slice(1))) {
      directives[idx] = `${dir} ${nonceSrc}`
    }
  }
  if (scriptIdx >= 0) patchAt(scriptIdx)
  if (scriptElemIdx >= 0) patchAt(scriptElemIdx)
  if (scriptIdx < 0 && scriptElemIdx < 0 && defaultIdx >= 0) {
    // No script directive; scripts fall back to default-src. Add an explicit
    // script-src that mirrors it plus our nonce, unless default-src already
    // allows inline scripts.
    const tokens = directives[defaultIdx]!.split(/\s+/).slice(1)
    if (!inlineAlreadyAllowed(tokens)) {
      directives.push(`script-src ${[...tokens, nonceSrc].join(' ')}`)
    }
  }
  // else: neither script directive nor default-src — scripts already unrestricted.
  return directives.join('; ')
}

// Decompress (when needed), inject the rewrite <script> with a per-response
// nonce, rewrite attribute URLs, and send. Extracted from the proxyRes hook so
// the heavy buffering/decompression path has a name and a testable boundary.
// On any failure it fails safe (502/503, or a streamThrough pass-through).
function rewriteHtmlResponse(
  proxyRes: IncomingMessage,
  res: ServerResponse,
  opts: {
    rewriteScript: string
    proxyPathPrefix: string
    appBasePath: string
    logError: (msg: string) => void
  },
): void {
  const { rewriteScript, proxyPathPrefix, appBasePath, logError } = opts
  const status = proxyRes.statusCode ?? 200

  // Only UTF-8 (and ASCII, its subset) can be safely decoded then re-encoded as
  // utf-8. For any other declared charset, stream the body through unmodified
  // rather than mojibake its non-ASCII bytes.
  const ct = String(proxyRes.headers['content-type'] ?? '').toLowerCase()
  const charset = /charset=["']?([^"';,\s]+)/.exec(ct)?.[1] ?? ''
  if (
    charset &&
    charset !== 'utf-8' &&
    charset !== 'utf8' &&
    charset !== 'us-ascii' &&
    charset !== 'ascii'
  ) {
    logError(
      `Skipping HTML rewrite for non-UTF-8 charset "${charset}" — body streamed through unmodified`,
    )
    streamThrough(proxyRes, res)
    return
  }

  const encoding = String(proxyRes.headers['content-encoding'] ?? '').toLowerCase()
  // Pick a decompression stream for known encodings; for unknown non-empty
  // encodings (e.g. zstd, compress) we can't safely modify the body — fall
  // through to a raw pipe so the client receives the original bytes intact.
  const knownEncoding =
    encoding === '' ||
    encoding === 'identity' ||
    encoding === 'gzip' ||
    encoding === 'x-gzip' ||
    encoding === 'deflate' ||
    encoding === 'br'
  if (!knownEncoding) {
    logError(
      `Skipping HTML rewrite for unknown content-encoding "${encoding}" — body streamed through unmodified`,
    )
    streamThrough(proxyRes, res)
    return
  }

  // Per-response nonce lets the injected inline <script> run under a strict
  // upstream CSP without deleting the policy (see addCspNonce).
  const nonce = randomBytes(16).toString('base64')
  const scriptTag = rewriteScript.replace(
    REWRITE_SCRIPT_OPEN,
    `<script nonce="${nonce}" ${REWRITE_SCRIPT_MARKER}>`,
  )

  let aborted = false
  let accounted = 0
  const release = (): void => {
    inFlightRewriteBytes -= accounted
    accounted = 0
  }
  const abort = (body: string, statusCode = 502): void => {
    if (aborted) return
    aborted = true
    release()
    // Stop background reads on both legs (when there is no decompressor,
    // stream === proxyRes and the second destroy() is a no-op).
    try {
      stream.destroy()
    } catch {
      // already destroyed
    }
    try {
      proxyRes.destroy()
    } catch {
      // already destroyed
    }
    if (!res.headersSent) {
      try {
        res.writeHead(statusCode, { 'Content-Type': 'text/plain' })
      } catch {
        // headers raced to "sent"
      }
    }
    try {
      res.end(body)
    } catch {
      // already ended
    }
  }

  // SECURITY: Bound decompressor output so a decompression-bomb upstream cannot
  // allocate gigabytes before the per-chunk size check fires. Brotli supports a
  // hard cap; gzip/deflate emit in bounded chunks so the per-chunk accumulator
  // below enforces the cap within a single chunk.
  const stream: Readable =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? proxyRes.pipe(createGunzip())
      : encoding === 'deflate'
        ? proxyRes.pipe(createInflate())
        : encoding === 'br'
          ? proxyRes.pipe(createBrotliDecompress({ maxOutputLength: MAX_HTML_REWRITE_BYTES }))
          : proxyRes
  // Attach error handlers BEFORE wiring data/end so a synchronous error on the
  // source after .pipe() does not become an unhandled 'error' event (crash).
  proxyRes.on('error', () => abort('Bad Gateway: upstream error'))
  if (stream !== proxyRes) {
    stream.on('error', () => abort('Bad Gateway: decompression error'))
  }
  // If the client (iframe) goes away mid-rewrite, stop reading upstream and
  // release the in-flight memory accounting.
  res.on('error', () => abort('Bad Gateway: client error'))

  const chunks: Buffer[] = []
  let totalBytes = 0
  stream.on('data', (chunk: Buffer) => {
    if (aborted) return
    // Per-request cap: check the projected size BEFORE pushing so we cannot
    // briefly buffer 2× the cap with a single oversized chunk.
    if (totalBytes + chunk.length > MAX_HTML_REWRITE_BYTES) {
      abort('Bad Gateway: response too large to rewrite')
      return
    }
    // Aggregate cap across all concurrent rewrites: protect total memory on
    // small devices. Over the cap we 503 rather than buffer unboundedly.
    if (inFlightRewriteBytes + chunk.length > MAX_TOTAL_REWRITE_BYTES) {
      abort('Service Unavailable: too many concurrent responses to rewrite', 503)
      return
    }
    totalBytes += chunk.length
    accounted += chunk.length
    inFlightRewriteBytes += chunk.length
    chunks.push(chunk)
  })
  stream.on('end', () => {
    if (aborted) return
    release()
    const html = Buffer.concat(chunks).toString('utf-8')
    // <head[\s/>] disambiguates from <header...> while still matching <head>,
    // <head class="...">, and the self-closing <head/> form.
    const headRe = /<head(?=[\s/>])[^>]*>/i
    let injected: string
    if (headRe.test(html)) {
      injected = html.replace(headRe, (mm) => mm + scriptTag)
    } else {
      // No <head> — inject at the start of <html> (for fragments) or at the
      // document start. Keeps the runtime patches active even on malformed HTML.
      const htmlRe = /<html\b[^>]*>/i
      injected = htmlRe.test(html) ? html.replace(htmlRe, (mm) => mm + scriptTag) : scriptTag + html
    }
    const rewritten = rewriteHtmlAttributes(injected, proxyPathPrefix, appBasePath)
    const buf = Buffer.from(rewritten, 'utf-8')
    // The client may have disconnected after the last chunk; writing to a
    // finished/destroyed response throws synchronously (unhandled → crash).
    if (res.headersSent || res.writableEnded || res.destroyed) return
    const headers = { ...proxyRes.headers }
    delete headers['content-encoding'] // we decompressed
    delete headers['transfer-encoding']
    headers['content-length'] = String(buf.length)
    // Inject the nonce into any upstream CSP so the inline script runs, instead
    // of stripping the policy and removing the app's own XSS containment.
    for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
      const csp = headers[key]
      if (typeof csp === 'string' && csp.length > 0) {
        headers[key] = addCspNonce(csp, nonce)
      } else if (Array.isArray(csp)) {
        headers[key] = csp.map((c) => addCspNonce(c, nonce))
      }
    }
    try {
      res.writeHead(status, headers)
      res.end(buf)
    } catch {
      try {
        res.destroy()
      } catch {
        // already destroyed
      }
    }
  })
}

module.exports = function (app: ServerAPIWithServer): Plugin {
  // Null slots are apps that failed validation; they hold their position so the
  // surviving apps keep stable numeric indices (see parseConfig).
  let proxies: (ProxyPair | null)[] = []
  let currentApps: (AppConfig | null)[] = []
  let started = false
  // Set when apps are configured but SignalK didn't expose app.server, so
  // WebSocket upgrades can't be intercepted. Surfaced in statusMessage().
  let wsUnavailable = false
  let upgradeHandler: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null = null

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'General reverse proxy — embed any web application as a webapp in SignalK',

    start(config: object, _restart: (newConfiguration: object) => void): void {
      // Tear down anything from a prior start() so request handlers don't
      // observe a half-built state during the rebuild below. Flip `started`
      // off FIRST so any concurrent request short-circuits at the gate
      // instead of indexing into a mutating proxies array.
      started = false
      if (upgradeHandler && app.server) {
        app.server.removeListener('upgrade', upgradeHandler)
        upgradeHandler = null
      }
      proxies = []
      currentApps = []

      const nextApps = parseConfig(config, (i, err) => {
        app.error(`Skipping app at config index ${i}: ${String(err)}`)
      })

      const nextProxies: (ProxyPair | null)[] = nextApps.map((appConfig, appIndex) => {
        // Null slot: this config entry failed validation. Keep the position so
        // later apps retain their numeric index (see parseConfig).
        if (!appConfig) return null
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
                const defaultProto = isEncrypted(req) ? 'https' : 'http'
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
                const defaultProto = isEncrypted(req) ? 'wss' : 'ws'
                applyForwardedHeaders(proxyReq, req, defaultProto)
                rewriteOriginHeader(proxyReq, req, targetOrigin)
              },
              proxyRes(
                proxyRes: IncomingMessage,
                _req: IncomingMessage,
                res: ServerResponse,
              ): void {
                const ct = String(proxyRes.headers['content-type'] ?? '')

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

                  // HTML responses get the rewrite script injected (and any
                  // upstream CSP nonce-patched rather than stripped, so the
                  // proxied app keeps its own XSS containment). Everything else
                  // streams straight through. rewriteHtmlResponse fails safe
                  // (502/503 or a pass-through) on decode/size/charset issues.
                  if (ct.includes('text/html')) {
                    rewriteHtmlResponse(proxyRes, res, {
                      rewriteScript,
                      proxyPathPrefix,
                      appBasePath: appConfig.path,
                      logError: (msg) => app.error(msg),
                    })
                    return
                  }
                }

                streamThrough(proxyRes, res)
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

      wsUnavailable = false
      if (app.server && nextProxies.length > 0) {
        // Forward WebSocket upgrades to the correct per-app proxy.
        // ws:false above means http-proxy-middleware does NOT auto-intercept
        // upgrades; we dispatch manually so only our plugin paths are affected.
        //
        // Capture nextApps/nextProxies in the closure rather than reading
        // through the module-level `currentApps`/`proxies`. This way a
        // subsequent start() (which mutates the module-level state before
        // installing its own listener) cannot cause an in-flight upgrade
        // already inside this handler to resolve against the wrong arrays.
        const handlerApps = nextApps
        const handlerProxies = nextProxies
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
          const index = resolveAppIndex(appId, handlerApps)
          if (index < 0 || index >= handlerProxies.length) {
            reject404()
            return
          }
          const pair = handlerProxies[index]
          if (!pair) {
            reject404()
            return
          }
          const afterAppId = slash >= 0 ? pathPart.substring(slash) : '/'
          // Root escape: strip the /__root__ marker and dispatch via the
          // host-only proxy. Shared with the HTTP route via resolveRootEscape.
          const { path: targetPath, proxy: targetProxy } = resolveRootEscape(afterAppId, pair)
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
          req.url = targetPath + queryString
          proxyUpgrade.call(targetProxy, req, socket, head)
        }
        app.server.on('upgrade', upgradeHandler)
      } else if (!app.server && nextProxies.some((p) => p != null)) {
        // SignalK didn't expose the HTTP server, so upgrades can't be
        // intercepted. HTTP proxying still works; warn so WebSocket-dependent
        // apps (Portainer container exec, Node-RED) don't fail silently.
        wsUnavailable = true
        app.error(
          'WebSocket support unavailable: SignalK did not expose app.server. ' +
            'HTTP proxying works, but WebSocket upgrades will not be proxied.',
        )
      }

      // Publish the new state only after the upgrade listener is wired so
      // there is no window where started=true but no listener is attached.
      currentApps = nextApps
      proxies = nextProxies
      started = true
    },

    stop(): void {
      // Flip `started` off BEFORE clearing the arrays so any concurrent
      // request short-circuits at the gate instead of indexing into an
      // empty proxies array.
      started = false
      if (upgradeHandler && app.server) {
        app.server.removeListener('upgrade', upgradeHandler)
      }
      upgradeHandler = null
      proxies = []
      currentApps = []
    },

    registerWithRouter(router: IRouter): void {
      // List configured apps — consumed by the React UI on load.
      router.get('/apps', (_req: Request, res: Response): void => {
        // Skip null slots (apps that failed validation) but keep the surviving
        // apps' positional index so numeric proxy URLs stay stable.
        const list = currentApps.flatMap((a, i) =>
          a == null
            ? []
            : [{ index: i, name: a.name, ...(a.appPath ? { appPath: a.appPath } : {}) }],
        )
        res.json(list)
      })

      // Single parameterized route handles both numeric indices (e.g. /proxy/0)
      // and custom appPath identifiers (e.g. /proxy/portainer).
      router.use(
        `${PROXY_SUBPATH}/:appId`,
        (req: Request, res: Response, next: () => void): void => {
          // Express's Request extends http.IncomingMessage, so the cast-free
          // call type-checks once the signature widens — but TS still wants
          // an explicit narrowing because Request has extra methods.
          stripInvalidHeaders(req)
          const appId = firstHeaderValue(req.params['appId'])
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
          const { path: targetPath, proxy } = resolveRootEscape(req.url ?? '', pair)
          req.url = targetPath
          if (!proxy) {
            res.status(404).json({ error: `No app found for "${appId}"` })
            return
          }
          // http-proxy-middleware v3 RequestHandler returns a Promise; fire
          // and forget — errors land in the `error` hook configured above.
          void proxy(req, res, next)
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
      // Ignore null slots (apps that failed validation).
      const configured = currentApps.filter((a): a is AppConfig => a != null)
      if (configured.length === 0) return 'No apps configured'
      const targets = configured.map((a) => buildTarget(a)).join(', ')
      const suffix = wsUnavailable ? ' (WebSocket support unavailable)' : ''
      return `Proxying to: ${targets}${suffix}`
    },
  }

  return plugin
}

// Pure helpers exposed for direct unit testing. Attaching them to the exported
// factory keeps the SignalK plugin contract (module.exports IS the factory
// function called as require(...)(app)) intact, while letting tests import the
// rewriting/parsing logic without booting a proxy.
Object.assign(module.exports, {
  parseAppConfig,
  parseConfig,
  resolveAppIndex,
  computeProxiedSuffix,
  isRootNamespace,
  rewriteSetCookie,
  splitCookieAttributes,
  rewriteHtmlAttributes,
  buildRewriteScript,
  addCspNonce,
  resolveRootEscape,
  normalizeHost,
  isValidHost,
  buildTarget,
  computeTargetOrigin,
  jsLiteral,
})
