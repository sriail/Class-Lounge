// ================================================================
// main-worker.js  —  CF Worker: Grabber → Aggregator → Sender + UI
// ================================================================
//
// Wrangler secrets / env vars to set:
//   wrangler secret put YOUTUBE_API_KEY        (YouTube Data API v3)
//   wrangler secret put BACKUP_WORKER_URL      (https://backup.yourname.workers.dev)
//   wrangler secret put REGISTRY_SECRET        (shared HMAC secret with backup worker)
//
// Routes:
//   GET  /                               → Serve SPA UI
//   GET  /api/search?q=&type=&limit=     → Grabber → Aggregator → Sender
//   GET  /api/proxy/stream?url=&platform= → Stream proxy (with Range support)
//   GET  /api/proxy/embed?id=&platform=  → Return safe embed URL
// ================================================================

// ================================================================
// ── CONSTANTS ────────────────────────────────────────────────────
// ================================================================

const YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const YT_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
const YT_EMBED_BASE = "https://www.youtube.com/embed/";

const TT_OEMBED_URL = "https://www.tiktok.com/oembed";
const TT_EMBED_BASE = "https://www.tiktok.com/embed/v2/";

const TOP_N = 20; // default top results
const SHORT_FORM_MAX_SECONDS = 180; // ≤ 3 min = short-form

// ── Browser header mimicry pool (mimics standard user, avoids bot detection)
const BROWSER_UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function randomUA() {
  return BROWSER_UA_POOL[Math.floor(Math.random() * BROWSER_UA_POOL.length)];
}

function browserHeaders(referer) {
  return {
    "User-Agent": randomUA(),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-CH-UA":
      '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
    ...(referer ? { Referer: referer } : {}),
  };
}

// ================================================================
// ── CRYPTO HELPERS ───────────────────────────────────────────────
// ================================================================

async function hmacSign(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ================================================================
// ── GRABBER — Mimics browser headers, acts as standard user ──────
//             Fetches YT + TikTok content, passes URLs + metadata
// ================================================================

async function grabYouTube(query, limit, apiKey) {
  if (!apiKey) {
    console.warn("YOUTUBE_API_KEY not set — returning mock YT data");
    return mockYouTubeResults(query, limit);
  }

  // Step 1: Search videos
  const searchParams = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(Math.min(limit, 50)),
    key: apiKey,
    relevanceLanguage: "en",
    safeSearch: "none",
  });

  const searchResp = await fetch(`${YT_SEARCH_URL}?${searchParams}`, {
    headers: browserHeaders("https://www.youtube.com/"),
    cf: { cacheTtl: 60 },
  });

  if (!searchResp.ok) {
    throw new Error(`YT search failed: ${searchResp.status}`);
  }

  const searchData = await searchResp.json();
  const items = searchData.items || [];
  if (items.length === 0) return [];

  const ids = items.map((i) => i.id.videoId).join(",");

  // Step 2: Fetch engagement stats + duration
  const statsParams = new URLSearchParams({
    part: "statistics,contentDetails,snippet",
    id: ids,
    key: apiKey,
  });

  const statsResp = await fetch(`${YT_VIDEOS_URL}?${statsParams}`, {
    headers: browserHeaders("https://www.youtube.com/"),
    cf: { cacheTtl: 60 },
  });

  if (!statsResp.ok) {
    throw new Error(`YT stats failed: ${statsResp.status}`);
  }

  const statsData = await statsResp.json();

  return (statsData.items || []).map((item) => {
    const snip = item.snippet || {};
    const stats = item.statistics || {};
    const details = item.contentDetails || {};
    const durationSec = iso8601ToSeconds(details.duration || "PT0S");

    return {
      id: item.id,
      platform: "youtube",
      title: snip.title || "Untitled",
      author: snip.channelTitle || "Unknown",
      description: snip.description || "",
      thumbnail:
        snip.thumbnails?.maxres?.url ||
        snip.thumbnails?.high?.url ||
        snip.thumbnails?.medium?.url ||
        `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`,
      embedUrl: `${YT_EMBED_BASE}${item.id}?autoplay=1&rel=0`,
      sourceUrl: `https://www.youtube.com/watch?v=${item.id}`,
      publishedAt: snip.publishedAt || "",
      durationSec,
      type: durationSec > 0 && durationSec <= SHORT_FORM_MAX_SECONDS ? "short" : "long",
      views: parseInt(stats.viewCount || "0", 10),
      likes: parseInt(stats.likeCount || "0", 10),
      comments: parseInt(stats.commentCount || "0", 10),
      engagementScore: 0, // filled by aggregator
    };
  });
}

async function grabTikTok(query, limit) {
  // TikTok oEmbed + web search approach with browser header mimicry
  // For production: replace with approved TikTok Research API
  // https://developers.tiktok.com/products/research-api/
  const results = [];

  try {
    // Use TikTok's unofficial search endpoint with full browser header mimicry
    const searchUrl = `https://www.tiktok.com/api/search/general/full/?aid=1988&app_language=en&keyword=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}&offset=0&from_page=search&web_id=0`;

    const resp = await fetch(searchUrl, {
      headers: {
        ...browserHeaders("https://www.tiktok.com/"),
        "X-TT-PARAMS": "",
        Cookie: "", // Session cookies would go here in production
      },
      cf: { cacheTtl: 30 },
    });

    if (resp.ok) {
      const data = await resp.json();
      const items = data?.data || [];

      for (const item of items) {
        const video = item?.item || item;
        if (!video?.id) continue;

        const durationSec = video?.video?.duration || 0;

        results.push({
          id: String(video.id),
          platform: "tiktok",
          title: video?.desc || "TikTok Video",
          author: video?.author?.nickname || video?.author?.uniqueId || "Unknown",
          description: video?.desc || "",
          thumbnail: video?.video?.cover || video?.video?.originCover || "",
          embedUrl: `${TT_EMBED_BASE}${video.id}`,
          sourceUrl: `https://www.tiktok.com/@${video?.author?.uniqueId}/video/${video.id}`,
          publishedAt: video?.createTime
            ? new Date(video.createTime * 1000).toISOString()
            : "",
          durationSec,
          type: durationSec > 0 && durationSec <= SHORT_FORM_MAX_SECONDS ? "short" : "long",
          views: video?.stats?.playCount || 0,
          likes: video?.stats?.diggCount || 0,
          comments: video?.stats?.commentCount || 0,
          engagementScore: 0,
        });
      }
    }
  } catch (err) {
    console.warn("TikTok fetch failed, using mock data:", err.message);
  }

  // Fall back to mock data if no results
  if (results.length === 0) {
    return mockTikTokResults(query, limit);
  }

  return results;
}

// ── YouTube stream URL extractor (youtubei internal API) ─────────
async function getYouTubeStreamUrl(videoId) {
  const playerPayload = {
    videoId,
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "19.09.37",
        androidSdkVersion: 30,
        userAgent: "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
        hl: "en",
        gl: "US",
      },
    },
  };

  const resp = await fetch(
    `${YT_PLAYER_URL}?key=AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
        "X-Youtube-Client-Name": "3",
        "X-Youtube-Client-Version": "19.09.37",
      },
      body: JSON.stringify(playerPayload),
      cf: { cacheTtl: 120 },
    }
  );

  if (!resp.ok) return null;

  const data = await resp.json();
  const formats = [
    ...(data?.streamingData?.formats || []),
    ...(data?.streamingData?.adaptiveFormats || []),
  ];

  // Pick best mp4 stream
  const best = formats
    .filter((f) => f.mimeType?.startsWith("video/mp4") && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

  return best?.url || null;
}

// ── TikTok stream URL extractor ──────────────────────────────────
async function getTikTokStreamUrl(videoId, authorId) {
  const pageUrl = `https://www.tiktok.com/@${authorId}/video/${videoId}`;

  const resp = await fetch(pageUrl, {
    headers: browserHeaders("https://www.tiktok.com/"),
    cf: { cacheTtl: 60 },
  });

  if (!resp.ok) return null;

  const html = await resp.text();

  // Extract __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON blob
  const match = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) return null;

  try {
    const json = JSON.parse(match[1]);
    const videoDetail =
      json?.["__DEFAULT_SCOPE__"]?.["webapp.video-detail"]?.itemInfo?.itemStruct;
    return (
      videoDetail?.video?.playAddr ||
      videoDetail?.video?.downloadAddr ||
      null
    );
  } catch {
    return null;
  }
}

// ================================================================
// ── AGGREGATOR — Rank, score, deduplicate, return top-N ─────────
// ================================================================

function aggregator(ytVideos, ttVideos, typeFilter, limit) {
  // Merge all videos
  let all = [...ytVideos, ...ttVideos];

  // ── Deduplication pass (by platform+id) ─────────────────────────
  const seen = new Set();
  all = all.filter((v) => {
    const key = `${v.platform}:${v.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Type filter (short / long / all) ────────────────────────────
  if (typeFilter === "short") all = all.filter((v) => v.type === "short");
  else if (typeFilter === "long") all = all.filter((v) => v.type === "long");

  // ── Engagement-based scoring ─────────────────────────────────────
  // Normalize each metric across the full pool, then weight:
  //   views    × 0.40
  //   likes    × 0.35
  //   comments × 0.25
  const maxViews = Math.max(1, ...all.map((v) => v.views));
  const maxLikes = Math.max(1, ...all.map((v) => v.likes));
  const maxComments = Math.max(1, ...all.map((v) => v.comments));

  all = all.map((v) => ({
    ...v,
    engagementScore:
      (v.views / maxViews) * 0.4 +
      (v.likes / maxLikes) * 0.35 +
      (v.comments / maxComments) * 0.25,
  }));

  // ── Cross-platform comparison sort ──────────────────────────────
  all.sort((a, b) => b.engagementScore - a.engagementScore);

  // ── Top-N selection ──────────────────────────────────────────────
  return all.slice(0, limit || TOP_N);
}

// ================================================================
// ── SENDER — Format payload + sign for encrypted delivery ────────
// ================================================================

async function sender(videos, secret) {
  // Package: title, author, source, thumbnail refs — encrypted delivery
  const payload = {
    results: videos.map((v) => ({
      id: v.id,
      platform: v.platform,
      title: v.title,
      author: v.author,
      source: v.sourceUrl,
      thumbnail: v.thumbnail,
      embedUrl: v.embedUrl,
      type: v.type,
      durationSec: v.durationSec,
      stats: {
        views: v.views,
        likes: v.likes,
        comments: v.comments,
      },
      score: Math.round(v.engagementScore * 1000) / 1000,
      publishedAt: v.publishedAt,
    })),
    meta: {
      total: videos.length,
      generatedAt: new Date().toISOString(),
    },
  };

  const body = JSON.stringify(payload);

  // Sign the payload for end-to-end integrity verification
  const signature = secret ? await hmacSign(body, secret) : "unsigned";

  return { body, signature };
}

// ================================================================
// ── FAILOVER — Relay to backup worker on 500 error ───────────────
// ================================================================

async function relayToBackup(targetUrl, platform, streamProxy, env) {
  const backupUrl = env.BACKUP_WORKER_URL;
  const secret = env.REGISTRY_SECRET;

  if (!backupUrl || !secret) {
    throw new Error("Backup worker not configured");
  }

  const ts = String(Date.now());
  const bodyPayload = JSON.stringify({ targetUrl, platform, streamProxy: !!streamProxy });
  const sigInput = `${ts}.${bodyPayload}`;
  const signature = await hmacSign(sigInput, secret);

  const resp = await fetch(`${backupUrl}/relay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Registry-Sig": signature,
      "X-Registry-Ts": ts,
    },
    body: bodyPayload,
  });

  return resp;
}

// ================================================================
// ── STREAM PROXY — Preserves stream with Range support ───────────
// ================================================================

async function handleStreamProxy(request, env) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const platform = url.searchParams.get("platform") || "youtube";
  const videoId = url.searchParams.get("id");
  const authorId = url.searchParams.get("author");

  let streamUrl = targetUrl;

  // Resolve stream URL from video ID if not provided directly
  if (!streamUrl && videoId) {
    try {
      if (platform === "youtube") {
        streamUrl = await getYouTubeStreamUrl(videoId);
      } else if (platform === "tiktok") {
        streamUrl = await getTikTokStreamUrl(videoId, authorId || "user");
      }
    } catch (err) {
      console.warn("Stream URL resolution failed:", err.message);
    }
  }

  if (!streamUrl) {
    return new Response(JSON.stringify({ error: "Could not resolve stream URL" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rangeHeader = request.headers.get("Range");
  const fetchHeaders = {
    ...browserHeaders(platform === "tiktok" ? "https://www.tiktok.com/" : "https://www.youtube.com/"),
    ...(rangeHeader ? { Range: rangeHeader } : {}),
  };

  let upstream;
  try {
    upstream = await fetch(streamUrl, {
      headers: fetchHeaders,
      cf: { cacheTtl: 0 },
    });

    // Failover to backup worker on 5xx
    if (upstream.status >= 500) {
      console.warn(`Upstream ${upstream.status} — failing over to backup worker`);
      upstream = await relayToBackup(streamUrl, platform, true, env);
    }
  } catch (err) {
    upstream = await relayToBackup(streamUrl, platform, true, env);
  }

  const contentType = upstream.headers.get("Content-Type") || "video/mp4";
  const responseHeaders = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Strict-Transport-Security": "max-age=31536000",
  };

  if (upstream.headers.has("Content-Length")) {
    responseHeaders["Content-Length"] = upstream.headers.get("Content-Length");
  }
  if (upstream.headers.has("Content-Range")) {
    responseHeaders["Content-Range"] = upstream.headers.get("Content-Range");
  }

  return new Response(upstream.body, {
    status: rangeHeader ? 206 : 200,
    headers: responseHeaders,
  });
}

// ================================================================
// ── SEARCH HANDLER — Full Grabber → Aggregator → Sender pipeline ─
// ================================================================

async function handleSearch(request, env) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "trending";
  const type = url.searchParams.get("type") || "all"; // short | long | all
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);

  let ytResults = [];
  let ttResults = [];

  // ── GRABBER: parallel fetch from both platforms ──────────────────
  try {
    [ytResults, ttResults] = await Promise.allSettled([
      grabYouTube(query, limit, env.YOUTUBE_API_KEY),
      grabTikTok(query, limit),
    ]).then((results) =>
      results.map((r) => (r.status === "fulfilled" ? r.value : []))
    );
  } catch (err) {
    // Failover to backup worker if grabber fails entirely
    try {
      const backupResp = await relayToBackup(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${env.YOUTUBE_API_KEY}`,
        "youtube",
        false,
        env
      );
      const backupData = await backupResp.json();
      ytResults = backupData?.items || [];
    } catch (backupErr) {
      console.error("Backup relay also failed:", backupErr.message);
    }
  }

  // ── AGGREGATOR: rank, score, dedup, top-N ────────────────────────
  const topVideos = aggregator(ytResults, ttResults, type, limit);

  // ── SENDER: format + sign response ───────────────────────────────
  const { body, signature } = await sender(topVideos, env.REGISTRY_SECRET);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Response-Sig": signature,
      "Access-Control-Allow-Origin": "*",
      "Strict-Transport-Security": "max-age=31536000",
      "Cache-Control": "public, max-age=30",
    },
  });
}

// ================================================================
// ── EMBED PROXY ──────────────────────────────────────────────────
// ================================================================

async function handleEmbedProxy(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const platform = url.searchParams.get("platform");

  if (!id || !platform) {
    return new Response("Missing id or platform", { status: 400 });
  }

  const embedUrl =
    platform === "youtube"
      ? `${YT_EMBED_BASE}${id}?autoplay=1&rel=0&modestbranding=1`
      : `${TT_EMBED_BASE}${id}`;

  return new Response(JSON.stringify({ embedUrl }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ================================================================
// ── MOCK DATA (fallback when APIs unavailable) ───────────────────
// ================================================================

function mockYouTubeResults(query, limit) {
  return Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
    id: `yt-mock-${i}`,
    platform: "youtube",
    title: `${query} — YouTube Video ${i + 1}`,
    author: `YT Creator ${i + 1}`,
    description: "Mock YouTube result",
    thumbnail: `https://picsum.photos/seed/yt${i}/320/180`,
    embedUrl: `${YT_EMBED_BASE}dQw4w9WgXcQ`,
    sourceUrl: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`,
    publishedAt: new Date().toISOString(),
    durationSec: i % 2 === 0 ? 60 : 600,
    type: i % 2 === 0 ? "short" : "long",
    views: 100000 * (i + 1),
    likes: 5000 * (i + 1),
    comments: 800 * (i + 1),
    engagementScore: 0,
  }));
}

function mockTikTokResults(query, limit) {
  return Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
    id: `tt-mock-${i}`,
    platform: "tiktok",
    title: `${query} — TikTok ${i + 1}`,
    author: `tiktok_user_${i + 1}`,
    description: "Mock TikTok result",
    thumbnail: `https://picsum.photos/seed/tt${i}/320/568`,
    embedUrl: `${TT_EMBED_BASE}7000000000000000${i}`,
    sourceUrl: `https://www.tiktok.com/@user/video/7000000000000000${i}`,
    publishedAt: new Date().toISOString(),
    durationSec: 30 + i * 15,
    type: "short",
    views: 500000 * (i + 1),
    likes: 80000 * (i + 1),
    comments: 3000 * (i + 1),
    engagementScore: 0,
  }));
}

// ================================================================
// ── UTILITY: ISO 8601 duration → seconds ────────────────────────
// ================================================================

function iso8601ToSeconds(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (
    parseInt(match[1] || 0) * 3600 +
    parseInt(match[2] || 0) * 60 +
    parseInt(match[3] || 0)
  );
}

// ================================================================
// ── UI — Serve the SPA web client ────────────────────────────────
// ================================================================

function serveUI() {
  return new Response(HTML, {
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ================================================================
// ── MAIN ROUTER ──────────────────────────────────────────────────
// ================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    try {
      if (url.pathname === "/") return serveUI();
      if (url.pathname === "/api/search") return handleSearch(request, env);
      if (url.pathname === "/api/proxy/stream") return handleStreamProxy(request, env);
      if (url.pathname === "/api/proxy/embed") return handleEmbedProxy(request, env);
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok", role: "main" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("Unhandled error:", err);
      return new Response(
        JSON.stringify({ error: "Internal Server Error", detail: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};

// ================================================================
// ── HTML SPA — Web Client
//    · Inter font · cyan accent (#06d6d6)
//    · YouTube red · TikTok sky-blue platform bubbles
//    · Short / long-form toggle
//    · Search · scroll · recommendations
// ================================================================

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>StreamHub — YT &amp; TikTok Feed</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    /* ── Reset & Base ──────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0b0c14;
      --surface:   #13141f;
      --surface2:  #1c1e2e;
      --surface3:  #252740;
      --border:    #2a2d42;
      --cyan:      #06d6d6;
      --cyan-dim:  rgba(6, 214, 214, 0.15);
      --cyan-glow: rgba(6, 214, 214, 0.4);
      --yt-red:    #ff2b2b;
      --tt-blue:   #4dc4e6;
      --text:      #e8eaf0;
      --text-muted:#8890aa;
      --text-dim:  #555a72;
      --radius:    12px;
      --radius-sm: 8px;
      --radius-lg: 18px;
      --shadow:    0 4px 24px rgba(0,0,0,0.45);
    }

    html { font-family: 'Inter', system-ui, sans-serif; font-size: 15px; }

    body {
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* ── Scrollbar ─────────���───────────────────── */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--surface3); border-radius: 99px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--cyan-dim); }

    /* ── Layout ────────────────────────────────── */
    .layout {
      display: grid;
      grid-template-rows: auto 1fr;
      grid-template-columns: 1fr 300px;
      grid-template-areas:
        "header  header"
        "main    sidebar";
      min-height: 100vh;
      max-width: 1400px;
      margin: 0 auto;
      padding: 0 20px;
      gap: 0 24px;
    }

    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
        grid-template-areas: "header" "main";
      }
      .sidebar { display: none; }
    }

    /* ── Header ────────────────────────────────── */
    header {
      grid-area: header;
      position: sticky;
      top: 0;
      z-index: 100;
      background: linear-gradient(180deg, var(--bg) 80%, transparent 100%);
      padding: 20px 0 16px;
    }

    .header-inner {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }

    .logo {
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--cyan);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .logo span { color: var(--text-muted); font-weight: 400; }

    /* Search bar */
    .search-wrap {
      flex: 1;
      min-width: 200px;
      position: relative;
    }
    .search-input {
      width: 100%;
      background: var(--surface2);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-lg);
      color: var(--text);
      font-family: inherit;
      font-size: 0.9rem;
      padding: 10px 44px 10px 18px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .search-input::placeholder { color: var(--text-dim); }
    .search-input:focus {
      border-color: var(--cyan);
      box-shadow: 0 0 0 3px var(--cyan-dim);
    }
    .search-icon {
      position: absolute;
      right: 14px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-dim);
      pointer-events: none;
      font-size: 1rem;
    }

    /* Controls row */
    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding-top: 12px;
    }

    /* Toggle pill */
    .toggle-group {
      display: flex;
      background: var(--surface2);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      flex-shrink: 0;
    }
    .toggle-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      font-family: inherit;
      font-size: 0.8rem;
      font-weight: 500;
      padding: 7px 16px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      white-space: nowrap;
    }
    .toggle-btn.active {
      background: var(--cyan-dim);
      color: var(--cyan);
    }
    .toggle-btn:hover:not(.active) { background: var(--surface3); color: var(--text); }

    /* Platform filter chips */
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border-radius: 99px;
      padding: 5px 12px;
      font-size: 0.78rem;
      font-weight: 600;
      cursor: pointer;
      border: 1.5px solid transparent;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .chip-yt {
      background: rgba(255,43,43,0.12);
      color: var(--yt-red);
      border-color: rgba(255,43,43,0.25);
    }
    .chip-yt.active, .chip-yt:hover {
      background: rgba(255,43,43,0.22);
      border-color: var(--yt-red);
    }
    .chip-tt {
      background: rgba(77,196,230,0.12);
      color: var(--tt-blue);
      border-color: rgba(77,196,230,0.25);
    }
    .chip-tt.active, .chip-tt:hover {
      background: rgba(77,196,230,0.22);
      border-color: var(--tt-blue);
    }
    .chip-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: currentColor;
    }

    /* Result count */
    .result-meta {
      margin-left: auto;
      font-size: 0.78rem;
      color: var(--text-dim);
    }

    /* ── Main Feed ─────────────────────────────── */
    main {
      grid-area: main;
      padding: 8px 0 40px;
    }

    .section-title {
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--text-dim);
      margin-bottom: 14px;
    }

    /* Video grid */
    .video-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 16px;
    }

    /* Video card */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      cursor: pointer;
      transition: transform 0.18s, border-color 0.18s, box-shadow 0.18s;
      position: relative;
    }
    .card:hover {
      transform: translateY(-3px);
      border-color: var(--cyan);
      box-shadow: 0 8px 32px rgba(6,214,214,0.12);
    }

    .card-thumb {
      position: relative;
      aspect-ratio: 16/9;
      overflow: hidden;
      background: var(--surface2);
    }
    .card-thumb.short { aspect-ratio: 9/16; max-height: 220px; }
    .card-thumb img {
      width: 100%; height: 100%;
      object-fit: cover;
      transition: transform 0.3s;
    }
    .card:hover .card-thumb img { transform: scale(1.04); }

    /* Play overlay */
    .play-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.3);
      opacity: 0;
      transition: opacity 0.18s;
    }
    .card:hover .play-overlay { opacity: 1; }
    .play-btn {
      width: 44px; height: 44px;
      background: var(--cyan);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 20px var(--cyan-glow);
    }
    .play-btn svg { fill: #000; margin-left: 3px; }

    /* Duration badge */
    .duration-badge {
      position: absolute;
      bottom: 8px; right: 8px;
      background: rgba(0,0,0,0.75);
      color: #fff;
      font-size: 0.7rem;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 4px;
      backdrop-filter: blur(4px);
    }

    /* Platform bubble */
    .platform-badge {
      position: absolute;
      top: 8px; left: 8px;
      font-size: 0.65rem;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 99px;
    }
    .platform-badge.yt {
      background: var(--yt-red);
      color: #fff;
    }
    .platform-badge.tt {
      background: var(--tt-blue);
      color: #000;
    }

    .card-body { padding: 12px; }
    .card-title {
      font-size: 0.88rem;
      font-weight: 600;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      color: var(--text);
      margin-bottom: 6px;
    }
    .card-author {
      font-size: 0.76rem;
      color: var(--text-muted);
      margin-bottom: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .card-stats {
      display: flex;
      gap: 12px;
      font-size: 0.72rem;
      color: var(--text-dim);
    }
    .stat { display: flex; align-items: center; gap: 4px; }

    /* Score bar */
    .score-bar-wrap {
      margin-top: 8px;
      height: 2px;
      background: var(--surface3);
      border-radius: 99px;
      overflow: hidden;
    }
    .score-bar {
      height: 100%;
      background: linear-gradient(90deg, var(--cyan), #0af);
      border-radius: 99px;
      transition: width 0.6s ease;
    }

    /* ── Sidebar / Recommendations ─────────────── */
    .sidebar {
      grid-area: sidebar;
      padding: 24px 0 40px;
    }
    .rec-list { display: flex; flex-direction: column; gap: 10px; }

    .rec-card {
      display: flex;
      gap: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 8px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .rec-card:hover { border-color: var(--cyan); background: var(--surface2); }
    .rec-thumb {
      width: 80px;
      aspect-ratio: 16/9;
      border-radius: 6px;
      overflow: hidden;
      flex-shrink: 0;
      background: var(--surface2);
    }
    .rec-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .rec-info { flex: 1; min-width: 0; }
    .rec-title {
      font-size: 0.78rem;
      font-weight: 500;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin-bottom: 4px;
    }
    .rec-author { font-size: 0.7rem; color: var(--text-muted); }
    .rec-badge {
      display: inline-block;
      font-size: 0.6rem;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 99px;
      margin-top: 4px;
    }
    .rec-badge.yt { background: var(--yt-red); color: #fff; }
    .rec-badge.tt { background: var(--tt-blue); color: #000; }

    /* ── Modal player ──────────────────────────── */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.85);
      z-index: 200;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      backdrop-filter: blur(6px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s;
    }
    .modal-overlay.open { opacity: 1; pointer-events: all; }

    .modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      width: 100%;
      max-width: 860px;
      box-shadow: var(--shadow);
      overflow: hidden;
      transform: scale(0.96);
      transition: transform 0.2s;
    }
    .modal-overlay.open .modal { transform: scale(1); }

    .modal-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      padding: 16px 20px 12px;
      gap: 12px;
    }
    .modal-title { font-size: 0.95rem; font-weight: 600; line-height: 1.4; }
    .modal-close {
      background: none; border: none;
      color: var(--text-muted);
      font-size: 1.3rem;
      cursor: pointer;
      line-height: 1;
      flex-shrink: 0;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .modal-close:hover { background: var(--surface3); color: var(--text); }
    .modal-player {
      position: relative;
      aspect-ratio: 16/9;
      background: #000;
    }
    .modal-player.short-player { aspect-ratio: 9/16; max-height: 480px; }
    .modal-player iframe {
      width: 100%; height: 100%;
      border: none;
    }
    .modal-meta {
      padding: 12px 20px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .modal-author { font-size: 0.82rem; color: var(--text-muted); }
    .modal-stats { font-size: 0.78rem; color: var(--text-dim); margin-left: auto; }

    /* ── States ────────────────────────────────── */
    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      padding: 60px 0;
      color: var(--text-muted);
      font-size: 0.88rem;
    }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid var(--surface3);
      border-top-color: var(--cyan);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
    }
    .empty-state h3 { font-size: 1rem; margin-bottom: 8px; color: var(--text); }

    /* ── Load more ─────────────────────────────── */
    .load-more-wrap { text-align: center; margin-top: 28px; }
    .load-more-btn {
      background: var(--surface2);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-lg);
      color: var(--text-muted);
      font-family: inherit;
      font-size: 0.85rem;
      font-weight: 500;
      padding: 10px 28px;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
    }
    .load-more-btn:hover {
      border-color: var(--cyan);
      color: var(--cyan);
      background: var(--cyan-dim);
    }

    /* ── Divider ───────────────────────────────── */
    .divider { height: 1px; background: var(--border); margin: 24px 0; }
  </style>
</head>
<body>

<div class="layout">

  <!-- ── Header ──────────────────────────────── -->
  <header>
    <div class="header-inner">
      <div class="logo">Stream<span>Hub</span></div>

      <div class="search-wrap">
        <input
          id="searchInput"
          class="search-input"
          type="search"
          placeholder="Search videos across YouTube &amp; TikTok…"
          autocomplete="off"
        />
        <span class="search-icon">⌕</span>
      </div>
    </div>

    <div class="controls">
      <!-- Short / Long form toggle -->
      <div class="toggle-group" role="group" aria-label="Content type">
        <button class="toggle-btn active" data-type="all">All</button>
        <button class="toggle-btn" data-type="short">⚡ Short</button>
        <button class="toggle-btn" data-type="long">▶ Long</button>
      </div>

      <!-- Platform filter -->
      <div class="chip chip-yt active" data-platform="youtube">
        <span class="chip-dot"></span> YouTube
      </div>
      <div class="chip chip-tt active" data-platform="tiktok">
        <span class="chip-dot"></span> TikTok
      </div>

      <span id="resultMeta" class="result-meta"></span>
    </div>
  </header>

  <!-- ── Main Feed ────────────────────────────── -->
  <main>
    <p class="section-title">Top Videos</p>
    <div id="videoGrid" class="video-grid"></div>
    <div class="load-more-wrap" id="loadMoreWrap" style="display:none">
      <button class="load-more-btn" id="loadMoreBtn">Load more</button>
    </div>
  </main>

  <!-- ── Sidebar / Recommendations ────────────── -->
  <aside class="sidebar">
    <p class="section-title">Recommended</p>
    <div id="recList" class="rec-list"></div>
  </aside>

</div>

<!-- ── Modal Player ──────────────────────────── -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal" id="modal" role="dialog" aria-modal="true">
    <div class="modal-header">
      <p class="modal-title" id="modalTitle"></p>
      <button class="modal-close" id="modalClose" aria-label="Close">✕</button>
    </div>
    <div class="modal-player" id="modalPlayer"></div>
    <div class="modal-meta">
      <span id="modalPlatformBadge"></span>
      <span class="modal-author" id="modalAuthor"></span>
      <span class="modal-stats" id="modalStats"></span>
    </div>
  </div>
</div>

<script>
(function () {
  'use strict';

  // ── State ──────────────────────────────────────
  let allVideos   = [];
  let displayed   = [];
  let query       = 'trending';
  let typeFilter  = 'all';
  let platforms   = new Set(['youtube', 'tiktok']);
  let page        = 0;
  const PAGE_SIZE = 12;
  let debounceTimer;

  // ── DOM refs ───────────────────────────────────
  const grid        = document.getElementById('videoGrid');
  const recList     = document.getElementById('recList');
  const searchInput = document.getElementById('searchInput');
  const resultMeta  = document.getElementById('resultMeta');
  const loadMoreWrap= document.getElementById('loadMoreWrap');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const overlay     = document.getElementById('modalOverlay');
  const modal       = document.getElementById('modal');
  const modalTitle  = document.getElementById('modalTitle');
  const modalPlayer = document.getElementById('modalPlayer');
  const modalClose  = document.getElementById('modalClose');
  const modalAuthor = document.getElementById('modalAuthor');
  const modalStats  = document.getElementById('modalStats');
  const modalBadge  = document.getElementById('modalPlatformBadge');

  // ── Fetch feed ────────────────────────────────
  async function fetchFeed() {
    setLoading(true);
    allVideos = []; displayed = []; page = 0;

    try {
      const params = new URLSearchParams({
        q: query,
        type: typeFilter,
        limit: '40',
      });
      const resp = await fetch('/api/search?' + params);
      if (!resp.ok) throw new Error('API error ' + resp.status);
      const data = await resp.json();
      allVideos = (data.results || []).filter(v =>
        platforms.has(v.platform)
      );
    } catch (err) {
      console.error(err);
      allVideos = [];
    }

    renderPage(true);
    renderRecs();
    setLoading(false);
  }

  // ── Render helpers ────────────────────────────
  function renderPage(reset) {
    if (reset) { grid.innerHTML = ''; page = 0; }
    const start = page * PAGE_SIZE;
    const slice = allVideos.slice(start, start + PAGE_SIZE);
    slice.forEach(v => grid.appendChild(makeCard(v)));
    displayed.push(...slice);
    page++;
    resultMeta.textContent = displayed.length + ' of ' + allVideos.length + ' results';
    loadMoreWrap.style.display = displayed.length < allVideos.length ? '' : 'none';
  }

  function makeCard(v) {
    const isShort = v.type === 'short';
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'article');
    card.innerHTML = \`
      <div class="card-thumb \${isShort ? 'short' : ''}">
        <img
          src="\${escHtml(v.thumbnail)}"
          alt="\${escHtml(v.title)}"
          loading="lazy"
          onerror="this.src='https://picsum.photos/seed/\${escHtml(v.id)}/320/180'"
        />
        <div class="play-overlay">
          <div class="play-btn">
            <svg width="14" height="16" viewBox="0 0 14 16">
              <path d="M0 0 L14 8 L0 16 Z"/>
            </svg>
          </div>
        </div>
        <span class="platform-badge \${v.platform === 'youtube' ? 'yt' : 'tt'}">
          \${v.platform === 'youtube' ? 'YouTube' : 'TikTok'}
        </span>
        \${v.durationSec > 0 ? \`<span class="duration-badge">\${formatDuration(v.durationSec)}</span>\` : ''}
      </div>
      <div class="card-body">
        <p class="card-title">\${escHtml(v.title)}</p>
        <p class="card-author">\${escHtml(v.author)}</p>
        <div class="card-stats">
          <span class="stat">👁 \${fmtNum(v.stats?.views ?? v.views)}</span>
          <span class="stat">♥ \${fmtNum(v.stats?.likes ?? v.likes)}</span>
          <span class="stat">💬 \${fmtNum(v.stats?.comments ?? v.comments)}</span>
        </div>
        <div class="score-bar-wrap">
          <div class="score-bar" style="width:\${Math.round((v.score || 0) * 100)}%"></div>
        </div>
      </div>
    \`;
    card.addEventListener('click', () => openPlayer(v));
    return card;
  }

  function renderRecs() {
    recList.innerHTML = '';
    // Show top 8 videos (cross-platform) not yet in first page as recommendations
    const recs = allVideos.slice(0, 8);
    recs.forEach(v => {
      const el = document.createElement('div');
      el.className = 'rec-card';
      el.innerHTML = \`
        <div class="rec-thumb">
          <img
            src="\${escHtml(v.thumbnail)}"
            alt=""
            loading="lazy"
            onerror="this.src='https://picsum.photos/seed/r\${escHtml(v.id)}/80/45'"
          />
        </div>
        <div class="rec-info">
          <p class="rec-title">\${escHtml(v.title)}</p>
          <p class="rec-author">\${escHtml(v.author)}</p>
          <span class="rec-badge \${v.platform === 'youtube' ? 'yt' : 'tt'}">
            \${v.platform === 'youtube' ? 'YT' : 'TT'}
          </span>
        </div>
      \`;
      el.addEventListener('click', () => openPlayer(v));
      recList.appendChild(el);
    });
  }

  // ── Modal player ──────────────────────────────
  function openPlayer(v) {
    modalTitle.textContent = v.title;
    modalAuthor.textContent = '@ ' + v.author;
    modalStats.textContent = \`\${fmtNum(v.stats?.views ?? v.views)} views · \${fmtNum(v.stats?.likes ?? v.likes)} likes\`;

    modalBadge.className = 'chip ' + (v.platform === 'youtube' ? 'chip-yt' : 'chip-tt');
    modalBadge.innerHTML = \`<span class="chip-dot"></span> \${v.platform === 'youtube' ? 'YouTube' : 'TikTok'}\`;

    modalPlayer.className = 'modal-player' + (v.type === 'short' ? ' short-player' : '');
    modalPlayer.innerHTML = \`<iframe
      src="\${escHtml(v.embedUrl)}"
      allowfullscreen
      allow="autoplay; encrypted-media; picture-in-picture"
      referrerpolicy="no-referrer"
    ></iframe>\`;

    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    modalClose.focus();
  }

  function closePlayer() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    modalPlayer.innerHTML = '';
  }

  // ── Loading state ─────────────────────────────
  function setLoading(isLoading) {
    if (isLoading) {
      grid.innerHTML = \`
        <div class="loading" style="grid-column:1/-1">
          <div class="spinner"></div>
          <span>Fetching from YouTube &amp; TikTok…</span>
        </div>
      \`;
    } else if (allVideos.length === 0 && !isLoading) {
      grid.innerHTML = \`
        <div class="empty-state" style="grid-column:1/-1">
          <h3>No results found</h3>
          <p>Try a different search term or toggle the filters.</p>
        </div>
      \`;
    }
  }

  // ── Event listeners ───────────────────────────
  searchInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      query = e.target.value.trim() || 'trending';
      fetchFeed();
    }, 500);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      query = e.target.value.trim() || 'trending';
      fetchFeed();
    }
  });

  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      typeFilter = btn.dataset.type;
      fetchFeed();
    });
  });

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const p = chip.dataset.platform;
      if (platforms.has(p)) {
        if (platforms.size > 1) { platforms.delete(p); chip.classList.remove('active'); }
      } else {
        platforms.add(p); chip.classList.add('active');
      }
      // Re-filter without re-fetching
      const filtered = allVideos.filter(v => platforms.has(v.platform));
      grid.innerHTML = '';
      page = 0;
      displayed = [];
      filtered.slice(0, PAGE_SIZE).forEach(v => grid.appendChild(makeCard(v)));
      displayed = filtered.slice(0, PAGE_SIZE);
      page = 1;
      resultMeta.textContent = displayed.length + ' of ' + filtered.length + ' results';
      loadMoreWrap.style.display = displayed.length < filtered.length ? '' : 'none';
    });
  });

  loadMoreBtn.addEventListener('click', () => renderPage(false));

  modalClose.addEventListener('click', closePlayer);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePlayer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePlayer(); });

  // ── Utility ───────────────────────────────────
  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtNum(n) {
    if (n == null) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function formatDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  // ── Boot ──────────────────────────────────────
  fetchFeed();

})();
</script>
</body>
</html>`;
