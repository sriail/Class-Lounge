// ============================================================
//  Cloudflare Worker — YouTube Stream Proxy
//  Routes:
//    GET /              → serve player UI
//    GET /info?v=ID     → return JSON of available streams
//    GET /stream?url=…  → proxy a raw video/audio stream
//    GET /proxy?url=…   → proxy thumbnails / images
// ============================================================

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

const YT_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

// ── Entry point ──────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case '/':
          return htmlResponse(CLIENT_HTML);
        case '/info':
          return handleInfo(url);
        case '/stream':
          return handleStream(request, url);
        case '/proxy':
          return handleProxy(request, url);
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

// ── /info?v=VIDEO_ID ─────────────────────────────────────────
async function handleInfo(url) {
  const videoId = url.searchParams.get('v');
  if (!videoId) return jsonResponse({ error: 'Missing ?v= parameter' }, 400);

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en`;
  const res = await fetch(ytUrl, { headers: YT_HEADERS });

  if (!res.ok)
    return jsonResponse({ error: `YouTube returned ${res.status}` }, 502);

  const html = await res.text();

  // Extract ytInitialPlayerResponse embedded JSON
  const playerData = extractPlayerResponse(html);
  if (!playerData)
    return jsonResponse({ error: 'Could not parse player response' }, 502);

  const { videoDetails, streamingData } = playerData;

  if (!streamingData)
    return jsonResponse({ error: 'No streaming data (video may be age-gated, DRM, or private)' }, 403);

  const workerBase = url.origin;

  // Build proxied stream list
  const formats = [
    ...(streamingData.formats ?? []),
    ...(streamingData.adaptiveFormats ?? []),
  ]
    .filter((f) => f.url) // skip cipher-only streams
    .map((f) => ({
      itag: f.itag,
      mimeType: f.mimeType,
      quality: f.qualityLabel ?? f.audioQuality ?? 'unknown',
      bitrate: f.bitrate,
      width: f.width,
      height: f.height,
      fps: f.fps,
      contentLength: f.contentLength,
      // Proxy the URL through this worker so the browser never hits YouTube directly
      proxyUrl: `${workerBase}/stream?url=${encodeURIComponent(f.url)}`,
    }));

  return jsonResponse({
    videoId,
    title: videoDetails?.title,
    author: videoDetails?.author,
    lengthSeconds: videoDetails?.lengthSeconds,
    thumbnail: videoDetails?.thumbnail?.thumbnails?.at(-1)?.url,
    formats,
  });
}

// ── /stream?url=ENCODED_YOUTUBE_CDN_URL ──────────────────────
async function handleStream(request, url) {
  const target = url.searchParams.get('url');
  if (!target) return new Response('Missing ?url=', { status: 400 });

  let targetUrl;
  try {
    targetUrl = new URL(decodeURIComponent(target));
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  // Only allow YouTube / Google video CDN origins
  if (!isTrustedOrigin(targetUrl))
    return new Response('Forbidden origin', { status: 403 });

  // Forward Range header so seek works
  const upstreamHeaders = {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
  };
  const range = request.headers.get('Range');
  if (range) upstreamHeaders['Range'] = range;

  const upstream = await fetch(targetUrl.toString(), {
    headers: upstreamHeaders,
  });

  // Pass through the stream, rewriting only necessary headers
  const responseHeaders = new Headers();
  for (const key of [
    'Content-Type',
    'Content-Length',
    'Content-Range',
    'Accept-Ranges',
    'Last-Modified',
    'ETag',
  ]) {
    const val = upstream.headers.get(key);
    if (val) responseHeaders.set(key, val);
  }
  responseHeaders.set('Access-Control-Allow-Origin', '*');
  responseHeaders.set('Cache-Control', 'public, max-age=3600');

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

// ── /proxy?url=ENCODED_URL  (thumbnails, avatars, etc.) ──────
async function handleProxy(request, url) {
  const target = url.searchParams.get('url');
  if (!target) return new Response('Missing ?url=', { status: 400 });

  let targetUrl;
  try {
    targetUrl = new URL(decodeURIComponent(target));
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  if (!isTrustedOrigin(targetUrl))
    return new Response('Forbidden origin', { status: 403 });

  const upstream = await fetch(targetUrl.toString(), { headers: YT_HEADERS });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set('Access-Control-Allow-Origin', '*');

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

// ── Helpers ───────────────────────────────────────────────────
function extractPlayerResponse(html) {
  // YouTube embeds this as: var ytInitialPlayerResponse = {...};
  const match = html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function isTrustedOrigin(url) {
  const h = url.hostname;
  return (
    h.endsWith('.googlevideo.com') ||
    h.endsWith('.youtube.com') ||
    h.endsWith('.ytimg.com') ||
    h.endsWith('.ggpht.com')
  );
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ── Embedded client UI (served from /) ───────────────────────
const CLIENT_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>YT Stream Proxy</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: system-ui, sans-serif;
      background: #0f0f0f;
      color: #e8e8e8;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem 1rem;
      gap: 1.5rem;
    }

    h1 { font-size: 1.4rem; font-weight: 600; letter-spacing: -0.02em; }
    h1 span { color: #ff4545; }

    .search-bar {
      display: flex;
      gap: .5rem;
      width: 100%;
      max-width: 640px;
    }

    input {
      flex: 1;
      padding: .65rem 1rem;
      border-radius: 8px;
      border: 1px solid #333;
      background: #1a1a1a;
      color: #e8e8e8;
      font-size: 1rem;
      outline: none;
      transition: border-color .2s;
    }
    input:focus { border-color: #ff4545; }

    button {
      padding: .65rem 1.2rem;
      border-radius: 8px;
      border: none;
      background: #ff4545;
      color: #fff;
      font-size: .95rem;
      cursor: pointer;
      transition: background .2s;
    }
    button:hover { background: #e03030; }
    button:disabled { background: #555; cursor: not-allowed; }

    #player-wrap {
      width: 100%;
      max-width: 854px;
      display: none;
      flex-direction: column;
      gap: 1rem;
    }

    video {
      width: 100%;
      border-radius: 10px;
      background: #000;
      aspect-ratio: 16/9;
    }

    .meta { display: flex; gap: 1rem; align-items: flex-start; }
    .thumb { width: 120px; border-radius: 6px; flex-shrink: 0; }
    .meta-text h2 { font-size: 1rem; line-height: 1.4; }
    .meta-text p  { font-size: .82rem; color: #aaa; margin-top: .3rem; }

    .stream-grid {
      display: flex;
      flex-wrap: wrap;
      gap: .5rem;
    }

    .stream-btn {
      padding: .35rem .75rem;
      font-size: .8rem;
      border-radius: 6px;
      border: 1px solid #333;
      background: #1a1a1a;
      color: #ccc;
      cursor: pointer;
      transition: all .15s;
    }
    .stream-btn:hover, .stream-btn.active {
      background: #ff4545;
      border-color: #ff4545;
      color: #fff;
    }

    #status {
      font-size: .85rem;
      color: #aaa;
      min-height: 1.2em;
      text-align: center;
    }
    #status.err { color: #ff6b6b; }
  </style>
</head>
<body>
  <h1>▶ <span>YT</span> Stream Proxy</h1>

  <div class="search-bar">
    <input id="vid-input" placeholder="YouTube video ID or URL (e.g. dQw4w9WgXcQ)" />
    <button id="load-btn">Load</button>
  </div>

  <p id="status"></p>

  <div id="player-wrap">
    <video id="video" controls crossorigin="anonymous"></video>

    <div class="meta" id="meta"></div>

    <div>
      <p style="font-size:.8rem;color:#777;margin-bottom:.4rem;">STREAMS — select video/audio track:</p>
      <div class="stream-grid" id="stream-grid"></div>
    </div>
  </div>

  <script>
    const $ = id => document.getElementById(id);
    const statusEl = $('status');
    const videoEl  = $('video');

    function setStatus(msg, isErr = false) {
      statusEl.textContent = msg;
      statusEl.className = isErr ? 'err' : '';
    }

    function extractVideoId(input) {
      input = input.trim();
      // Full URL
      try {
        const u = new URL(input);
        if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
        return u.searchParams.get('v') ?? input;
      } catch {
        return input; // assume bare ID
      }
    }

    $('load-btn').addEventListener('click', async () => {
      const raw = $('vid-input').value;
      if (!raw) return;
      const id = extractVideoId(raw);

      $('load-btn').disabled = true;
      setStatus('Fetching stream info…');
      $('player-wrap').style.display = 'none';

      try {
        const res  = await fetch('/info?v=' + encodeURIComponent(id));
        const data = await res.json();

        if (!res.ok) throw new Error(data.error ?? 'Unknown error');

        renderPlayer(data);
        setStatus('');
      } catch (e) {
        setStatus('Error: ' + e.message, true);
      } finally {
        $('load-btn').disabled = false;
      }
    });

    // Allow Enter key
    $('vid-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') $('load-btn').click();
    });

    function renderPlayer(data) {
      // Meta
      const thumb = data.thumbnail
        ? \`<img class="thumb" src="/proxy?url=\${encodeURIComponent(data.thumbnail)}" alt="" />\`
        : '';
      const mins  = Math.floor(data.lengthSeconds / 60);
      const secs  = String(data.lengthSeconds % 60).padStart(2, '0');
      $('meta').innerHTML = \`
        \${thumb}
        <div class="meta-text">
          <h2>\${esc(data.title ?? '')}</h2>
          <p>\${esc(data.author ?? '')} · \${mins}:\${secs}</p>
        </div>\`;

      // Separate video + audio-only streams
      const videos = data.formats.filter(f => f.mimeType?.startsWith('video'));
      const audios = data.formats.filter(f => f.mimeType?.startsWith('audio'));

      const grid = $('stream-grid');
      grid.innerHTML = '';

      // Add combined / video-only formats
      videos.forEach(f => {
        const btn = document.createElement('button');
        btn.className = 'stream-btn';
        btn.textContent = \`\${f.quality} (\${shortMime(f.mimeType)})\`;
        btn.title = f.mimeType;
        btn.addEventListener('click', () => {
          selectStream(f.proxyUrl, btn);
        });
        grid.appendChild(btn);
      });

      // Audio-only
      audios.forEach(f => {
        const btn = document.createElement('button');
        btn.className = 'stream-btn';
        btn.textContent = \`🎵 \${f.quality} (\${shortMime(f.mimeType)})\`;
        btn.title = f.mimeType;
        btn.addEventListener('click', () => {
          selectStream(f.proxyUrl, btn);
        });
        grid.appendChild(btn);
      });

      // Auto-select best combined stream
      const best = videos.find(f => f.mimeType?.includes('mp4') && !f.mimeType?.includes('av01'))
               ?? videos[0]
               ?? audios[0];

      if (best) {
        const firstBtn = grid.querySelector('.stream-btn');
        selectStream(best.proxyUrl, firstBtn);
      }

      $('player-wrap').style.display = 'flex';
    }

    function selectStream(url, btn) {
      document.querySelectorAll('.stream-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      const wasPlaying = !videoEl.paused;
      const pos = videoEl.currentTime;
      videoEl.src = url;
      videoEl.load();
      if (wasPlaying) videoEl.play().catch(() => {});
    }

    function shortMime(mime) {
      if (!mime) return '?';
      const [type, rest] = mime.split(';')[0].split('/');
      return rest ?? type;
    }

    function esc(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
  </script>
</body>
</html>`;
