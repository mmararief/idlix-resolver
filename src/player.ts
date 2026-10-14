import http from 'node:http';
import { spawn } from 'node:child_process';
import open from 'open';
import { Impit } from 'impit';
import { ResolvedStream, SubtitleTrack } from './types.js';
import { rewriteM3u8Urls } from './parser.js';

export interface AvailablePlayer {
  id: 'ffplay' | 'mpv' | 'vlc' | 'browser';
  name: string;
  path?: string;
  isAvailable: boolean;
}

export async function detectPlayers(): Promise<AvailablePlayer[]> {
  const isWindows = process.platform === 'win32';

  const checkCommand = async (cmd: string): Promise<string | null> => {
    return new Promise(resolve => {
      const probe = isWindows
        ? spawn('where.exe', [cmd], { stdio: 'pipe' })
        : spawn('which', [cmd], { stdio: 'pipe' });

      let out = '';
      probe.stdout?.on('data', d => (out += d.toString()));
      probe.on('close', code => {
        if (code === 0 && out.trim()) {
          resolve(out.split('\n')[0]?.trim() || null);
        } else {
          resolve(null);
        }
      });
      probe.on('error', () => resolve(null));
    });
  };

  const [ffplayPath, mpvPath, vlcPath] = await Promise.all([
    checkCommand('ffplay'),
    checkCommand('mpv'),
    checkCommand('vlc'),
  ]);

  return [
    {
      id: 'ffplay',
      name: 'FFplay (Fast Lightweight Player)',
      path: ffplayPath || undefined,
      isAvailable: !!ffplayPath,
    },
    {
      id: 'mpv',
      name: 'MPV Player',
      path: mpvPath || undefined,
      isAvailable: !!mpvPath,
    },
    {
      id: 'vlc',
      name: 'VLC Media Player',
      path: vlcPath || undefined,
      isAvailable: !!vlcPath,
    },
    {
      id: 'browser',
      name: 'Web Browser (Built-in HTML5 HLS Player)',
      isAvailable: true,
    },
  ];
}

export function startLocalPlayerServer(stream: ResolvedStream): Promise<{ port: number; localM3u8Url: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const cdn = new Impit({ browser: 'chrome' });

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);

        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // 1. Web Player Homepage
        if (url.pathname === '/') {
          const defaultSub = stream.subtitles.find(s => s.isDefault) || stream.subtitles[0];
          const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nonton: ${escapeHtml(stream.title)} - IDLIX Player</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0c; color: #fff; font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    header { background: #121217; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #222; }
    header h1 { font-size: 1.1rem; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    header .badge { background: #e50914; color: #fff; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; font-weight: bold; }
    .player-container { flex: 1; display: flex; align-items: center; justify-content: center; position: relative; background: #000; }
    video { width: 100%; height: 100%; max-height: calc(100vh - 55px); outline: none; }
    ::cue { background: rgba(0, 0, 0, 0.75); color: #ffff00; font-size: 1.1rem; font-weight: 600; text-shadow: 1px 1px 2px #000; }
  </style>
</head>
<body>
  <header>
    <h1><span class="badge">IDLIX</span> ${escapeHtml(stream.title)}</h1>
    <div style="font-size: 0.85rem; color: #888;">Direct Stream via Majorplay HLS</div>
  </header>
  <div class="player-container">
    <video id="video" controls autoplay playsinline crossorigin="anonymous">
      ${defaultSub ? `<track label="${escapeHtml(defaultSub.label)}" kind="subtitles" srclang="${escapeHtml(defaultSub.lang)}" src="/sub" default>` : ''}
      ${stream.subtitles
        .filter(s => s !== defaultSub)
        .map(s => `<track label="${escapeHtml(s.label)}" kind="subtitles" srclang="${escapeHtml(s.lang)}" src="${escapeHtml(s.path)}">`)
        .join('\n')}
    </video>
  </div>
  <script>
    const video = document.getElementById('video');
    const streamUrl = '/master.m3u8';
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
      });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function() {
        video.play().catch(e => console.log('Autoplay caught:', e));
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl;
      video.addEventListener('loadedmetadata', function() {
        video.play();
      });
    }
  </script>
</body>
</html>`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        // 2. Master Playlist Relay
        if (url.pathname === '/master.m3u8') {
          const upstreamRes = await cdn.fetch(stream.playlistUrl, {
            headers: {
              'User-Agent': stream.headers['User-Agent'],
              'Origin': 'https://z2.idlixku.com',
              'Referer': 'https://majorplay.net/',
            },
          });
          const rawM3u8 = await upstreamRes.text();
          const rewritten = rewriteM3u8Urls(rawM3u8, stream.playlistUrl);

          // Route sub-playlists through local proxy so auth token is preserved
          const host = req.headers.host;
          const proxiedM3u8 = rewritten.replace(/https?:\/\/[^\s\n"']+/g, matchedUrl => {
            return `http://${host}/relay?url=${encodeURIComponent(matchedUrl)}`;
          });

          res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache',
          });
          res.end(proxiedM3u8);
          return;
        }

        // 3. Sub-playlist & Video Chunk Relay
        if (url.pathname === '/relay') {
          const targetUrl = url.searchParams.get('url');
          if (!targetUrl) {
            res.writeHead(400);
            res.end('Missing url');
            return;
          }

          const targetRes = await cdn.fetch(targetUrl, {
            headers: {
              'User-Agent': stream.headers['User-Agent'],
              'Origin': 'https://z2.idlixku.com',
              'Referer': 'https://majorplay.net/',
            },
          });

          // Check if response is M3U8 text or binary media segment
          const contentType = targetRes.headers.get('content-type') || '';
          if (contentType.includes('mpegurl') || targetUrl.includes('.json') || targetUrl.includes('.m3u8')) {
            const rawBody = await targetRes.text();
            if (rawBody.includes('#EXTM3U')) {
              const host = req.headers.host;
              const rewrittenSub = rewriteM3u8Urls(rawBody, targetUrl).replace(/https?:\/\/[^\s\n"']+/g, mUrl => {
                return `http://${host}/relay?url=${encodeURIComponent(mUrl)}`;
              });

              res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-cache',
              });
              res.end(rewrittenSub);
              return;
            }
          }

          // Binary TS/fMP4 video chunk
          const buffer = Buffer.from(await targetRes.arrayBuffer());
          res.writeHead(targetRes.status, {
            'Content-Type': contentType || 'video/mp2t',
            'Content-Length': buffer.length,
          });
          res.end(buffer);
          return;
        }

        // 4. Subtitle Relay
        if (url.pathname === '/sub') {
          const defaultSub = stream.subtitles.find(s => s.isDefault) || stream.subtitles[0];
          if (!defaultSub) {
            res.writeHead(404);
            res.end();
            return;
          }

          const subRes = await cdn.fetch(defaultSub.path, {
            headers: {
              'User-Agent': stream.headers['User-Agent'],
              'Referer': 'https://majorplay.net/',
            },
          });
          const subText = await subRes.text();
          res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
          res.end(subText);
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      } catch (err: any) {
        res.writeHead(500);
        res.end(err?.message || 'Proxy Error');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 4567;
      resolve({
        port,
        localM3u8Url: `http://127.0.0.1:${port}/master.m3u8`,
        close: () => server.close(),
      });
    });

    server.on('error', reject);
  });
}

export async function launchPlayer(
  playerType: 'ffplay' | 'mpv' | 'vlc' | 'browser',
  stream: ResolvedStream,
  serverPort: number
): Promise<void> {
  const localUrl = `http://127.0.0.1:${serverPort}`;
  const localM3u8 = `${localUrl}/master.m3u8`;

  if (playerType === 'browser') {
    await open(localUrl);
    return;
  }

  if (playerType === 'ffplay') {
    const args = [
      '-window_title',
      `IDLIX: ${stream.title}`,
      '-autoexit',
      localM3u8,
    ];

    const child = spawn('ffplay', args, {
      stdio: 'inherit',
      detached: true,
    });
    child.unref();
    return;
  }

  if (playerType === 'mpv') {
    const args = [
      `--title=IDLIX: ${stream.title}`,
      `--sub-file=${localUrl}/sub`,
      localM3u8,
    ];

    const child = spawn('mpv', args, {
      stdio: 'inherit',
      detached: true,
    });
    child.unref();
    return;
  }

  if (playerType === 'vlc') {
    const args = [
      `--meta-title=IDLIX: ${stream.title}`,
      `--sub-source=${localUrl}/sub`,
      localM3u8,
    ];

    const child = spawn('vlc', args, {
      stdio: 'inherit',
      detached: true,
    });
    child.unref();
    return;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
