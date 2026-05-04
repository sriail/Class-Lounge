// ============================================================
//  Cloudflare Worker — YouTube + TikTok Stream Proxy
//  Routes:
//    GET /              → serve UI
//    GET /yt/search?q=  → YouTube InnerTube search
//    GET /yt/info?v=    → YouTube video streams
//    GET /tt/search?q=  → TikTok search
//    GET /tt/info?url=  → TikTok single video info
//    GET /stream?p=&url=→ proxy stream (p=yt|tt)
//    GET /proxy?url=    → proxy images/thumbnails
// ============================================================

const INNERTUBE_KEY        = 'AIzaSyA8eiZmM1fanX44NAntTElyiyAW0C9wkpI';
const INNERTUBE_PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`;
const INNERTUBE_SEARCH_URL = `https://www.youtube.com/youtubei/v1/search?key=${INNERTUBE_KEY}&prettyPrint=false`;

const ANDROID_UA = 'com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ── Entry ─────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/':          return htmlResponse(CLIENT_HTML);
        case '/yt/search': return handleYTSearch(url, env);
        case '/yt/info':   return handleYTInfo(url, env);
        case '/tt/search': return handleTTSearch(url, env);
        case '/tt/info':   return handleTTInfo(url, env);
        case '/stream':    return handleStream(request, url);
        case '/proxy':     return handleProxy(url);
        default:           return new Response('Not found', { status: 404 });
      }
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

// ══════════════════════════════════════════════════════════════
//  YouTube — Search
// ══════════════════════════════════════════════════════════════
async function handleYTSearch(url, env) {
  const q = url.searchParams.get('q');
  if (!q) return jsonResponse({ error: 'Missing ?q=' }, 400);

  const cacheKey = `yt:search:${q}`;
  if (env.CACHE) {
    const hit = await env.CACHE.get(cacheKey, 'json');
    if (hit) return jsonResponse(hit);
  }

  const res = await fetch(INNERTUBE_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_UA,
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': '2.20240101.00.00',
      'Origin': 'https://www.youtube.com',
      'Referer': `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({
      query: q,
      params: 'EgIQAQ==', // videos only
      context: {
        client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' },
      },
    }),
  });

  if (!res.ok) return jsonResponse({ error: `YT search ${res.status}`, results: [] }, 200);
  const data = await res.json();
  const results = parseYTSearchResults(data, url.origin);
  const payload = { results };
  if (env.CACHE && results.length)
    await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 });
  return jsonResponse(payload);
}

function parseYTSearchResults(data, origin) {
  const out = [];
  try {
    const sections =
      data?.contents?.twoColumnSearchResultsRenderer
           ?.primaryContents?.sectionListRenderer?.contents ?? [];
    for (const section of sections) {
      for (const item of section?.itemSectionRenderer?.contents ?? []) {
        const v = item?.videoRenderer;
        if (!v?.videoId) continue;
        out.push({
          platform:  'youtube',
          id:        v.videoId,
          title:     v.title?.runs?.[0]?.text ?? '',
          author:    v.ownerText?.runs?.[0]?.text ?? '',
          duration:  v.lengthText?.simpleText ?? '',
          views:     v.viewCountText?.simpleText ?? '',
          thumbnail: v.thumbnail?.thumbnails?.at(-1)?.url ?? '',
          infoUrl:   `${origin}/yt/info?v=${v.videoId}`,
        });
      }
    }
  } catch {}
  return out;
}

// ══════════════════════════════════════════════════════════════
//  YouTube — Player Info
// ══════════════════════════════════════════════════════════════
async function handleYTInfo(url, env) {
  const videoId = url.searchParams.get('v');
  if (!videoId) return jsonResponse({ error: 'Missing ?v=' }, 400);

  const cacheKey = `yt:info:${videoId}`;
  if (env.CACHE) {
    const hit = await env.CACHE.get(cacheKey, 'json');
    if (hit) return jsonResponse(hit);
  }

  const player = await fetchYTPlayer(videoId);
  if (!player) return jsonResponse({ error: 'Player fetch failed after retries' }, 502);

  const { videoDetails, streamingData, playabilityStatus } = player;
  if (playabilityStatus?.status === 'LOGIN_REQUIRED')
    return jsonResponse({ error: 'Age-gated or private' }, 403);
  if (!streamingData)
    return jsonResponse({ error: playabilityStatus?.reason ?? 'No streaming data' }, 403);

  const formats = [
    ...(streamingData.formats ?? []),
    ...(streamingData.adaptiveFormats ?? []),
  ]
    .filter(f => f.url)
    .map(f => ({
      itag: f.itag, mimeType: f.mimeType,
      quality: f.qualityLabel ?? f.audioQuality ?? 'unknown',
      bitrate: f.bitrate, width: f.width, height: f.height, fps: f.fps,
      contentLength: f.contentLength,
      proxyUrl: `${url.origin}/stream?p=yt&url=${encodeURIComponent(f.url)}`,
    }));

  const payload = {
    platform: 'youtube', videoId,
    title: videoDetails?.title, author: videoDetails?.author,
    lengthSeconds: videoDetails?.lengthSeconds,
    thumbnail: videoDetails?.thumbnail?.thumbnails?.at(-1)?.url,
    formats,
  };
  if (env.CACHE && formats.length)
    await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 1800 });
  return jsonResponse(payload);
}

async function fetchYTPlayer(videoId, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(300 * 2 ** i);
    const res = await fetch(INNERTUBE_PLAYER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': ANDROID_UA,
        'X-YouTube-Client-Name': '3',
        'X-YouTube-Client-Version': '17.36.4',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.youtube.com',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'ANDROID', clientVersion: '17.36.4',
            androidSdkVersion: 31, osName: 'Android', osVersion: '12',
            hl: 'en', gl: 'US', utcOffsetMinutes: 0,
          },
        },
        params: 'CgIQBg==',
      }),
    });
    if (!res.ok) continue;
    try { return await res.json(); } catch { continue; }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
//  TikTok — Search
// ══════════════════════════════════════════════════════════════
async function handleTTSearch(url, env) {
  const q      = url.searchParams.get('q');
  const cursor = url.searchParams.get('cursor') ?? '0';
  if (!q) return jsonResponse({ error: 'Missing ?q=' }, 400);

  const cacheKey = `tt:search:${q}:${cursor}`;
  if (env.CACHE) {
    const hit = await env.CACHE.get(cacheKey, 'json');
    if (hit) return jsonResponse(hit);
  }

  const params = new URLSearchParams({
    keyword: q, cursor, count: '12',
    aid: '1988', app_language: 'en', app_name: 'tiktok_web',
    browser_language: 'en-US', browser_name: 'Mozilla',
    browser_platform: 'Win32', browser_version: '5.0 (Windows)',
    channel: 'tiktok_web', cookie_enabled: 'true',
    device_platform: 'web_pc', focus_state: 'true',
    from_page: 'search', history_len: '2',
    is_fullscreen: 'false', is_page_visible: 'true',
    os: 'windows', priority_region: '', referer: '',
    region: 'US', screen_height: '1080', screen_width: '1920',
    tz_name: 'America/New_York', webcast_language: 'en',
  });

  const msToken = env.TIKTOK_MSTOKEN ?? '';
  const res = await fetch(
    `https://www.tiktok.com/api/search/general/full/?${params}`,
    {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`,
        ...(msToken ? { Cookie: `msToken=${msToken}` } : {}),
      },
    }
  );

  if (!res.ok)
    return jsonResponse({ results: [], error: `TikTok ${res.status}`, hasMore: false }, 200);

  let data;
  try { data = await res.json(); }
  catch { return jsonResponse({ results: [], error: 'Parse error', hasMore: false }, 200); }

  if (data.status_code !== 0)
    return jsonResponse({
      results: [], hasMore: false,
      error: `TikTok API status ${data.status_code} — may need TIKTOK_MSTOKEN env var`,
    }, 200);

  const results = parseTTResults(data, url.origin);
  const payload = { results, nextCursor: data.cursor ?? null, hasMore: data.has_more === 1 };

  if (env.CACHE && results.length)
    await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 });
  return jsonResponse(payload);
}

function parseTTResults(data, origin) {
  const out = [];
  for (const item of (data.data ?? data.item_list ?? [])) {
    const v  = item.item ?? item;
    const id = v.id ?? v.aweme_id;
    if (!id) continue;

    const vid    = v.video  ?? {};
    const auth   = v.author ?? {};
    const plays  = vid.play_addr?.url_list ?? vid.download_addr?.url_list ?? [];
    const covers = vid.cover?.url_list ?? vid.origin_cover?.url_list ?? [];
    const play   = plays[0] ?? '';
    if (!play) continue;

    out.push({
      platform:     'tiktok',
      id,
      title:        v.desc ?? '',
      author:       auth.nickname ?? auth.unique_id ?? '',
      authorHandle: auth.unique_id ?? '',
      duration:     vid.duration ?? 0,
      width:        vid.width  ?? 576,
      height:       vid.height ?? 1024,
      cover:        covers[0] ? `${origin}/proxy?url=${encodeURIComponent(covers[0])}` : '',
      proxyUrl:     `${origin}/stream?p=tt&url=${encodeURIComponent(play)}`,
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  TikTok — Single Video Info (from full URL or short URL)
// ══════════════════════════════════════════════════════════════
async function handleTTInfo(url, env) {
  const videoUrl = url.searchParams.get('url');
  if (!videoUrl) return jsonResponse({ error: 'Missing ?url=' }, 400);

  const cacheKey = `tt:info:${videoUrl}`;
  if (env.CACHE) {
    const hit = await env.CACHE.get(cacheKey, 'json');
    if (hit) return jsonResponse(hit);
  }

  // Resolve short links
  let resolved = videoUrl;
  try {
    const u = new URL(videoUrl);
    if (['vm.tiktok.com', 'vt.tiktok.com'].includes(u.hostname)) {
      const r = await fetch(videoUrl, { redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      resolved = r.url;
    }
  } catch {}

  const res = await fetch(resolved, {
    headers: {
      'User-Agent': MOBILE_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,*/*;q=0.8',
    },
    redirect: 'follow',
  });

  if (!res.ok) return jsonResponse({ error: `TikTok page ${res.status}` }, 502);
  const html = await res.text();

  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
  if (!match) return jsonResponse({ error: 'Could not find __NEXT_DATA__' }, 502);

  let nd;
  try { nd = JSON.parse(match[1]); }
  catch { return jsonResponse({ error: '__NEXT_DATA__ parse failed' }, 502); }

  const item = nd?.props?.pageProps?.itemInfo?.itemStruct;
  if (!item) return jsonResponse({ error: 'No itemStruct in page data' }, 502);

  const vid  = item.video  ?? {};
  const auth = item.author ?? {};
  const plays =
    vid.bitrateInfo?.flatMap(b => b.PlayAddr?.UrlList ?? []) ??
    (vid.playAddr ? [vid.playAddr] : []) ??
    vid.play_addr?.url_list ?? [];

  const cover = vid.cover ?? vid.dynamicCover ?? '';

  const payload = {
    platform: 'tiktok', id: item.id,
    title: item.desc ?? '', author: auth.nickname ?? '',
    authorHandle: auth.uniqueId ?? '', duration: vid.duration ?? 0,
    cover: cover ? `${url.origin}/proxy?url=${encodeURIComponent(cover)}` : '',
    formats: plays.map((u, i) => ({
      quality:  vid.bitrateInfo?.[i]?.QualityType ?? `stream_${i}`,
      proxyUrl: `${url.origin}/stream?p=tt&url=${encodeURIComponent(u)}`,
    })),
  };

  if (env.CACHE && payload.formats.length)
    await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 600 });
  return jsonResponse(payload);
}

// ══════════════════════════════════════════════════════════════
//  Stream Proxy
// ══════════════════════════════════════════════════════════════
async function handleStream(request, url) {
  const target   = url.searchParams.get('url');
  const platform = url.searchParams.get('p') ?? 'yt';
  if (!target) return new Response('Missing ?url=', { status: 400 });

  let targetUrl;
  try { targetUrl = new URL(decodeURIComponent(target)); }
  catch { return new Response('Invalid URL', { status: 400 }); }

  if (!isTrustedOrigin(targetUrl, platform))
    return new Response('Forbidden origin', { status: 403 });

  const upHeaders = platform === 'tt'
    ? { 'User-Agent': MOBILE_UA, 'Referer': 'https://www.tiktok.com/', 'Accept-Language': 'en-US,en;q=0.9' }
    : { 'User-Agent': BROWSER_UA, 'Origin': 'https://www.youtube.com', 'Referer': 'https://www.youtube.com/', 'Accept-Language': 'en-US,en;q=0.9' };

  const range = request.headers.get('Range');
  if (range) upHeaders['Range'] = range;

  const upstream = await fetch(targetUrl.toString(), { headers: upHeaders });

  const respHeaders = new Headers();
  for (const k of ['Content-Type','Content-Length','Content-Range','Accept-Ranges','Last-Modified','ETag']) {
    const v = upstream.headers.get(k);
    if (v) respHeaders.set(k, v);
  }
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Cache-Control', 'public, max-age=3600');
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

// ══════════════════════════════════════════════════════════════
//  Image / Thumbnail Proxy
// ══════════════════════════════════════════════════════════════
async function handleProxy(url) {
  const target = url.searchParams.get('url');
  if (!target) return new Response('Missing ?url=', { status: 400 });

  let targetUrl;
  try { targetUrl = new URL(decodeURIComponent(target)); }
  catch { return new Response('Invalid URL', { status: 400 }); }

  const h = targetUrl.hostname;
  const allowed =
    h.endsWith('.googlevideo.com') || h.endsWith('.youtube.com') ||
    h.endsWith('.ytimg.com')       || h.endsWith('.ggpht.com')   ||
    h.endsWith('.tiktok.com')      || h.endsWith('.tiktokv.com') ||
    h.endsWith('.muscdn.com')      || h.endsWith('.tiktokcdn.com') ||
    h.endsWith('.tiktokcdn-us.com');

  if (!allowed) return new Response('Forbidden', { status: 403 });

  const upstream = await fetch(targetUrl.toString(), {
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://www.tiktok.com/' },
  });
  const respHeaders = new Headers(upstream.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*');
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════
function isTrustedOrigin(url, platform) {
  const h = url.hostname;
  return platform === 'tt'
    ? h.endsWith('.tiktok.com')    || h.endsWith('.tiktokv.com')      ||
      h.endsWith('.muscdn.com')    || h.endsWith('.tiktokcdn.com')     ||
      h.endsWith('.tiktokcdn-us.com')
    : h.endsWith('.googlevideo.com') || h.endsWith('.youtube.com')    ||
      h.endsWith('.ytimg.com')       || h.endsWith('.ggpht.com');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
//  Client UI
// ══════════════════════════════════════════════════════════════
const CLIENT_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
  <title>Stream Proxy</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0a0a0a; --surface:#161616; --border:#252525;
      --text:#f0f0f0; --muted:#777;
      --yt:#ff0000; --tt:#fe2c55; --accent:#ff4545;
      --r:10px;
    }
    html,body{height:100%;background:var(--bg);color:var(--text);
      font-family:system-ui,-apple-system,sans-serif;overflow:hidden}

    /* ── App shell ── */
    .app{display:flex;flex-direction:column;height:100dvh}

    header{
      flex-shrink:0;display:flex;flex-direction:column;gap:.6rem;
      padding:.65rem 1rem;background:var(--surface);
      border-bottom:1px solid var(--border);z-index:10
    }
    .header-row{display:flex;gap:.5rem;align-items:center}

    /* ── Tabs ── */
    .tab{
      display:flex;align-items:center;gap:.35rem;
      padding:.38rem .9rem;border-radius:20px;
      border:1px solid var(--border);background:transparent;
      color:var(--muted);font-size:.85rem;cursor:pointer;transition:all .2s;
      white-space:nowrap
    }
    .tab.yt-active{background:var(--yt);border-color:var(--yt);color:#fff}
    .tab.tt-active{background:var(--tt);border-color:var(--tt);color:#fff}
    .tab:not(.yt-active):not(.tt-active):hover{border-color:#555;color:var(--text)}

    /* ── Inputs ── */
    input{
      flex:1;padding:.5rem .85rem;border-radius:8px;
      border:1px solid var(--border);background:#1c1c1c;
      color:var(--text);font-size:.92rem;outline:none;transition:border-color .2s
    }
    input:focus{border-color:var(--accent)}
    input.filter{font-size:.82rem;color:var(--muted)}
    input.filter:focus{color:var(--text)}

    .btn{
      padding:.5rem 1rem;border-radius:8px;border:none;
      background:var(--accent);color:#fff;font-size:.88rem;
      cursor:pointer;white-space:nowrap;transition:background .2s;flex-shrink:0
    }
    .btn:hover{background:#d93030}
    .btn:disabled{background:#3a3a3a;cursor:not-allowed}

    #status{
      font-size:.78rem;color:var(--muted);
      padding:.1rem 1rem .3rem;min-height:1.1em;flex-shrink:0
    }
    #status.err{color:#ff6b6b}

    /* ── Panels ── */
    .panels{flex:1;overflow:hidden;position:relative}
    .panel{position:absolute;inset:0;overflow-y:auto;transition:opacity .18s,transform .18s}
    .panel.gone{opacity:0;pointer-events:none;transform:translateX(20px)}

    /* ── YouTube panel ── */
    #yt-panel{padding:1rem;display:flex;flex-direction:column;gap:1rem}

    /* Player */
    .yt-player{
      background:var(--surface);border:1px solid var(--border);
      border-radius:var(--r);overflow:hidden;display:none;flex-direction:column
    }
    .yt-player video{width:100%;aspect-ratio:16/9;background:#000;display:block}
    .yt-meta{padding:.7rem 1rem;display:flex;flex-direction:column;gap:.45rem}
    .yt-title{font-size:.98rem;font-weight:600;line-height:1.35}
    .yt-author{font-size:.78rem;color:var(--muted)}
    .sGrid{display:flex;flex-wrap:wrap;gap:.35rem;padding:.1rem 0 .3rem}
    .sBtn{
      
