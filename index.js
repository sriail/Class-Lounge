const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.youtube.com",
  Referer: "https://www.youtube.com/",
};

/* ───────────────────────────── Router ───────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const inv = env.INVIDIOUS_HOST ?? "https://inv.nadeko.net";

    try {
      switch (url.pathname) {
        case "/":
          return htmlResponse(searchPage("", []));

        case "/search": {
          const q = url.searchParams.get("q") ?? "";
          if (!q) return htmlResponse(searchPage("", []));
          const results = await invidiousSearch(inv, q);
          return htmlResponse(searchPage(q, results));
        }

        case "/watch": {
          const v = url.searchParams.get("v");
          if (!v) return redirect("/");
          const info = await invidiousVideoInfo(inv, v);
          return htmlResponse(watchPage(info));
        }

        case "/proxy":
          return proxyStream(request, url);

        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (err) {
      return htmlResponse(errorPage(err.message), 500);
    }
  },
};

/* ─────────────────────────── Invidious API ──────────────────────── */

async function invidiousSearch(inv, query) {
  const res = await fetch(
    `${inv}/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=` +
      `videoId,title,author,lengthSeconds,viewCount,publishedText,` +
      `videoThumbnails`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json();
}

async function invidiousVideoInfo(inv, videoId) {
  const res = await fetch(`${inv}/api/v1/videos/${videoId}`, {
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(`Video info failed: ${res.status}`);
  const data = await res.json();

  // Pick the best adaptive/legacy stream ≤ 1080p
  const fmt = pickStream(data.formatStreams ?? [], data.adaptiveFormats ?? []);
  return { ...data, chosenStream: fmt };
}

function pickStream(legacy, adaptive) {
  // Prefer a legacy (muxed audio+video) stream: 1080p → 720p → 480p → 360p
  const order = ["1080p", "720p", "480p", "360p", "240p", "144p"];
  for (const q of order) {
    const hit = legacy.find((f) => f.qualityLabel === q);
    if (hit) return hit;
  }
  // Fallback: highest-bitrate adaptive video stream
  return (
    adaptive
      .filter((f) => f.type?.startsWith("video/mp4"))
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? legacy[0]
  );
}

/* ───────────────────────── Stream Proxy ────────────────────────── */

async function proxyStream(request, url) {
  const target = url.searchParams.get("url");
  if (!target) return new Response("Missing url param", { status: 400 });

  // Only allow proxying googlevideo / YouTube CDN hosts
  const targetUrl = new URL(target);
  if (
    !targetUrl.hostname.endsWith("googlevideo.com") &&
    !targetUrl.hostname.endsWith("youtube.com") &&
    !targetUrl.hostname.endsWith("ytimg.com")
  ) {
    return new Response("Forbidden upstream host", { status: 403 });
  }

  const upstream = await fetch(target, {
    headers: {
      ...HEADERS,
      Range: request.headers.get("Range") ?? "bytes=0-",
    },
  });

  const respHeaders = new Headers();
  for (const key of [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
  ]) {
    const val = upstream.headers.get(key);
    if (val) respHeaders.set(key, val);
  }
  respHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

/* ─────────────────────────── HTML Pages ────────────────────────── */

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${esc(title)} – YT Worker</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f0f0f;color:#e3e3e3;font-family:Roboto,Arial,sans-serif;min-height:100vh}
    a{color:#3ea6ff;text-decoration:none}
    a:hover{text-decoration:underline}

    /* ── Header ── */
    header{display:flex;align-items:center;gap:16px;padding:10px 24px;
      background:#212121;border-bottom:1px solid #333;position:sticky;top:0;z-index:10}
    header .logo{font-size:1.3rem;font-weight:700;color:#ff4e45;white-space:nowrap}
    header form{display:flex;flex:1;max-width:640px}
    header input{flex:1;padding:8px 14px;border:1px solid #555;border-right:none;
      border-radius:20px 0 0 20px;background:#121212;color:#e3e3e3;font-size:.95rem;outline:none}
    header input:focus{border-color:#3ea6ff}
    header button{padding:8px 18px;background:#333;border:1px solid #555;border-left:none;
      border-radius:0 20px 20px 0;color:#e3e3e3;cursor:pointer;font-size:.95rem}
    header button:hover{background:#444}

    /* ── Search results ── */
    .results{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
      gap:20px;padding:28px 24px}
    .card{background:#1a1a1a;border-radius:10px;overflow:hidden;transition:transform .15s}
    .card:hover{transform:translateY(-3px)}
    .card img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
    .card-body{padding:10px 12px}
    .card-title{font-size:.92rem;font-weight:500;line-height:1.4;display:-webkit-box;
      -webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .card-meta{font-size:.78rem;color:#aaa;margin-top:6px}

    /* ── Watch page ── */
    .watch{max-width:900px;margin:32px auto;padding:0 20px}
    video{width:100%;border-radius:10px;background:#000;max-height:520px}
    .video-title{font-size:1.2rem;font-weight:600;margin-top:16px}
    .video-meta{font-size:.85rem;color:#aaa;margin-top:8px;display:flex;gap:20px;flex-wrap:wrap}
    .video-desc{margin-top:16px;font-size:.88rem;line-height:1.6;color:#ccc;
      white-space:pre-wrap;max-height:200px;overflow:auto}

    /* ── Misc ── */
    .hero{text-align:center;padding:80px 24px}
    .hero h1{font-size:2.2rem;font-weight:700;color:#ff4e45}
    .hero p{color:#aaa;margin-top:12px}
    .error{padding:40px;text-align:center;color:#ff6b6b}
  </style>
</head>
<body>
  <header>
    <div class="logo">▶ YT Worker</div>
    <form action="/search" method="get">
      <input name="q" placeholder="Search YouTube…" autofocus/>
      <button type="submit">🔍</button>
    </form>
  </header>
  ${body}
</body>
</html>`;
}

/* Search page -------------------------------------------------- */
function searchPage(query, results) {
  if (!query) {
    return layout(
      "Home",
      `<div class="hero">
        <h1>YT Worker</h1>
        <p>Search and stream YouTube videos — fully proxied.</p>
      </div>`
    );
  }

  if (!results.length) {
    return layout(query, `<p class="error">No results for "${esc(query)}".</p>`);
  }

  const cards = results
    .map((v) => {
      const thumb =
        v.videoThumbnails?.find((t) => t.quality === "medium")?.url ??
        v.videoThumbnails?.[0]?.url ??
        "";
      const dur = formatDuration(v.lengthSeconds ?? 0);
      const views = formatViews(v.viewCount ?? 0);
      return `
      <a class="card" href="/watch?v=${esc(v.videoId)}">
        <img src="${esc(thumb)}" alt="" loading="lazy"/>
        <div class="card-body">
          <div class="card-title">${esc(v.title)}</div>
          <div class="card-meta">
            ${esc(v.author)} &nbsp;·&nbsp; ${views} views &nbsp;·&nbsp; ${dur}
            <br/>${esc(v.publishedText ?? "")}
          </div>
        </div>
      </a>`;
    })
    .join("");

  return layout(query, `<div class="results">${cards}</div>`);
}

/* Watch page --------------------------------------------------- */
function watchPage(info) {
  const stream = info.chosenStream;
  const streamUrl = stream?.url
    ? `/proxy?url=${encodeURIComponent(stream.url)}`
    : null;

  const player = streamUrl
    ? `<video controls autoplay preload="metadata" src="${esc(streamUrl)}">
        Your browser does not support HTML5 video.
       </video>`
    : `<p class="error">No streamable format found for this video.</p>`;

  const views = formatViews(info.viewCount ?? 0);
  const likes = formatViews(info.likeCount ?? 0);
  const desc = esc(info.description ?? "").slice(0, 1200);

  return layout(
    info.title ?? "Watch",
    `<div class="watch">
      ${player}
      <div class="video-title">${esc(info.title ?? "")}</div>
      <div class="video-meta">
        <span>👤 ${esc(info.author ?? "")}</span>
        <span>👁 ${views} views</span>
        <span>👍 ${likes}</span>
        <span>📅 ${esc(info.publishedText ?? "")}</span>
        ${stream ? `<span>📺 ${esc(stream.qualityLabel ?? "")}</span>` : ""}
      </div>
      <div class="video-desc">${desc}</div>
    </div>`
  );
}

/* Error page --------------------------------------------------- */
function errorPage(msg) {
  return layout("Error", `<p class="error">⚠ ${esc(msg)}</p>`);
}

/* ────────────────────────── Helpers ────────────────────────────── */

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function formatViews(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}
