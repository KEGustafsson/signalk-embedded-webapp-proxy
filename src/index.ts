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

// Escape segment used to route paths that fall outside the app's configured
// base path directly to the target host root. The rewrite script emits
// /<proxyPrefix>/__root__/<path> for those URLs; the HTTP and WS upgrade
// handlers strip the marker and dispatch to a host-only proxy.
const ROOT_ESCAPE = '/__root__'

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
    // T: transform a root-relative path into the suffix that follows the proxy prefix.
    //    - Inside B (app base): strip B so the upstream target's base path isn't double-prefixed.
    //    - Outside B: prepend the __root__ escape so the server routes the request via the
    //      host-only proxy (e.g. /plugins/<other>/ws reaches the host root, not target+path).
    //    - When B is empty, the target has no base path so nothing to strip or escape.
    'function T(s){if(!B)return s;' +
    'if(s.indexOf(B+"/")===0)return s.slice(B.length);' +
    'if(s===B)return "/";' +
    'return "/__root__"+s}' +
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
    'var W=window.WebSocket;if(W){' +
    'window.WebSocket=function(u,p){' +
    'var l=window.location;' +
    'if(typeof u==="string"){' +
    'var m=u.match(/^wss?:\\/\\/([^/?#]+)([/?#].*)?$/);' +
    'if(m&&m[1]===l.host){var pt=m[2]||"/";' +
    'if(pt.charAt(0)==="/"&&pt.indexOf(P)!==0)' +
    "u=(l.protocol==='https:'?'wss:':'ws:')+'//'+l.host+P+T(pt)}" +
    'else if(R(u))' +
    "u=(l.protocol==='https:'?'wss:':'ws:')+'//'+l.host+P+T(u)}" +
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
    // --- Element.prototype.setAttribute override ---
    // Synchronously rewrite src/href/action attribute values so assignments
    // via setAttribute (not just the property setter) are caught before the
    // browser fires any network request they trigger.
    'try{var SA=Element.prototype.setAttribute;' +
    'Element.prototype.setAttribute=function(n,v){' +
    'if(typeof n==="string"&&typeof v==="string"){' +
    'var ln=n.toLowerCase();' +
    'if(ln==="src"||ln==="href"||ln==="action"||ln==="formaction")v=Y(v)}' +
    'return SA.call(this,n,v)};}catch(e){}' +
    // --- innerHTML / outerHTML / insertAdjacentHTML ---
    // HTML parsed via innerHTML creates elements with src/href already set, and
    // the browser fires the network request synchronously during parsing.
    // Rewrite matching attribute values in the HTML string itself so the parser
    // sees the proxy-prefixed URL.
    'function RH(h){if(typeof h!=="string")return h;' +
    'return h.replace(/(\\s(?:src|href|action|formaction)\\s*=\\s*)("([^"]*)"|\'([^\']*)\'|([^\\s>]+))/gi,' +
    'function(_,pre,_all,dq,sq,uq){var q="\\"",v=dq;if(sq!==undefined){q="\'";v=sq}else if(uq!==undefined){q="";v=uq}' +
    'v=Y(v);return pre+q+v+q})}' +
    'try{var IH=Object.getOwnPropertyDescriptor(Element.prototype,"innerHTML");' +
    'if(IH&&IH.set){var IHs=IH.set;Object.defineProperty(Element.prototype,"innerHTML",{get:IH.get,' +
    'set:function(v){return IHs.call(this,RH(v))},configurable:true,enumerable:true})}' +
    'var OH=Object.getOwnPropertyDescriptor(Element.prototype,"outerHTML");' +
    'if(OH&&OH.set){var OHs=OH.set;Object.defineProperty(Element.prototype,"outerHTML",{get:OH.get,' +
    'set:function(v){return OHs.call(this,RH(v))},configurable:true,enumerable:true})}' +
    'var IA=Element.prototype.insertAdjacentHTML;' +
    'if(IA){Element.prototype.insertAdjacentHTML=function(p,h){return IA.call(this,p,RH(h))}}' +
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
            proxyRes(proxyRes: IncomingMessage, _req: IncomingMessage, res: ServerResponse): void {
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
                    const appPathBase =
                      appConfig.path === '/' ? '' : appConfig.path.replace(/\/$/, '')
                    let suffix: string
                    if (!appPathBase) {
                      suffix = loc
                    } else if (loc.startsWith(appPathBase + '/')) {
                      suffix = loc.slice(appPathBase.length)
                    } else if (loc === appPathBase) {
                      suffix = '/'
                    } else {
                      suffix = `${ROOT_ESCAPE}${loc}`
                    }
                    proxyRes.headers['location'] = `${proxyPathPrefix}${suffix}`
                  }
                }

                if (ct.includes('text/html')) {
                  // HTML: decompress if needed, inject path-rewriting script, then send.
                  const encoding = String(proxyRes.headers['content-encoding'] ?? '').toLowerCase()
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
                        let suffix: string
                        if (!appPathBase) {
                          suffix = url
                        } else if (url.startsWith(appPathBase + '/')) {
                          suffix = url.slice(appPathBase.length)
                        } else if (url === appPathBase) {
                          suffix = '/'
                        } else {
                          suffix = `${ROOT_ESCAPE}${url}`
                        }
                        return `${attr}${proxyPathPrefix}${suffix}`
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
                  return
                }
              }

              // Stream response directly, preserving all original headers
              // (including Content-Type).
              const headers = { ...proxyRes.headers }
              delete headers['transfer-encoding']
              res.writeHead(status, headers)
              proxyRes.pipe(res)
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
          const useRoot =
            afterAppId === ROOT_ESCAPE || afterAppId.startsWith(ROOT_ESCAPE + '/')
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
