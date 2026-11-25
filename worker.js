/**
 * PrismLauncher Meta 镜像 Worker（修复版）
 *
 * 关键改动：
 *  1) 不再把 piston-meta.mojang.com 换成 BMCLAPI 域名。
 *     BMCLAPI 只镜像 /version/<id>/... ，不镜像 /v1/packages/<sha1>/<file>.json，
 *     而资产索引（assets index）正好是后一种路径 → 404。
 *  2) piston-meta 的地址改成本 Worker 自己的 /piston-meta/* 直通代理，
 *     资产索引仍从 Mojang 取（原样转发、原样校验 sha1）。
 *  3) 顺手修掉：/v1 少斜杠时的 /v1/v1、错误响应被缓存 24h、改写后残留的 etag/last-modified。
 */
const BMCLAPI = 'https://bmclapi2.bangbang93.com';
const META_UPSTREAM = 'https://meta.prismlauncher.org';
const PISTON_META_UPSTREAM = 'https://piston-meta.mojang.com';
const PROXY_PREFIX = '/piston-meta';
// 结构不变的下载域名 → BMCLAPI。origin 用于把 piston-meta 指回自己。
function buildRewrites(origin) {
  return [
    // === Mojang ===
    // piston-meta 不能直接映射到 BMCLAPI（/v1/packages/ 会 404），走本 Worker 直通
    { regex: /(?:https?:)?\/\/piston-meta\.mojang\.com/g, replacement: origin + PROXY_PREFIX },
    { regex: /(?:https?:)?\/\/libraries\.minecraft\.net/g, replacement: BMCLAPI + '/maven' },
    { regex: /(?:https?:)?\/\/resources\.download\.minecraft\.net/g, replacement: BMCLAPI + '/assets' },
    { regex: /(?:https?:)?\/\/piston-data\.mojang\.com/g, replacement: BMCLAPI },
    { regex: /(?:https?:)?\/\/launchermeta\.mojang\.com/g, replacement: BMCLAPI },
    { regex: /(?:https?:)?\/\/launcher\.mojang\.com/g, replacement: BMCLAPI },
    // === Fabric ===
    { regex: /(?:https?:)?\/\/meta\.fabricmc\.net/g, replacement: BMCLAPI + '/fabric-meta' },
    { regex: /(?:https?:)?\/\/maven\.fabricmc\.net/g, replacement: BMCLAPI + '/maven' },
    // === Forge ===
    { regex: /(?:https?:)?\/\/maven\.minecraftforge\.net/g, replacement: BMCLAPI + '/maven' },
    { regex: /(?:https?:)?\/\/files\.minecraftforge\.net\/maven/g, replacement: BMCLAPI + '/maven' },
    // === Liteloader ===
    { regex: /(?:https?:)?\/\/dl\.liteloader\.com\/versions\/versions\.json/g, replacement: BMCLAPI + '/maven/com/mumfrey/liteloader/versions.json' },
    { regex: /(?:https?:)?\/\/dl\.liteloader\.com\/versions/g, replacement: BMCLAPI + '/maven' },
    // === NeoForge ===
    { regex: /(?:https?:)?\/\/maven\.neoforged\.net\/releases/g, replacement: BMCLAPI + '/maven' },
    // === Quilt ===
    { regex: /(?:https?:)?\/\/maven\.quiltmc\.org\/repository\/release/g, replacement: BMCLAPI + '/maven' },
    { regex: /(?:https?:)?\/\/meta\.quiltmc\.org/g, replacement: BMCLAPI + '/quilt-meta' }
  ];
}
function stripIndexHashes(body) {
  try {
    const json = JSON.parse(body);
    let modified = false;
    if (Array.isArray(json.versions)) {
      for (const v of json.versions) {
        if ('sha256' in v) { delete v.sha256; modified = true; }
        if ('sha1' in v)   { delete v.sha1;   modified = true; }
      }
    }
    if (Array.isArray(json.packages)) {
      for (const p of json.packages) {
        if ('sha256' in p) { delete p.sha256; modified = true; }
        if ('sha1' in p)   { delete p.sha1;   modified = true; }
      }
    }
    return modified ? JSON.stringify(json) : body;
  } catch {
    return body;
  }
}
const CORS = { 'Access-Control-Allow-Origin': '*' };
function forwardHeaders(source, { rewritten }) {
  const headers = new Headers(source);
  // body 会被重新编码/改写，这些头必须去掉
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  if (rewritten) {
    // 内容已经被改写，原始 ETag / Last-Modified 不再描述这份 body
    headers.delete('etag');
    headers.delete('last-modified');
  }
  return headers;
}
export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }
    const url = new URL(request.url);
    const origin = url.origin;
    let pathname = url.pathname;
    if (!pathname.startsWith('/')) pathname = '/' + pathname;
    // ── 直通代理：BMCLAPI 不镜像的 Mojang 资源（资产索引等）──────────────
    if (pathname === PROXY_PREFIX || pathname.startsWith(PROXY_PREFIX + '/')) {
      const target = PISTON_META_UPSTREAM + pathname.slice(PROXY_PREFIX.length) + url.search;
      let upstream;
      try {
        upstream = await fetch(target, { cf: { cacheTtl: 86400, cacheEverything: true, cacheKey: target } });
      } catch (e) {
        return new Response('Upstream fetch failed: ' + e.message, { status: 502, headers: CORS });
      }
      const headers = forwardHeaders(upstream.headers, { rewritten: false });
      headers.set('Cache-Control', upstream.ok ? 'public, max-age=86400' : 'no-store');
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    // ── Prism Meta 代理 ───────────────────────────────────────────────
    // pathname 已带 /v1/ 时直接拼，否则补 /v1；/v1 本身补成 /v1/
    const metaPath = pathname === '/v1' || pathname === '/v1/'
      ? '/v1/'
      : pathname.startsWith('/v1/')
        ? pathname
        : '/v1' + pathname;
    const upstreamUrl = META_UPSTREAM + metaPath + url.search;
    let response;
    try {
      response = await fetch(upstreamUrl, { cf: { cacheTtl: 86400, cacheEverything: true } });
    } catch (e) {
      return new Response('Upstream fetch failed: ' + e.message, { status: 502, headers: CORS });
    }
    const contentType = response.headers.get('content-type') || '';
    const isText = contentType.includes('json') || contentType.includes('text');
    if (!response.ok || !isText) {
      const headers = forwardHeaders(response.headers, { rewritten: false });
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', response.ok ? 'public, max-age=86400' : 'no-store');
      return new Response(response.body, { status: response.status, headers });
    }
    let body = await response.text();
    // packages / intermediary 里的下载地址 BMCLAPI 覆盖不到，原样代理
    const skipRewrite = pathname.includes('/packages/') || pathname.includes('/net.fabricmc.intermediary/');
    if (!skipRewrite) {
      for (const { regex, replacement } of buildRewrites(origin)) {
        body = body.replace(regex, replacement);
      }
      body = stripIndexHashes(body);
    }
    const headers = forwardHeaders(response.headers, { rewritten: true });
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(body, { status: response.status, headers });
  }
};
