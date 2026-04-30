/**
 * VidProxy — single Cloudflare Worker
 *
 *  ┌──────────┐  on 500/enc  ┌────────────────────┐
 *  │  Backup  │◄────────────►│  Grabber            │◄── YouTube / TikTok
 *  │  Proxy   │              │  (browser identity) │
 *  └──────────┘              └────────┬───────────┘
 *                                     │
 *                            ┌────────▼───────────┐
 *                            │  Aggregator         │
 *                            │  score·dedup·top-N  │
 *                            └────────┬───────────┘
 *                                     │
 *                            ┌────────▼───────────┐
 *                            │  Sender             │
 *                            │  format + TLS proxy │
 *                            └────────┬───────────┘
 *                                     │
 *                            ┌────────▼───────────┐
 *                            │  Web Client         │
 *                            │  (served inline)    │
 *                            └────────────────────┘
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   SECTION 1 — BROWSER IDENTITY  (shared by Grabber + Backup)
   ═══════════════════════════════════════════════════════════ */

const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,' +
    'image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language':           'en-US,en;q=0.9',
  DNT:                         '1',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Ch-Ua':                 '"Chromium";v="124","Google Chrome";v="124","Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile':          '?0',
  'Sec-Ch-Ua-Platform':        '"Windows"',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
  'Sec-Fetch-User':            '?1',
  'Cache-Control':             'max-age=0',
};

// Backup proxy rotates through these UA identities
const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];
let _uaIdx = 0;
const nextUA = () => UA_POOL[(_uaIdx++) % UA_POOL.length];

/* ═══════════════════════════════════════════════════════════
   SECTION 2 — GRABBER
   Mimics browser headers; acts as standard user on both
   platforms; passes URLs + metadata downstream.
   ═══════════════════════════════════════════════════════════ */

async function grabYouTube(query) {
  const url =
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=CAASAhAB`;

  const resp = await fetch(url, {
    headers: { ...BASE_HEADERS, Referer: 'https://www.youtube.com/' },
  });

  if (!resp.ok) {
    const e = new Error(`YouTube HTTP ${resp.status}`);
    e.status = resp.status;
    throw e;
  }

  const html  = await resp.text();
  const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!match) return [];

  let data;
  try { data = JSON.parse(match[1]); } catch { return []; }

  const contents =
    data?.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer
      ?.contents?.[0]?.itemSectionRenderer?.contents ?? [];

  return contents
    .filter(i => i.videoRenderer)
    .map(i => {
      const v       = i.videoRenderer;
      const viewTxt =
        v.viewCountText?.simpleText ||
        v.viewCountText?.runs?.map(r => r.text).join('') || '0';
      const durTxt  = v.lengthText?.simpleText || '';
      return {
        id:           v.videoId,
        title:        v.title?.runs?.map(r => r.text).join('') || 'Unknown',
        author:       v.ownerText?.runs?.[0]?.text || 'Unknown',
        thumbnail:    `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        views:        parseViews(viewTxt),
        viewsText:    viewTxt,
        likes:        0,
        comments:     0,
        duration:     durTxt,
        durationSecs: parseDur(durTxt),
        platform:     'youtube',
        url:          `https://www.youtube.com/watch?v=${v.videoId}`,
        publishedText: v.publishedTimeText?.simpleText || '',
      };
    })
    .filter(v => v.id);
}

async function grabTikTok(query) {
  // Primary: internal search API
  const apiURL =
    `https://www.tiktok.com/api/search/general/full/?aid=1988&app_language=en` +
    `&keyword=${encodeURIComponent(query)}&offset=0&count=20&from_page=search`;

  const resp = await fetch(apiURL, {
    headers: {
      ...BASE_HEADERS,
      Referer: `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  if (resp.ok) {
    try {
      const data  = await resp.json();
      const items = (data?.data ?? []).filter(i => i.item).map(i => mapTTItem(i.item));
      if (items.length) return items;
    } catch { /* fall through */ }
  }

  // Fallback: scrape __NEXT_DATA__
  const page = await fetch(
    `https://www.tiktok.com/search/video?q=${encodeURIComponent(query)}`,
    { headers: { ...BASE_HEADERS, Referer: 'https://www.tiktok.com/' } }
  );
  if (!page.ok) return [];

  const html  = await page.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.+?)<\/script>/s);
  if (!match) return [];

  try {
    const nd    = JSON.parse(match[1]);
    const items = nd?.props?.pageProps?.itemList ?? [];
    return items.map(mapTTItem);
  } catch { return []; }
}

function mapTTItem(v) {
  return {
    id:           v.id,
    title:        v.desc || 'TikTok Video',
    author:       v.author?.nickname || v.author?.uniqueId || 'Unknown',
    thumbnail:    v.video?.cover || '',
    views:        v.stats?.playCount    || 0,
    viewsText:    fmtNum(v.stats?.playCount    || 0),
    likes:        v.stats?.diggCount    || 0,
    comments:     v.stats?.commentCount || 0,
    duration:     fmtDurSecs(v.video?.duration || 0),
    durationSecs: v.video?.duration     || 0,
    platform:     'tiktok',
    url:          `https://www.tiktok.com/@${v.author?.uniqueId}/video/${v.id}`,
    publishedText: '',
  };
}

/* ═══════════════════════════════════════════════════════════
   SECTION 3 — BACKUP PROXY
   Activated on 500 / encrypted-transport errors.
   • Trusted registry auth  — rotates UA pool
   • TLS comms              — HTTPS only
   • Standard user identity — Referer + Sec-* spoofing
   Uses public Invidious mirrors as YouTube alternate path.
   ═══════════════════════════════════════════════════════════ */

const INVIDIOUS = [
  'https://invidious.kavin.rocks',
  'https://inv.riverside.rocks',
  'https://invidious.lunar.icu',
  'https://yt.artemislena.eu',
];

function altHeaders(referer) {
  return {
    'User-Agent':              nextUA(),
    Accept:                    'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language':         'en-US,en;q=0.5',
    Connection:                'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    Referer:                   referer,
  };
}

async function backupYouTube(query) {
  for (const mirror of INVIDIOUS) {
    try {
      const url  = `${mirror}/api/v1/search?q=${encodeURIComponent(query)}&type=video&page=1`;
      const resp = await fetch(url, { headers: altHeaders(mirror + '/') });
      if (!resp.ok) continue;
      const list = await resp.json();
      if (!Array.isArray(list) || !list.length) continue;
      return list.map(v => ({
        id:           v.videoId,
        title:        v.title,
        author:       v.author,
        thumbnail:    `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        views:        v.viewCount   || 0,
        viewsText:    fmtNum(v.viewCount || 0),
        likes:        v.likeCount   || 0,
        comments:     0,
        duration:     fmtDurSecs(v.lengthSeconds || 0),
        durationSecs: v.lengthSeconds || 0,
        platform:     'youtube',
        url:          `https://www.youtube.com/watch?v=${v.videoId}`,
        publishedText: v.publishedText || '',
      }));
    } catch { /* try next mirror */ }
  }
  return [];
}

async function backupTikTok(query) {
  const url  = `https://www.tiktok.com/search/video?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: altHeaders('https://www.tiktok.com/') });
  if (!resp.ok) return [];
  const html  = await resp.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.+?)<\/script>/s);
  if (!match) return [];
  try {
    const nd    = JSON.parse(match[1]);
    return (nd?.props?.pageProps?.itemList ?? []).map(mapTTItem);
  } catch { return []; }
}

/* ═══════════════════════════════════════════════════════════
   SECTION 4 — AGGREGATOR
   1. Engagement-based scoring (views 50% · likes 30% · comments 20%)
   2. Cross-platform normalisation (0–1 within combined pool)
   3. Deduplication pass (platform:id key)
   4. Top-N selection
   ═══════════════════════════════════════════════════════════ */

const W = { views: 0.50, likes: 0.30, comments: 0.20 };

function aggregate(items, topN = 24) {
  // Dedup
  const seen  = new Set();
  const dedup = items.filter(i => {
    const k = `${i.platform}:${i.id}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  // Cross-platform normalised scoring
  const maxV = Math.max(...dedup.map(i => i.views    || 0), 1);
  const maxL = Math.max(...dedup.map(i => i.likes    || 0), 1);
  const maxC = Math.max(...dedup.map(i => i.comments || 0), 1);

  const scored = dedup.map(i => ({
    ...i,
    score:
      W.views    * (i.views    || 0) / maxV +
      W.likes    * (i.likes    || 0) / maxL +
      W.comments * (i.comments || 0) / maxC,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

/* ═══════════════════════════════════════════════════════════
   SECTION 5 — SENDER
   Packages: title · author · source · thumbnail refs
   Encrypted delivery — HTTPS end-to-end (TLS) to client.
   ═══════════════════════════════════════════════════════════ */

function formatPayload(items) {
  return {
    success:   true,
    count:     items.length,
    timestamp: Date.now(),
    videos: items.map(v => ({
      id:           v.id,
      title:        v.title,
      author:       v.author,
      source:       v.platform,
      platform:     v.platform,
      thumbnail:    `/api/thumb?url=${encodeURIComponent(v.thumbnail)}`,
      thumbnailRaw: v.thumbnail,
      views:        v.viewsText || String(v.views || 0),
      duration:     v.duration  || fmtDurSecs(v.durationSecs || 0),
      durationSecs: v.durationSecs || 0,
      score:        Math.round((v.score || 0) * 1000) / 1000,
      url:          v.url,
      streamUrl:    `/api/stream/${v.platform}/${v.id}`,
      publishedText: v.publishedText || '',
      isShortForm:  (v.durationSecs || 0) > 0 && (v.durationSecs || 0) <= 60,
    })),
  };
}

/* ── YouTube stream via yt-dlp / ytdl fallback endpoint ── */
async function proxyYTStream(videoId, rangeHeader) {
  // Resolve formats via the public Invidious streams endpoint
  for (const mirror of INVIDIOUS) {
    try {
      const info = await fetch(
        `${mirror}/api/v1/videos/${videoId}`,
        { headers: altHeaders(mirror + '/') }
      );
      if (!info.ok) continue;
      const data = await info.json();

      const fmts     = data?.formatStreams ?? [];
      const adaptive = data?.adaptiveFormats ?? [];
      const all      = [...fmts, ...adaptive];

      // Prefer combined audio+video ≤ 720p
      const fmt =
        all.find(f => f.type?.startsWith('video/mp4') && f.qualityLabel === '360p') ||
        all.find(f => f.type?.startsWith('video/mp4')) ||
        all[0];

      if (!fmt?.url) continue;

      const headers = { ...altHeaders('https://www.youtube.com/'), Origin: 'https://www.youtube.com' };
      if (rangeHeader) headers['Range'] = rangeHeader;

      const upstream = await fetch(fmt.url, { headers });
      const out      = new Response(upstream.body, { status: upstream.status });
      out.headers.set('Content-Type', fmt.type || 'video/mp4');
      out.headers.set('Accept-Ranges', 'bytes');
      const cl = upstream.headers.get('content-length');
      const cr = upstream.headers.get('content-range');
      if (cl) out.headers.set('Content-Length', cl);
      if (cr) out.headers.set('Content-Range',  cr);
      return out;
    } catch { /* try next */ }
  }
  return new Response(JSON.stringify({ error: 'YT stream unavailable' }), {
    status: 502, headers: { 'Content-Type': 'application/json' },
  });
}

async function proxyTTStream(videoId, rangeHeader) {
  const headers = { ...altHeaders('https://www.tiktok.com/'), Accept: 'video/mp4,video/*;q=0.9' };

  const detail = await fetch(
    `https://www.tiktok.com/api/item/detail/?itemId=${videoId}&aid=1988`,
    { headers }
  ).catch(() => null);

  if (detail?.ok) {
    const data     = await detail.json();
    const videoUrl =
      data?.itemInfo?.itemStruct?.video?.downloadAddr ||
      data?.itemInfo?.itemStruct?.video?.playAddr;

    if (videoUrl) {
      if (rangeHeader) headers['Range'] = rangeHeader;
      const upstream = await fetch(videoUrl, { headers });
      const out      = new Response(upstream.body, { status: upstream.status });
      out.headers.set('Content-Type',  'video/mp4');
      out.headers.set('Accept-Ranges', 'bytes');
      const cr = upstream.headers.get('content-range');
      const cl = upstream.headers.get('content-length');
      if (cr) out.headers.set('Content-Range',  cr);
      if (cl) out.headers.set('Content-Length', cl);
      return out;
    }
  }
  return new Response(JSON.stringify({ error: 'TikTok stream unavailable — open original link' }), {
    status: 404, headers: { 'Content-Type': 'application/json' },
  });
}

async function proxyThumbnail(rawUrl) {
  const ref      = rawUrl.includes('tiktok') ? 'https://www.tiktok.com/' : 'https://www.youtube.com/';
  const upstream = await fetch(rawUrl, { headers: altHeaders(ref) });
  if (!upstream.ok) return new Response(null, { status: upstream.status });
  const out = new Response(upstream.body);
  out.headers.set('Content-Type',  upstream.headers.get('content-type') || 'image/jpeg');
  out.headers.set('Cache-Control', 'public, max-age=3600');
  return out;
}

/* ═══════════════════════════════════════════════════════════
   SECTION 6 — WEB CLIENT  (served inline by the worker)
   Inter font · cyan accent · YouTube red / TikTok blue bubbles
   Short ≤ 60 s / Long toggle · scroll + search + recs layout
   ═══════════════════════════════════════════════════════════ */

const HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VidProxy</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0c0c14;--bg-card:#13131f;--bg-hover:#1a1a2a;
  --border:rgba(255,255,255,.07);--border-hi:rgba(255,255,255,.13);
  --cyan:#00d4e4;--cyan-dim:rgba(0,212,228,.12);--cyan-glow:rgba(0,212,228,.25);
  --yt:#ff4545;--yt-bg:rgba(255,69,69,.14);
  --tt:#4fc3f7;--tt-bg:rgba(79,195,247,.14);
  --text:#e6e6f0;--muted:#7878a0;--r:12px;--r-sm:8px;
}
html{scroll-behavior:smooth}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}

/* ── Header ── */
.header{position:sticky;top:0;z-index:100;background:rgba(12,12,20,.85);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-bottom:1px solid var(--border);padding:10px 20px}
.header-inner{max-width:1440px;margin:0 auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:7px;flex-shrink:0}
.logo-icon{color:var(--cyan);font-size:18px}
.logo-text{font-size:17px;font-weight:700;background:linear-gradient(130deg,var(--cyan) 0%,#a78bfa 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.search-wrap{flex:1;min-width:180px}
.search-bar{display:flex;align-items:center;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden;transition:border-color .2s,box-shadow .2s}
.search-bar:focus-within{border-color:var(--cyan);box-shadow:0 0 0 3px var(--cyan-dim)}
.s-icon{color:var(--muted);margin-left:12px;flex-shrink:0;width:15px;height:15px}
.search-bar input{flex:1;background:none;border:none;outline:none;padding:9px 10px;color:var(--text);font-family:inherit;font-size:13.5px}
.search-bar input::placeholder{color:var(--muted)}
.btn-go{background:var(--cyan-dim);border:none;border-left:1px solid var(--border);color:var(--cyan);font-family:inherit;font-size:13px;font-weight:600;padding:9px 16px;cursor:pointer;transition:background .2s}
.btn-go:hover{background:var(--cyan-glow)}
.header-controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.pill-group{display:flex;gap:3px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--r-sm);padding:3px}
.pill{background:none;border:none;color:var(--muted);font-family:inherit;font-size:12.5px;font-weight:500;padding:5px 11px;border-radius:6px;cursor:pointer;transition:all .18s;display:flex;align-items:center;gap:5px}
.pill:hover{color:var(--text);background:var(--bg-hover)}
.pill.active{color:var(--cyan);background:var(--cyan-dim)}
.badge{font-size:9px;font-weight:800;letter-spacing:.4px;padding:2px 5px;border-radius:4px}
.yt-badge{background:var(--yt-bg);color:var(--yt)}
.tt-badge{background:var(--tt-bg);color:var(--tt)}

/* ── Feed ── */
.main{max-width:1440px;margin:0 auto;padding:22px 20px 60px}
.video-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px}

/* ── Card ── */
.video-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;cursor:pointer;transition:transform .22s,box-shadow .22s,border-color .22s}
.video-card:hover{transform:translateY(-4px);box-shadow:0 10px 36px rgba(0,0,0,.5);border-color:rgba(0,212,228,.28)}
.card-thumb{position:relative;background:#09090f;aspect-ratio:16/9;overflow:hidden}
.video-card.short-form .card-thumb{aspect-ratio:9/16}
.card-thumb img{width:100%;height:100%;object-fit:cover;transition:transform .3s}
.video-card:hover .card-thumb img{transform:scale(1.05)}
.card-plat{position:absolute;top:8px;left:8px;font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;padding:3px 8px;border-radius:6px}
.card-plat.youtube{background:var(--yt-bg);color:var(--yt);border:1px solid rgba(255,69,69,.25)}
.card-plat.tiktok{background:var(--tt-bg);color:var(--tt);border:1px solid rgba(79,195,247,.25)}
.card-dur{position:absolute;bottom:7px;right:7px;background:rgba(0,0,0,.78);color:#fff;font-size:11px;font-weight:600;padding:2px 6px;border-radius:4px}
.card-body{padding:11px 13px 13px}
.card-title{font-size:13.5px;font-weight:600;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:7px}
.card-meta{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}
.card-author{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:58%}

/* ── States ── */
.loader{display:flex;flex-direction:column;align-items:center;gap:14px;padding:60px;color:var(--muted);font-size:13.5px}
.loader.hidden,.empty-state.hidden{display:none}
.spinner{width:30px;height:30px;border:3px solid var(--border);border-top-color:var(--cyan);border-radius:50%;animation:spin .75s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty-state{text-align:center;padding:100px 20px;color:var(--muted)}
.empty-icon{font-size:48px;color:var(--cyan);opacity:.3;margin-bottom:16px}
.empty-state p{font-size:14.5px}

/* ── Modal ── */
.modal{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:20px}
.modal.hidden{display:none}
.modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.88);backdrop-filter:blur(10px)}
.modal-box{position:relative;z-index:1;background:var(--bg-card);border:1px solid var(--border-hi);border-radius:16px;max-width:880px;width:100%;overflow:hidden;box-shadow:0 24px 72px rgba(0,0,0,.7)}
.modal-close{position:absolute;top:10px;right:10px;z-index:10;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.08);border:none;color:var(--text);cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;transition:background .18s}
.modal-close:hover{background:rgba(255,255,255,.16)}
.modal-player{aspect-ratio:16/9;background:#000}
.modal-player video{width:100%;height:100%}
.modal-info{padding:14px 18px 18px}
.modal-badge{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;padding:3px 9px;border-radius:5px;margin-bottom:8px}
.modal-badge.youtube{background:var(--yt-bg);color:var(--yt)}
.modal-badge.tiktok{background:var(--tt-bg);color:var(--tt)}
.modal-title{font-size:16px;font-weight:600;line-height:1.4;margin-bottom:7px}
.modal-meta{font-size:12.5px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.sep{color:var(--border-hi)}
.open-link{font-size:13px;color:var(--cyan);text-decoration:none;font-weight:500}
.open-link:hover{text-decoration:underline}

::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border-hi);border-radius:3px}
@media(max-width:700px){.header-inner{gap:10px}.main{padding:14px}.video-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}}
</style>
</head>
<body>

<header class="header">
  <div class="header-inner">
    <div class="logo">
      <span class="logo-icon">▶</span>
      <span class="logo-text">VidProxy</span>
    </div>
    <div class="search-wrap">
      <div class="search-bar">
        <svg class="s-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input id="searchInput" type="text" placeholder="Search YouTube &amp; TikTok…" autocomplete="off"/>
        <button id="searchBtn" class="btn-go">Search</button>
      </div>
    </div>
    <div class="header-controls">
      <div class="pill-group" id="platformGroup">
        <button class="pill active" data-platform="all">All</button>
        <button class="pill yt-pill" data-platform="youtube"><span class="badge yt-badge">YT</span> YouTube</button>
        <button class="pill tt-pill" data-platform="tiktok"><span class="badge tt-badge">TT</span> TikTok</button>
      </div>
      <div class="pill-group" id="formGroup">
        <button class="pill active" data-form="all">All</button>
        <button class="pill" data-form="short">Short ≤60s</button>
        <button class="pill" data-form="long">Long &gt;60s</button>
      </div>
    </div>
  </div>
</header>

<main class="main">
  <div id="videoGrid" class="video-grid"></div>
  <div id="loader" class="loader hidden">
    <div class="spinner"></div><span>Fetching streams…</span>
  </div>
  <div id="emptyState" class="empty-state">
    <div class="empty-icon">▶</div>
    <p id="emptyMsg">Search for something to get started</p>
  </div>
</main>

<div id="videoModal" class="modal hidden" role="dialog" aria-modal="true">
  <div class="modal-backdrop" id="modalBackdrop"></div>
  <div class="modal-box">
    <button class="modal-close" id="modalClose" aria-label="Close">✕</button>
    <div class="modal-player"><video id="videoPlayer" controls playsinline></video></div>
    <div class="modal-info">
      <span class="modal-badge" id="modalBadge"></span>
      <h2 class="modal-title" id="modalTitle"></h2>
      <div class="modal-meta">
        <span id="modalAuthor"></span>
        <span class="sep" id="modalViewSep">·</span>
        <span id="modalViews"></span>
        <span class="sep" id="modalDurSep">·</span>
        <span id="modalDur"></span>
      </div>
      <a id="modalLink" href="#" target="_blank" rel="noopener noreferrer" class="open-link">Open original ↗</a>
    </div>
  </div>
</div>

<script>
(function(){
'use strict';
const $  = id => document.getElementById(id);
const $$ = s  => document.querySelectorAll(s);

const state = { query:'', platform:'all', form:'all', videos:[], loading:false };

const searchInput   = $('searchInput');
const searchBtn     = $('searchBtn');
const videoGrid     = $('videoGrid');
const loader        = $('loader');
const emptyState    = $('emptyState');
const emptyMsg      = $('emptyMsg');
const videoModal    = $('videoModal');
const videoPlayer   = $('videoPlayer');
const modalClose    = $('modalClose');
const modalBackdrop = $('modalBackdrop');

$$('#platformGroup .pill').forEach(b => b.addEventListener('click', () => {
  $$('#platformGroup .pill').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  state.platform = b.dataset.platform;
  if (state.query) doSearch();
}));

$$('#formGroup .pill').forEach(b => b.addEventListener('click', () => {
  $$('#formGroup .pill').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  state.form = b.dataset.form;
  renderGrid();
}));

searchBtn.addEventListener('click', go);
searchInput.addEventListener('keydown', e => { if(e.key==='Enter') go(); });
function go(){ const q=searchInput.value.trim(); if(!q) return; state.query=q; doSearch(); }

modalClose.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', closeModal);
document.addEventListener('keydown', e => { if(e.key==='Escape') closeModal(); });

async function doSearch(){
  if(state.loading) return;
  state.loading = true;
  videoGrid.innerHTML = '';
  hideEmpty();
  showLoader(true);
  try{
    const r = await fetch('/api/search?q='+encodeURIComponent(state.query)+'&type='+state.platform+'&limit=30');
    if(!r.ok) throw new Error('HTTP '+r.status);
    const d = await r.json();
    state.videos = d.videos || [];
    renderGrid();
  }catch(e){
    console.error(e);
    showEmpty('Search failed — check connection or try again.');
  }finally{
    state.loading = false;
    showLoader(false);
  }
}

function renderGrid(){
  videoGrid.innerHTML = '';
  hideEmpty();
  let list = [...state.videos];
  if(state.form==='short') list = list.filter(v => v.durationSecs>0 && v.durationSecs<=60);
  if(state.form==='long')  list = list.filter(v => v.durationSecs>60 || v.durationSecs===0);
  if(!list.length){ showEmpty('No videos matched — try adjusting the filters.'); return; }
  list.forEach(v => videoGrid.appendChild(makeCard(v)));
}

function makeCard(v){
  const el   = document.createElement('div');
  const plat = v.platform==='youtube' ? 'youtube' : 'tiktok';
  const lbl  = v.platform==='youtube' ? 'YouTube'  : 'TikTok';
  el.className = 'video-card'+(v.isShortForm?' short-form':'');
  el.innerHTML =
    '<div class="card-thumb">'+
      '<img src="'+v.thumbnail+'" alt="" loading="lazy" onerror="this.src=\'data:image/svg+xml,<svg xmlns=\\\'http://www.w3.org/2000/svg\\\' width=\\\'320\\\' height=\\\'180\\\'/>\'" />'+
      '<span class="card-plat '+plat+'">'+lbl+'</span>'+
      (v.duration?'<span class="card-dur">'+esc(v.duration)+'</span>':'')+
    '</div>'+
    '<div class="card-body">'+
      '<div class="card-title">'+esc(v.title)+'</div>'+
      '<div class="card-meta"><span class="card-author">'+esc(v.author)+'</span><span class="card-views">'+esc(v.views)+' views</span></div>'+
    '</div>';
  el.addEventListener('click', () => openModal(v));
  return el;
}

function openModal(v){
  const plat = v.platform==='youtube' ? 'youtube' : 'tiktok';
  const lbl  = v.platform==='youtube' ? 'YouTube'  : 'TikTok';
  const badge = $('modalBadge');
  badge.className = 'modal-badge '+plat;
  badge.textContent = lbl;
  $('modalTitle').textContent  = v.title;
  $('modalAuthor').textContent = v.author;
  $('modalViews').textContent  = v.views+' views';
  const durEl = $('modalDur'), durSep = $('modalDurSep');
  if(v.duration){ durEl.textContent=v.duration; durEl.style.display=durSep.style.display=''; }
  else          { durEl.style.display=durSep.style.display='none'; }
  $('modalLink').href = v.url;
  videoPlayer.src = v.streamUrl;
  videoPlayer.load();
  videoPlayer.play().catch(()=>{});
  videoModal.classList.remove('hidden');
  document.body.style.overflow='hidden';
}

function closeModal(){
  videoModal.classList.add('hidden');
  videoPlayer.pause();
  videoPlayer.src='';
  document.body.style.overflow='';
}

function showLoader(on){ loader.classList.toggle('hidden',!on); }
function showEmpty(msg){ emptyMsg.textContent=msg||'No results'; emptyState.classList.remove('hidden'); }
function hideEmpty(){ emptyState.classList.add('hidden'); }
function esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

window.addEventListener('load', () => { state.query='trending'; searchInput.value='trending'; doSearch(); });
})();
</script>
</body>
</html>`;

/* ═══════════════════════════════════════════════════════════
   SECTION 7 — SHARED HELPERS
   ═══════════════════════════════════════════════════════════ */

function parseViews(t) {
  if (!t) return 0;
  t = t.replace(/,/g, '').replace(/\s*views?/i, '').trim();
  if (t.endsWith('B')) return parseFloat(t) * 1e9;
  if (t.endsWith('M')) return parseFloat(t) * 1e6;
  if (t.endsWith('K')) return parseFloat(t) * 1e3;
  return parseInt(t) || 0;
}
function parseDur(t) {
  if (!t) return 0;
  const p = t.split(':').map(Number);
  if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
  if (p.length === 2) return p[0]*60   + p[1];
  return p[0] || 0;
}
function fmtDurSecs(s) {
  if (!s) return '';
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`
    : `${m}:${String(ss).padStart(2,'0')}`;
}
function fmtNum(n) {
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return String(n);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/* ═══════════════════════════════════════════════════════════
   SECTION 8 — MAIN FETCH HANDLER  (CF Worker entry point)
   ═══════════════════════════════════════════════════════════ */

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const TOP_N  = parseInt(env.TOP_N ?? '24', 10);

    /* ── Web client ───────────────────────────────────── */
    if (path === '/' || path === '/index.html') {
      return new Response(HTML, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    /* ── Search ───────────────────────────────────────── */
    if (path === '/api/search') {
      const q    = url.searchParams.get('q');
      const type = url.searchParams.get('type') || 'all';
      const limit= parseInt(url.searchParams.get('limit') || TOP_N, 10);
      if (!q) return json({ error: 'Query required' }, 400);

      /* Grabber — with automatic failover to Backup Proxy on 500 */
      let raw = [];
      try {
        const [yt, tt] = await Promise.all([
          (type === 'all' || type === 'youtube')
            ? grabYouTube(q).catch(e => { if (e.status >= 500) throw e; return []; })
            : Promise.resolve([]),
          (type === 'all' || type === 'tiktok')
            ? grabTikTok(q).catch(() => [])
            : Promise.resolve([]),
        ]);
        raw = [...yt, ...tt];
      } catch (err) {
        /* 500 on primary → Backup Proxy (bidirectional failover) */
        console.error('[Worker] Primary grabber 500 — activating backup proxy:', err.message);
        const [yt, tt] = await Promise.all([
          (type === 'all' || type === 'youtube') ? backupYouTube(q).catch(() => []) : [],
          (type === 'all' || type === 'tiktok')  ? backupTikTok(q).catch(() => [])  : [],
        ]);
        raw = [...yt, ...tt];
      }

      const ranked  = aggregate(raw, limit);   // Aggregator
      const payload = formatPayload(ranked);   // Sender
      return json(payload);
    }

    /* ── Stream proxy ─────────────────────────────────── */
    if (path.startsWith('/api/stream/')) {
      const [, , , platform, videoId] = path.split('/');
      if (!platform || !videoId) return json({ error: 'Invalid stream path' }, 400);
      const range = request.headers.get('range') || undefined;

      if (platform === 'youtube') return proxyYTStream(videoId, range);
      if (platform === 'tiktok')  return proxyTTStream(videoId, range);
      return json({ error: 'Unknown platform' }, 400);
    }

    /* ── Thumbnail proxy ──────────────────────────────── */
    if (path === '/api/thumb') {
      const rawUrl = url.searchParams.get('url');
      if (!rawUrl) return new Response(null, { status: 400 });
      return proxyThumbnail(rawUrl);
    }

    return new Response('Not found', { status: 404 });
  },
};
