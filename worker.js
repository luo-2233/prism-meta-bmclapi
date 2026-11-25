const REPLACEMENTS = [
  // === Mojang ===
  { regex: /launchermeta\.mojang\.com/g, replacement: 'bmclapi2.bangbang93.com' },
  { regex: /piston-meta\.mojang\.com/g, replacement: 'bmclapi2.bangbang93.com' },
  { regex: /piston-data\.mojang\.com/g, replacement: 'bmclapi2.bangbang93.com' },
  { regex: /launcher\.mojang\.com/g, replacement: 'bmclapi2.bangbang93.com' },
  { regex: /resources\.download\.minecraft\.net/g, replacement: 'bmclapi2.bangbang93.com/assets' },
  { regex: /libraries\.minecraft\.net/g, replacement: 'bmclapi2.bangbang93.com/maven' },

  // === Fabric ===
  { regex: /meta\.fabricmc\.net/g, replacement: 'bmclapi2.bangbang93.com/fabric-meta' },
  { regex: /maven\.fabricmc\.net/g, replacement: 'bmclapi2.bangbang93.com/maven' },

  // === Forge ===
  { regex: /maven\.minecraftforge\.net/g, replacement: 'bmclapi2.bangbang93.com/maven' },
  { regex: /files\.minecraftforge\.net\/maven/g, replacement: 'bmclapi2.bangbang93.com/maven' },

  // === Liteloader ===
  { regex: /dl\.liteloader\.com\/versions\/versions\.json/g, replacement: 'bmclapi2.bangbang93.com/maven/com/mumfrey/liteloader/versions.json' },
  { regex: /dl\.liteloader\.com\/versions/g, replacement: 'bmclapi2.bangbang93.com/maven' },

  // === Neoforge ===
  { regex: /maven\.neoforged\.net\/releases/g, replacement: 'bmclapi2.bangbang93.com/maven' },

  // === Quilt ===
  { regex: /maven\.quiltmc\.org\/repository\/release/g, replacement: 'bmclapi2.bangbang93.com/maven' },
  { regex: /meta\.quiltmc\.org/g, replacement: 'bmclapi2.bangbang93.com/quilt-meta' }
];

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

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    let pathname = url.pathname;
    if (!pathname.startsWith('/')) pathname = '/' + pathname;

    // ✅ 修复：pathname 已带 /v1/，直接拼；不带时补上 /v1
    const metaPath = pathname.startsWith('/v1/') ? pathname : '/v1' + pathname;
    const upstream = 'https://meta.prismlauncher.org' + metaPath + url.search;

    let response;
    try {
      response = await fetch(upstream, { cf: { cacheTtl: 86400, cacheEverything: true } });
    } catch (e) {
      return new Response('Upstream fetch failed: ' + e.message, {
        status: 502,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    // ✅ 修复：body 会被改写，必须移除这些头
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.delete('transfer-encoding');

    if (!response.ok || (!contentType.includes('json') && !contentType.includes('text'))) {
      return new Response(response.body, { status: response.status, headers });
    }

    let body = await response.text();

    // ✅ /v1/packages/ 是 PrismLauncher 的包索引，原样代理，不做 BMCLAPI 替换
    //    里面的下载地址（GitHub / Modrinth CDN 等）本来也不在 BMCLAPI 覆盖范围内
    if (!pathname.includes('/packages/') && !pathname.includes('/net/fabricmc/intermediary/')) {
    for (const { regex, replacement } of REPLACEMENTS) {
        body = body.replace(regex, replacement);
    }
    body = stripIndexHashes(body);
}

    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=86400');

    return new Response(body, { status: response.status, headers });
  }
};
