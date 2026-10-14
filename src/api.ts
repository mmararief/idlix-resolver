#!/usr/bin/env node

import http from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import { Impit } from 'impit';
import { IdlixClient } from './client.js';
import { ResolvedStream, SubtitleTrack } from './types.js';

export interface ApiServerOptions {
  port?: number;
  host?: string;
  client?: IdlixClient;
  baseUrl?: string;
}

export function createApiServer(options: ApiServerOptions = {}) {
  const port = options.port || parseInt(process.env.PORT || '3000', 10);
  const host = options.host || process.env.HOST || '0.0.0.0';
  const client = options.client || new IdlixClient({ baseUrl: options.baseUrl });
  const proxyCdn = new Impit({ browser: 'chrome' });

  const server = http.createServer(async (req, res) => {
    // CORS headers for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const hostHeader = req.headers.host || `localhost:${port}`;
      const protocol = (req.socket as any).encrypted ? 'https' : 'http';
      const requestUrl = new URL(req.url || '/', `${protocol}://${hostHeader}`);
      const serverOrigin = `${protocol}://${hostHeader}`;
      const pathname = requestUrl.pathname;

      // 1. Health check
      if (pathname === '/health' || pathname === '/api/health') {
        sendJson(res, 200, {
          status: 'ok',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // 2. Root Documentation / UI
      if (pathname === '/' || pathname === '/api') {
        const accept = req.headers.accept || '';
        if (accept.includes('text/html')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderDocumentationHtml(serverOrigin));
          return;
        }

        sendJson(res, 200, {
          name: 'IDLIX Resolver REST API',
          version: '1.0.0',
          description: 'High-performance IDLIX stream extractor & HLS relay API',
          endpoints: {
            'GET /': 'Interactive API documentation & test console (HTML/JSON)',
            'GET /health': 'Service health status',
            'GET /api/search?q={query}': 'Search movies and series',
            'GET /api/movie/{slug}': 'Get movie metadata and ID',
            'GET /api/series/{slug}': 'Get series metadata, seasons, and episodes',
            'GET /api/resolve/movie/{slug}': 'Resolve movie M3U8 stream & subtitles',
            'GET /api/resolve/series/{slug}/{season}/{episode}': 'Resolve series episode stream & subtitles',
            'GET /api/resolve?type={movie|series}&slug={slug}&season={s}&episode={e}': 'Unified resolver endpoint',
            'GET /api/stream?url={m3u8OrChunkUrl}': 'CORS-enabled HLS playlist & segment proxy',
            'GET /api/subtitle?url={vttUrl}': 'CORS-enabled subtitle proxy',
            'GET /watch?type={movie|series}&slug={slug}&season={s}&episode={e}': 'Built-in web player',
          },
          examples: {
            search: `${serverOrigin}/api/search?q=Spider-Man`,
            resolveMovie: `${serverOrigin}/api/resolve/movie/sin-city-2005`,
            resolveSeries: `${serverOrigin}/api/resolve/series/visionquest-2026/1/1`,
            watch: `${serverOrigin}/watch?type=movie&slug=sin-city-2005`,
          },
        });
        return;
      }

      // 3. Search: GET /api/search?q=...
      if (pathname === '/api/search') {
        const query = requestUrl.searchParams.get('q');
        if (!query || !query.trim()) {
          sendJson(res, 400, { success: false, error: 'Query parameter "q" is required' });
          return;
        }

        const searchData = await client.search(query.trim());
        sendJson(res, 200, {
          success: true,
          query: query.trim(),
          count: searchData.results?.length || 0,
          results: searchData.results || [],
        });
        return;
      }

      // 4. Movie Details: GET /api/movie/:slug
      const movieDetailMatch = pathname.match(/^\/api\/movie\/(.+)$/);
      if (movieDetailMatch) {
        const slug = decodeURIComponent(movieDetailMatch[1]);
        const movie = await client.getMovie(slug);
        sendJson(res, 200, { success: true, data: movie });
        return;
      }

      // 5. Series Details: GET /api/series/:slug
      const seriesDetailMatch = pathname.match(/^\/api\/series\/(.+)$/);
      if (seriesDetailMatch) {
        const slug = decodeURIComponent(seriesDetailMatch[1]);
        const series = await client.getSeries(slug);
        sendJson(res, 200, { success: true, data: series });
        return;
      }

      // 6. Unified Resolve: GET /api/resolve?type=movie&slug=... OR GET /api/resolve?type=series&slug=...&season=1&episode=1
      if (pathname === '/api/resolve') {
        const type = requestUrl.searchParams.get('type') || 'movie';
        const slug = requestUrl.searchParams.get('slug');
        const season = parseInt(requestUrl.searchParams.get('season') || '1', 10);
        const episode = parseInt(requestUrl.searchParams.get('episode') || '1', 10);

        if (!slug) {
          sendJson(res, 400, { success: false, error: 'Parameter "slug" is required' });
          return;
        }

        let stream: ResolvedStream;
        if (type === 'series') {
          stream = await client.resolveEpisode(slug, season, episode);
        } else {
          stream = await client.resolveMovie(slug);
        }

        sendResolveResponse(res, serverOrigin, stream, type, slug, season, episode);
        return;
      }

      // 7. Resolve Movie: GET /api/resolve/movie/:slug
      const resolveMovieMatch = pathname.match(/^\/api\/resolve\/movie\/(.+)$/);
      if (resolveMovieMatch) {
        const slug = decodeURIComponent(resolveMovieMatch[1]);
        const stream = await client.resolveMovie(slug);
        sendResolveResponse(res, serverOrigin, stream, 'movie', slug);
        return;
      }

      // 8. Resolve Series Episode: GET /api/resolve/series/:slug/:season/:episode
      const resolveSeriesMatch = pathname.match(/^\/api\/resolve\/series\/([^/]+)\/(\d+)\/(\d+)$/);
      if (resolveSeriesMatch) {
        const slug = decodeURIComponent(resolveSeriesMatch[1]);
        const season = parseInt(resolveSeriesMatch[2], 10);
        const episode = parseInt(resolveSeriesMatch[3], 10);
        const stream = await client.resolveEpisode(slug, season, episode);
        sendResolveResponse(res, serverOrigin, stream, 'series', slug, season, episode);
        return;
      }

      // 9. HLS Stream & Segment Proxy: GET /api/stream?url=...
      if (pathname === '/api/stream') {
        const rawTargetUrl = requestUrl.searchParams.get('url');
        if (!rawTargetUrl) {
          sendJson(res, 400, { success: false, error: 'Target URL is required' });
          return;
        }

        const targetUrl = decodeURIComponent(rawTargetUrl);
        const proxyRes = await proxyCdn.fetch(targetUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            Referer: 'https://z2.idlixku.com/',
            Origin: 'https://z2.idlixku.com',
          },
        });

        if (!proxyRes.ok) {
          res.writeHead(proxyRes.status, { 'Content-Type': 'text/plain' });
          res.end(`Upstream CDN responded with status: ${proxyRes.status}`);
          return;
        }

        const contentType = proxyRes.headers.get('content-type') || '';
        const isM3u8 =
          targetUrl.includes('.m3u8') ||
          targetUrl.includes('.json') ||
          contentType.includes('mpegurl') ||
          contentType.includes('application/x-mpegurl');

        if (isM3u8) {
          const text = await proxyRes.text();
          if (text.startsWith('#EXTM3U') || text.includes('#EXT-X-')) {
            const rewritten = rewriteM3u8ForProxy(text, targetUrl, `${serverOrigin}/api/stream`);
            res.writeHead(200, {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
            });
            res.end(rewritten);
            return;
          }
        }

        // Binary media segments (.js / .ts / .m4s chunks)
        const arrayBuffer = await proxyRes.arrayBuffer();
        res.writeHead(200, {
          'Content-Type': contentType || 'video/mp2t',
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(Buffer.from(arrayBuffer));
        return;
      }

      // 10. Subtitle Proxy: GET /api/subtitle?url=...
      if (pathname === '/api/subtitle') {
        const subUrl = requestUrl.searchParams.get('url');
        if (!subUrl) {
          sendJson(res, 400, { success: false, error: 'Subtitle URL is required' });
          return;
        }

        const subRes = await proxyCdn.fetch(decodeURIComponent(subUrl), {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            Referer: 'https://z2.idlixku.com/',
          },
        });

        const subText = await subRes.text();
        res.writeHead(200, {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(subText);
        return;
      }

      // 11. Built-in Web Player: GET /watch?type=...&slug=...
      if (pathname === '/watch') {
        const type = (requestUrl.searchParams.get('type') || 'movie') as 'movie' | 'series';
        const slug = requestUrl.searchParams.get('slug');
        const season = parseInt(requestUrl.searchParams.get('season') || '1', 10);
        const episode = parseInt(requestUrl.searchParams.get('episode') || '1', 10);

        if (!slug) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Missing "slug" query parameter</h1><p>Example: /watch?type=movie&slug=sin-city-2005</p>');
          return;
        }

        let stream: ResolvedStream;
        if (type === 'series') {
          stream = await client.resolveEpisode(slug, season, episode);
        } else {
          stream = await client.resolveMovie(slug);
        }

        const proxyStreamUrl = `${serverOrigin}/api/stream?url=${encodeURIComponent(stream.playlistUrl)}`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderWebPlayerHtml(stream, proxyStreamUrl, serverOrigin));
        return;
      }

      // 404 Not Found
      sendJson(res, 404, {
        success: false,
        error: `Route not found: ${req.method} ${pathname}`,
      });
    } catch (err: any) {
      console.error('[IDLIX API Error]:', err);
      sendJson(res, 500, {
        success: false,
        error: err.message || 'Internal server error',
      });
    }
  });

  return {
    server,
    port,
    host,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.listen(port, host, () => {
          console.log(`\n🚀 IDLIX Resolver API is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
          console.log(`📖 Docs & Playground: http://localhost:${port}/`);
          console.log(`🔍 Search Example:   http://localhost:${port}/api/search?q=Spider-Man\n`);
          resolve();
        });
        server.on('error', reject);
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}

function sendJson(res: http.ServerResponse, statusCode: number, data: any) {
  const json = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(json);
}

function sendResolveResponse(
  res: http.ServerResponse,
  serverOrigin: string,
  stream: ResolvedStream,
  type: string,
  slug: string,
  season?: number,
  episode?: number
) {
  const proxyPlaylistUrl = `${serverOrigin}/api/stream?url=${encodeURIComponent(stream.playlistUrl)}`;
  const watchUrl =
    type === 'series'
      ? `${serverOrigin}/watch?type=series&slug=${encodeURIComponent(slug)}&season=${season}&episode=${episode}`
      : `${serverOrigin}/watch?type=movie&slug=${encodeURIComponent(slug)}`;

  const proxiedSubtitles = stream.subtitles.map(sub => ({
    ...sub,
    proxyUrl: `${serverOrigin}/api/subtitle?url=${encodeURIComponent(sub.path)}`,
  }));

  sendJson(res, 200, {
    success: true,
    type,
    slug,
    title: stream.title,
    videoId: stream.videoId,
    playlistUrl: stream.playlistUrl,
    proxyPlaylistUrl,
    watchUrl,
    expiresAt: stream.expiresAt,
    ttlSeconds: stream.ttlSeconds,
    subtitles: proxiedSubtitles,
  });
}

function rewriteM3u8ForProxy(content: string, baseUrl: string, proxyEndpoint: string): string {
  const urlObj = new URL(baseUrl);
  const origin = urlObj.origin;
  const search = urlObj.search;
  const pathParts = urlObj.pathname.split('/');
  pathParts.pop();
  const basePath = pathParts.join('/');

  const makeAbsolute = (rawUrl: string): string => {
    let full = rawUrl;
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
      full = rawUrl.startsWith('/') ? `${origin}${rawUrl}` : `${origin}${basePath}/${rawUrl}`;
    }
    if (search) {
      const token = search.startsWith('?') ? search.slice(1) : search;
      full = full.includes('?') ? `${full}&${token}` : `${full}?${token}`;
    }
    return full;
  };

  return content
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        return line.replace(/URI=["']([^"']+)["']/g, (match, uri) => {
          const absolute = makeAbsolute(uri);
          const proxied = `${proxyEndpoint}?url=${encodeURIComponent(absolute)}`;
          return `URI="${proxied}"`;
        });
      }

      const absolute = makeAbsolute(trimmed);
      return `${proxyEndpoint}?url=${encodeURIComponent(absolute)}`;
    })
    .join('\n');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderDocumentationHtml(serverOrigin: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IDLIX Resolver REST API</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card: #111726;
      --border: #1f293d;
      --accent: #e50914;
      --accent-glow: rgba(229, 9, 20, 0.25);
      --text: #f1f5f9;
      --muted: #94a3b8;
      --code-bg: #0d121f;
      --method-get: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      padding: 40px 20px;
      line-height: 1.6;
    }
    .container { max-width: 1000px; margin: 0 auto; }
    header { margin-bottom: 40px; text-align: center; }
    h1 { font-size: 2.4rem; font-weight: 800; color: #fff; margin-bottom: 8px; }
    h1 span { color: var(--accent); }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-radius: 9999px;
      background: rgba(16, 185, 129, 0.15);
      color: #10b981;
      border: 1px solid rgba(16, 185, 129, 0.3);
      margin-bottom: 12px;
    }
    p.lead { color: var(--muted); font-size: 1.05rem; max-width: 650px; margin: 0 auto; }
    
    .grid { display: grid; grid-template-columns: 1fr; gap: 20px; margin-top: 30px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    }
    .endpoint-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .method {
      background: rgba(16, 185, 129, 0.15);
      color: var(--method-get);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
    }
    .path {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.05rem;
      font-weight: 600;
      color: #fff;
    }
    .endpoint-desc { color: var(--muted); font-size: 0.92rem; margin-bottom: 14px; }
    .example-box {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      overflow-x: auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .example-box a { color: #38bdf8; text-decoration: none; word-break: break-all; }
    .example-box a:hover { text-decoration: underline; }
    
    .tester {
      background: linear-gradient(180deg, #161f33 0%, var(--card) 100%);
      border: 1px solid #2d3b58;
      border-radius: 12px;
      padding: 28px;
      margin-bottom: 35px;
    }
    .tester h2 { font-size: 1.3rem; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .search-bar { display: flex; gap: 10px; }
    input[type="text"] {
      flex: 1;
      padding: 12px 16px;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: #fff;
      font-size: 0.95rem;
      outline: none;
    }
    input[type="text"]:focus { border-color: var(--accent); }
    button {
      padding: 12px 24px;
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
    #testResults {
      margin-top: 16px;
      background: var(--code-bg);
      padding: 16px;
      border-radius: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.82rem;
      max-height: 300px;
      overflow-y: auto;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="badge">API v1.0 • ONLINE</div>
      <h1><span>IDLIX</span> Resolver API</h1>
      <p class="lead">Fast, TLS-impersonated stream & Indonesian subtitle extractor for IDLIX with built-in CORS HLS proxying.<br><span style="color: #64748b; font-size: 0.9rem;">Created with ❤️ by <strong>amayonaise</strong> (<a href="https://github.com/mmararief" target="_blank" style="color: #38bdf8; text-decoration: none;">@mmararief</a>)</span></p>
    </header>

    <div class="tester">
      <h2>⚡ Quick Live Tester</h2>
      <div class="search-bar">
        <input type="text" id="queryInput" placeholder="Enter movie or series title (e.g. Spider-Man, Sin City, Avatar)..." value="Spider-Man" />
        <button onclick="runSearch()">Search API</button>
      </div>
      <pre id="testResults"></pre>
    </div>

    <div class="grid">
      <!-- 1. Search -->
      <div class="card">
        <div class="endpoint-header">
          <span class="method">GET</span>
          <span class="path">/api/search?q={query}</span>
        </div>
        <p class="endpoint-desc">Search IDLIX catalog for movies and TV series by keyword.</p>
        <div class="example-box">
          <a href="${serverOrigin}/api/search?q=Spider-Man" target="_blank">${serverOrigin}/api/search?q=Spider-Man</a>
        </div>
      </div>

      <!-- 2. Movie Detail -->
      <div class="card">
        <div class="endpoint-header">
          <span class="method">GET</span>
          <span class="path">/api/movie/{slug}</span>
        </div>
        <p class="endpoint-desc">Get detailed movie metadata, ID, genres, overview, and poster paths.</p>
        <div class="example-box">
          <a href="${serverOrigin}/api/movie/sin-city-2005" target="_blank">${serverOrigin}/api/movie/sin-city-2005</a>
        </div>
      </div>

      <!-- 3. Series Detail -->
      <div class="card">
        <div class="endpoint-header">
          <span class="method">GET</span>
          <span class="path">/api/series/{slug}</span>
        </div>
        <p class="endpoint-desc">Get TV series details, seasons, episodes count, and episode IDs.</p>
        <div class="example-box">
          <a href="${serverOrigin}/api/series/visionquest-2026" target="_blank">${serverOrigin}/api/series/visionquest-2026</a>
        </div>
      </div>

      <!-- 4. Resolve Movie -->
      <div class="card">
        <div class="endpoint-header">
          <span class="method">GET</span>
          <span class="path">/api/resolve/movie/{slug}</span>
        </div>
        <p class="endpoint-desc">Bypass Pentos gate, redeem playback session, and extract direct M3U8 playlist & Indonesian subtitles.</p>
        <div class="example-box">
          <a href="${serverOrigin}/api/resolve/movie/sin-city-2005" target="_blank">${serverOrigin}/api/resolve/movie/sin-city-2005</a>
        </div>
      </div>

      <!-- 5. Resolve Series -->
      <div class="card">
        <div class="endpoint-header">
          <span class="method">GET</span>
          <span class="path">/api/resolve/series/{slug}/{season}/{episode}</span>
        </div>
        <p class="endpoint-desc">Resolve episode stream and Indonesian subtitles for a specific season and episode number.</p>
        <div class="example-box">
          <a href="${serverOrigin}/api/resolve/series/visionquest-2026/1/1" target="_blank">${serverOrigin}/api/resolve/series/visionquest-2026/1/1</a>
        </div>
      </div>

      <!-- 6. HLS Proxy -->
      <div class="card">
        <div class="endpoint-header">
          <span class="method">GET</span>
          <span class="path">/api/stream?url={targetUrl}</span>
        </div>
        <p class="endpoint-desc">Reverse proxy for HLS playlists (.m3u8) and chunks (.js/.ts) with automatic auth token injection and full CORS support for browser players.</p>
      </div>

      <!-- 7. Built-in Player -->
      <div class="card">
        <div class="endpoint-header">
          <span class="method">GET</span>
          <span class="path">/watch?type={movie|series}&slug={slug}</span>
        </div>
        <p class="endpoint-desc">Built-in responsive HTML5 player with HLS video decoding and Indonesian subtitle tracks.</p>
        <div class="example-box">
          <a href="${serverOrigin}/watch?type=movie&slug=sin-city-2005" target="_blank">${serverOrigin}/watch?type=movie&slug=sin-city-2005</a>
        </div>
      </div>
    </div>
  </div>

  <script>
    async function runSearch() {
      const q = document.getElementById('queryInput').value;
      const resEl = document.getElementById('testResults');
      resEl.style.display = 'block';
      resEl.textContent = 'Searching...';
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(q));
        const data = await res.json();
        resEl.textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        resEl.textContent = 'Error: ' + err.message;
      }
    }
  </script>
</body>
</html>`;
}

function renderWebPlayerHtml(stream: ResolvedStream, proxyStreamUrl: string, serverOrigin: string): string {
  const defaultSub = stream.subtitles.find(s => s.isDefault) || stream.subtitles[0];

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nonton: ${escapeHtml(stream.title)} - IDLIX Player</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #000;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header {
      background: #111;
      padding: 12px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #222;
      z-index: 10;
    }
    h1 {
      font-size: 1.1rem;
      font-weight: 600;
      color: #eee;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .badge {
      background: #e50914;
      color: white;
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .video-container {
      flex: 1;
      position: relative;
      background: #000;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    video {
      width: 100%;
      height: 100%;
      max-height: calc(100vh - 50px);
      object-fit: contain;
    }
  </style>
</head>
<body>
  <header>
    <h1>🎬 ${escapeHtml(stream.title)}</h1>
    <span class="badge">IDLIX STREAM</span>
  </header>

  <div class="video-container">
    <video id="videoPlayer" controls autoplay playsinline crossorigin="anonymous">
      ${stream.subtitles
        .map(
          sub => `
        <track
          kind="subtitles"
          label="${escapeHtml(sub.label)}"
          srclang="${escapeHtml(sub.lang)}"
          src="${serverOrigin}/api/subtitle?url=${encodeURIComponent(sub.path)}"
          ${sub.isDefault ? 'default' : ''}
        />
      `
        )
        .join('\n')}
    </video>
  </div>

  <script>
    const video = document.getElementById('videoPlayer');
    const streamUrl = ${JSON.stringify(proxyStreamUrl)};

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
      });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        video.play().catch(e => console.log('Autoplay blocked:', e));
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl;
      video.addEventListener('loadedmetadata', function () {
        video.play().catch(e => console.log('Autoplay blocked:', e));
      });
    }
  </script>
</body>
</html>`;
}

// Standalone execution: npx tsx src/api.ts or node dist/api.js
const currentFilePath = fileURLToPath(import.meta.url);
const isDirectlyExecuted =
  process.argv[1] &&
  (process.argv[1] === currentFilePath ||
    process.argv[1].replace(/\\/g, '/').endsWith('/src/api.ts') ||
    process.argv[1].replace(/\\/g, '/').endsWith('/dist/api.js'));

if (isDirectlyExecuted) {
  let port = parseInt(process.env.PORT || '3000', 10);
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10);
  }

  const server = createApiServer({ port });
  server.listen().catch(err => {
    console.error('Failed to start IDLIX API server:', err);
    process.exit(1);
  });
}
