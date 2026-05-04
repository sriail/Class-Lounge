// ============================================================
//  Cloudflare Worker — YouTube + TikTok Stream Proxy
//  Routes:
//    GET /              → serve UI
//    GET /yt/search?q=  → YouTube search
//    GET /yt/info?v=    → YouTube video streams
//    GET /tt/search?q=  → TikTok search
//    GET /tt/info?url=  → TikTok single video
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
      params: 'EgIQAQ==',
      context: {
        client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' },
      },
    }),
  });

  if (!res.ok) return jsonResponse({ results: [], error: `YT search ${res.status}` }, 200);
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
// ══════════��═══════════════════════════════════════════════════
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
      error: `TikTok API status ${data.status_code} — set TIKTOK_MSTOKEN env var`,
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
//  TikTok — Single Video Info
// ══════════════════════════════════════════════════════════════
async function handleTTInfo(url, env) {
  const videoUrl = url.searchParams.get('url');
  if (!videoUrl) return jsonResponse({ error: 'Missing ?url=' }, 400);

  const cacheKey = `tt:info:${videoUrl}`;
  if (env.CACHE) {
    const hit = await env.CACHE.get(cacheKey, 'json');
    if (hit) return jsonResponse(hit);
  }

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
    (vid.playAddr ? [vid.playAddr] : []);
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
//  Image Proxy
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
    ? h.endsWith('.tiktok.com') || h.endsWith('.tiktokv.com') ||
      h.endsWith('.muscdn.com') || h.endsWith('.tiktokcdn.com') ||
      h.endsWith('.tiktokcdn-us.com')
    : h.endsWith('.googlevideo.com') || h.endsWith('.youtube.com') ||
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
//  Client HTML — defined as a regular string to avoid backtick
//  collisions inside the template.  All inner backticks are
//  escaped with \`.
// ══════════════════════════════════════════════════════════════
const CLIENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
  <title>Stream Proxy</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0a0a0a;--surface:#161616;--border:#252525;
      --text:#f0f0f0;--muted:#777;
      --yt:#ff0000;--tt:#fe2c55;--accent:#ff4545;
      --r:10px;
    }
    html,body{height:100%;background:var(--bg);color:var(--text);
      font-family:system-ui,-apple-system,sans-serif;overflow:hidden}

    /* App shell */
    .app{display:flex;flex-direction:column;height:100dvh}

    header{
      flex-shrink:0;display:flex;flex-direction:column;gap:.55rem;
      padding:.6rem 1rem;background:var(--surface);
      border-bottom:1px solid var(--border);z-index:10
    }
    .hrow{display:flex;gap:.5rem;align-items:center}

    /* Tabs */
    .tab{
      display:flex;align-items:center;gap:.3rem;
      padding:.35rem .85rem;border-radius:20px;
      border:1px solid var(--border);background:transparent;
      color:var(--muted);font-size:.82rem;cursor:pointer;transition:all .18s;white-space:nowrap
    }
    .tab.yt-active{background:var(--yt);border-color:var(--yt);color:#fff}
    .tab.tt-active{background:var(--tt);border-color:var(--tt);color:#fff}
    .tab:not(.yt-active):not(.tt-active):hover{border-color:#555;color:var(--text)}

    /* Inputs */
    input{
      flex:1;padding:.48rem .85rem;border-radius:8px;
      border:1px solid var(--border);background:#1c1c1c;
      color:var(--text);font-size:.9rem;outline:none;transition:border-color .2s
    }
    input:focus{border-color:var(--accent)}

    .btn{
      padding:.48rem 1rem;border-radius:8px;border:none;
      background:var(--accent);color:#fff;font-size:.86rem;
      cursor:pointer;white-space:nowrap;transition:background .18s;flex-shrink:0
    }
    .btn:hover{background:#d93030}
    .btn:disabled{background:#333;cursor:not-allowed}

    #status{font-size:.76rem;color:var(--muted);padding:.05rem 0 .2rem;min-height:1em}
    #status.err{color:#ff6b6b}

    /* Panels */
    .panels{flex:1;overflow:hidden;position:relative}
    .panel{position:absolute;inset:0;overflow-y:auto;transition:opacity .18s,transform .18s}
    .panel.gone{opacity:0;pointer-events:none;transform:translateX(18px)}

    /* ───── YouTube panel ───── */
    #yt-panel{padding:.9rem;display:flex;flex-direction:column;gap:.9rem}

    .yt-player{
      background:var(--surface);border:1px solid var(--border);
      border-radius:var(--r);overflow:hidden;display:none;flex-direction:column
    }
    .yt-player video{width:100%;aspect-ratio:16/9;background:#000;display:block}
    .yt-meta{padding:.65rem .9rem;display:flex;flex-direction:column;gap:.35rem}
    .yt-title{font-size:.95rem;font-weight:600;line-height:1.35}
    .yt-author{font-size:.76rem;color:var(--muted)}
    .sGrid{display:flex;flex-wrap:wrap;gap:.3rem;padding:.1rem 0 .4rem}
    .sBtn{
      padding:.28rem .65rem;font-size:.75rem;border-radius:6px;
      border:1px solid var(--border);background:var(--surface);
      color:#ccc;cursor:pointer;transition:all .15s
    }
    .sBtn:hover,.sBtn.active{background:var(--accent);border-color:var(--accent);color:#fff}

    .yt-results{display:flex;flex-direction:column;gap:.6rem}
    .yt-card{
      display:flex;gap:.75rem;align-items:flex-start;
      background:var(--surface);border:1px solid var(--border);
      border-radius:var(--r);padding:.6rem;cursor:pointer;transition:border-color .15s
    }
    .yt-card:hover{border-color:#444}
    .yt-card.hidden{display:none}
    .yt-thumb-wrap{position:relative;flex-shrink:0;width:130px}
    .yt-thumb-wrap img{width:130px;aspect-ratio:16/9;object-fit:cover;border-radius:6px;display:block}
    .yt-dur{
      position:absolute;bottom:4px;right:4px;
      background:rgba(0,0,0,.8);color:#fff;font-size:.68rem;
      padding:.12rem .35rem;border-radius:4px
    }
    .yt-card-text{display:flex;flex-direction:column;gap:.25rem;min-width:0}
    .yt-card-title{font-size:.85rem;font-weight:500;line-height:1.35;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .yt-card-meta{font-size:.73rem;color:var(--muted)}

    /* ───── TikTok panel ───── */
    #tt-panel{display:flex;flex-direction:column}

    .tt-feed{
      flex:1;overflow-y:scroll;scroll-snap-type:y mandatory;
      height:calc(100dvh - var(--header-h, 130px));
      display:flex;flex-direction:column
    }
    .tt-results-grid{
      flex-shrink:0;display:grid;
      grid-template-columns:repeat(auto-fill,minmax(140px,1fr));
      gap:.5rem;padding:.8rem
    }
    .tt-thumb-card{
      cursor:pointer;border-radius:8px;overflow:hidden;
      background:var(--surface);border:1px solid var(--border);
      transition:border-color .15s;position:relative
    }
    .tt-thumb-card:hover{border-color:#555}
    .tt-thumb-card.hidden{display:none}
    .tt-thumb-card img{width:100%;aspect-ratio:9/16;object-fit:cover;display:block}
    .tt-thumb-card .tt-card-title{
      position:absolute;bottom:0;left:0;right:0;
      padding:.35rem .4rem;font-size:.7rem;line-height:1.3;
      background:linear-gradient(transparent,rgba(0,0,0,.85));
      color:#fff;display:-webkit-box;-webkit-line-clamp:2;
      -webkit-box-orient:vertical;overflow:hidden
    }
    .tt-card-author{
      position:absolute;top:5px;left:5px;
      background:rgba(0,0,0,.6);color:#fff;font-size:.65rem;
      padding:.1rem .35rem;border-radius:10px
    }

    /* Vertical snap feed (active video playback) */
    .tt-slide{
      flex-shrink:0;height:calc(100dvh - var(--header-h,130px));
      scroll-snap-align:start;position:relative;
      background:#000;display:flex;align-items:center;justify-content:center
    }
    .tt-slide video{
      max-width:100%;max-height:100%;object-fit:contain;display:block
    }
    .tt-slide-info{
      position:absolute;bottom:0;left:0;right:0;
      padding:.75rem;background:linear-gradient(transparent,rgba(0,0,0,.75));
      pointer-events:none
    }
    .tt-slide-title{font-size:.82rem;line-height:1.35;margin-bottom:.2rem;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .tt-slide-author{font-size:.73rem;color:#ccc}

    /* Load more */
    .load-more{
      margin:.6rem auto;padding:.45rem 1.2rem;border-radius:20px;
      border:1px solid var(--border);background:transparent;
      color:var(--muted);font-size:.82rem;cursor:pointer;transition:all .18s
    }
    .load-more:hover{border-color:#555;color:var(--text)}

    /* Empty / error states */
    .empty{
      text-align:center;color:var(--muted);font-size:.85rem;
      padding:3rem 1rem;line-height:1.8
    }
  </style>
</head>
<body>
<div class="app">
  <header id="header">
    <div class="hrow">
      <button class="tab yt-active" id="tab-yt">&#9654; YouTube</button>
      <button class="tab" id="tab-tt">&#9654; TikTok</button>
      <input id="search-input" placeholder="Search videos…" autocomplete="off" style="margin-left:.25rem"/>
      <button class="btn" id="search-btn">Search</button>
    </div>
    <div class="hrow">
      <input id="filter-input" placeholder="Filter results by title…" style="font-size:.8rem;color:var(--muted)"/>
    </div>
    <div id="status"></div>
  </header>

  <div class="panels">
    <div class="panel" id="yt-panel">
      <div class="yt-player" id="yt-player">
        <video id="yt-video" controls crossorigin="anonymous"></video>
        <div class="yt-meta">
          <div class="yt-title" id="yt-title"></div>
          <div class="yt-author" id="yt-author"></div>
          <div class="sGrid" id="yt-sgrid"></div>
        </div>
      </div>
      <div class="yt-results" id="yt-results"></div>
    </div>

    <div class="panel gone" id="tt-panel">
      <!-- grid view (search results) -->
      <div class="tt-results-grid" id="tt-grid"></div>
      <button class="load-more" id="tt-more" style="display:none">Load more</button>
      <!-- vertical snap feed -->
      <div class="tt-feed" id="tt-feed" style="display:none"></div>
    </div>
  </div>
</div>

<script>
(function(){
  // ── refs ─────────────────────────────────────────────────
  const tabYT      = document.getElementById('tab-yt');
  const tabTT      = document.getElementById('tab-tt');
  const searchInp  = document.getElementById('search-input');
  const searchBtn  = document.getElementById('search-btn');
  const filterInp  = document.getElementById('filter-input');
  const statusEl   = document.getElementById('status');
  const ytPanel    = document.getElementById('yt-panel');
  const ttPanel    = document.getElementById('tt-panel');
  const ytPlayer   = document.getElementById('yt-player');
  const ytVideo    = document.getElementById('yt-video');
  const ytTitle    = document.getElementById('yt-title');
  const ytAuthor   = document.getElementById('yt-author');
  const ytSgrid    = document.getElementById('yt-sgrid');
  const ytResults  = document.getElementById('yt-results');
  const ttGrid     = document.getElementById('tt-grid');
  const ttFeed     = document.getElementById('tt-feed');
  const ttMore     = document.getElementById('tt-more');
  const header     = document.getElementById('header');

  let activePlatform = 'yt';
  let ttCursor       = '0';
  let ttHasMore      = false;
  let ttQuery        = '';
  let ttItems        = [];   // all loaded TT search results
  let ttFeedItems    = [];   // items currently in the snap feed

  // ── header height CSS var (for tt-feed height calc) ──────
  function updateHeaderHeight(){
    document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
  }
  new ResizeObserver(updateHeaderHeight).observe(header);
  updateHeaderHeight();

  // ── tab switching ────────────────────────────────────────
  tabYT.addEventListener('click', () => switchTab('yt'));
  tabTT.addEventListener('click', () => switchTab('tt'));

  function switchTab(p){
    activePlatform = p;
    tabYT.className = 'tab' + (p==='yt' ? ' yt-active' : '');
    tabTT.className = 'tab' + (p==='tt' ? ' tt-active' : '');
    ytPanel.classList.toggle('gone', p !== 'yt');
    ttPanel.classList.toggle('gone', p !== 'tt');
    clearStatus();
    // apply existing filter to newly visible panel
    applyFilter(filterInp.value);
  }

  // ── search ───────────────────────────────────────────────
  searchBtn.addEventListener('click', doSearch);
  searchInp.addEventListener('keydown', e => { if(e.key==='Enter') doSearch(); });

  async function doSearch(){
    const q = searchInp.value.trim();
    if(!q) return;
    searchBtn.disabled = true;
    setStatus('Searching…');
    filterInp.value = '';

    if(activePlatform === 'yt'){
      await searchYT(q);
    } else {
      ttQuery   = q;
      ttCursor  = '0';
      ttItems   = [];
      ttFeed.style.display  = 'none';
      ttGrid.style.display  = '';
      ttGrid.innerHTML      = '';
      await loadMoreTT();
    }
    searchBtn.disabled = false;
  }

  // ── YouTube search ───────────────────────────────────────
  async function searchYT(q){
    try {
      const res  = await fetch('/yt/search?q=' + encodeURIComponent(q));
      const data = await res.json();
      if(data.error && !data.results?.length){ setStatus('YT: ' + data.error, true); return; }
      renderYTResults(data.results ?? []);
      setStatus(data.results?.length ? '' : 'No results');
    } catch(e){ setStatus('Error: ' + e.message, true); }
  }

  function renderYTResults(items){
    ytResults.innerHTML = '';
    ytPlayer.style.display = 'none';
    if(!items.length){ ytResults.innerHTML = '<div class="empty">No YouTube results found.</div>'; return; }

    items.forEach(v => {
      const card = document.createElement('div');
      card.className   = 'yt-card';
      card.dataset.title = (v.title||'').toLowerCase();
      card.innerHTML =
        '<div class="yt-thumb-wrap">' +
          '<img src="/proxy?url=' + encodeURIComponent(v.thumbnail) + '" alt="" loading="lazy"/>' +
          '<span class="yt-dur">' + esc(v.duration) + '</span>' +
        '</div>' +
        '<div class="yt-card-text">' +
          '<div class="yt-card-title">' + esc(v.title) + '</div>' +
          '<div class="yt-card-meta">' + esc(v.author) + ' &middot; ' + esc(v.views) + '</div>' +
        '</div>';
      card.addEventListener('click', () => loadYTVideo(v));
      ytResults.appendChild(card);
    });
  }

  async function loadYTVideo(v){
    setStatus('Loading player…');
    try {
      const res  = await fetch(v.infoUrl);
      const data = await res.json();
      if(!res.ok || !data.formats?.length){ setStatus(data.error || 'No streams', true); return; }
      renderYTPlayer(data);
      setStatus('');
      ytPlayer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch(e){ setStatus('Error: ' + e.message, true); }
  }

  function renderYTPlayer(data){
    ytTitle.textContent  = data.title  || '';
    ytAuthor.textContent = data.author || '';
    ytSgrid.innerHTML    = '';
    ytPlayer.style.display = 'flex';

    const videos = data.formats.filter(f => f.mimeType?.startsWith('video'));
    const audios = data.formats.filter(f => f.mimeType?.startsWith('audio'));
    const all    = [...videos, ...audios];

    all.forEach(f => {
      const btn = document.createElement('button');
      btn.className   = 'sBtn';
      btn.textContent = (f.mimeType?.startsWith('audio') ? '\uD83C\uDFB5 ' : '') +
                        (f.quality||'?') + ' (' + shortMime(f.mimeType) + ')';
      btn.title = f.mimeType || '';
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sBtn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const playing = !ytVideo.paused;
        ytVideo.src = f.proxyUrl;
        ytVideo.load();
        if(playing) ytVideo.play().catch(()=>{});
      });
      ytSgrid.appendChild(btn);
    });

    // auto-select best combined mp4
    const best = videos.find(f => f.mimeType?.includes('mp4') && !f.mimeType?.includes('av01'))
              ?? videos[0] ?? audios[0];
    if(best){
      const idx  = all.indexOf(best);
      const btns = ytSgrid.querySelectorAll('.sBtn');
      if(btns[idx]) btns[idx].click();
      else if(btns[0]) btns[0].click();
    }
  }

  // ── TikTok search / grid ─────────────────────────────────
  async function loadMoreTT(){
    setStatus('Searching TikTok…');
    try {
      const url  = '/tt/search?q=' + encodeURIComponent(ttQuery) + '&cursor=' + ttCursor;
      const res  = await fetch(url);
      const data = await res.json();

      if(data.error && !data.results?.length){
        setStatus('TikTok: ' + data.error, true);
        if(!ttItems.length) ttGrid.innerHTML = '<div class="empty">' + esc(data.error) + '</div>';
        ttMore.style.display = 'none';
        return;
      }

      ttItems = ttItems.concat(data.results ?? []);
      ttCursor  = data.nextCursor ?? '0';
      ttHasMore = !!data.hasMore;
      renderTTGrid(data.results ?? []);
      ttMore.style.display = ttHasMore ? 'block' : 'none';
      setStatus('');
    } catch(e){ setStatus('Error: ' + e.message, true); }
  }

  ttMore.addEventListener('click', loadMoreTT);

  function renderTTGrid(items){
    if(!items.length && !ttItems.length){
      ttGrid.innerHTML = '<div class="empty">No TikTok results found.</div>';
      return;
    }
    items.forEach((v, localIdx) => {
      const globalIdx = ttItems.length - items.length + localIdx;
      const card = document.createElement('div');
      card.className = 'tt-thumb-card';
      card.dataset.title = (v.title||'').toLowerCase();
      card.dataset.idx   = globalIdx;
      if(v.cover){
        const img = document.createElement('img');
        img.src     = v.cover;
        img.alt     = '';
        img.loading = 'lazy';
        card.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.style.cssText = 'width:100%;aspect-ratio:9/16;background:#1a1a1a;display:flex;align-items:center;justify-content:center;color:#555;font-size:.7rem';
        ph.textContent = 'No preview';
        card.appendChild(ph);
      }
      const titleEl = document.createElement('div');
      titleEl.className   = 'tt-card-title';
      titleEl.textContent = v.title || '';
      card.appendChild(titleEl);

      const authEl = document.createElement('div');
      authEl.className   = 'tt-card-author';
      authEl.textContent = v.author ? '@' + v.author : '';
      card.appendChild(authEl);

      card.addEventListener('click', () => openTTFeed(globalIdx));
      ttGrid.appendChild(card);
    });
  }

  // ── TikTok vertical snap feed ────────────────────────────
  function openTTFeed(startIdx){
    ttFeedItems = ttItems;
    ttFeed.innerHTML     = '';
    ttFeed.style.display = 'flex';
    ttGrid.style.display = 'none';
    ttMore.style.display = 'none';

    ttFeedItems.forEach((v, i) => {
      const slide = document.createElement('div');
      slide.className = 'tt-slide';

      const video = document.createElement('video');
      video.controls    = true;
      video.loop        = true;
      video.playsInline = true;
      video.preload     = 'none';
      video.src         = v.proxyUrl;
      slide.appendChild(video);

      const info = document.createElement('div');
      info.className = 'tt-slide-info';
      info.innerHTML =
        '<div class="tt-slide-title">' + esc(v.title||'') + '</div>' +
        '<div class="tt-slide-author">' + esc(v.author ? '@'+v.author : '') + '</div>';
      slide.appendChild(info);

      // back-to-grid button on first slide
      if(i === 0){
        const back = document.createElement('button');
        back.textContent = '\u2190 Back';
        back.style.cssText =
          'position:absolute;top:10px;left:10px;z-index:5;' +
          'padding:.3rem .7rem;border-radius:20px;border:none;' +
          'background:rgba(0,0,0,.6);color:#fff;font-size:.78rem;cursor:pointer';
        back.addEventListener('click', () => {
          ttFeed.style.display = 'none';
          ttGrid.style.display = '';
          ttMore.style.display = ttHasMore ? 'block' : 'none';
          // pause any playing video
          ttFeed.querySelectorAll('video').forEach(v => v.pause());
        });
        slide.appendChild(back);
      }

      ttFeed.appendChild(slide);
    });

    // scroll to startIdx immediately
    const targetSlide = ttFeed.children[startIdx];
    if(targetSlide) targetSlide.scrollIntoView({ behavior: 'instant' });

    // IntersectionObserver — auto-play visible slide, pause others
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const vid = entry.target.querySelector('video');
        if(!vid) return;
        if(entry.isIntersecting){
          vid.play().catch(()=>{});
        } else {
          vid.pause();
        }
      });
    }, { root: ttFeed, threshold: 0.6 });

    Array.from(ttFeed.children).forEach(slide => io.observe(slide));
  }

  // ── Live title filter ────────────────────────────────────
  filterInp.addEventListener('input', () => applyFilter(filterInp.value));

  function applyFilter(raw){
    const q = raw.trim().toLowerCase();
    if(activePlatform === 'yt'){
      document.querySelectorAll('.yt-card').forEach(el => {
        el.classList.toggle('hidden', q.length > 0 && !el.dataset.title.includes(q));
      });
    } else {
      document.querySelectorAll('.tt-thumb-card').forEach(el => {
        el.classList.toggle('hidden', q.length > 0 && !el.dataset.title.includes(q));
      });
    }
  }

  // ── Utilities ────────────────────────────────────────────
  function setStatus(msg, err){
    statusEl.textContent = msg;
    statusEl.className   = err ? 'err' : '';
  }
  function clearStatus(){ setStatus(''); }

  function shortMime(mime){
    if(!mime) return '?';
    return mime.split(';')[0].split('/')[1] ?? '?';
  }

  function esc(s){
    return String(s||'')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
</script>
</body>
</html>`;
