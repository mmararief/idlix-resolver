import http from 'node:http';
import { spawn } from 'node:child_process';
import open from 'open';
import { ResolvedStream, SubtitleTrack } from './types.js';

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

export function startLocalPlayerServer(stream: ResolvedStream): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      if (url.pathname === '/') {
        // Serve beautiful dark HTML5 player
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
      ${defaultSub ? `<track label="${escapeHtml(defaultSub.label)}" kind="subtitles" srclang="${escapeHtml(defaultSub.lang)}" src="${escapeHtml(defaultSub.path)}" default>` : ''}
      ${stream.subtitles
        .filter(s => s !== defaultSub)
        .map(s => `<track label="${escapeHtml(s.label)}" kind="subtitles" srclang="${escapeHtml(s.lang)}" src="${escapeHtml(s.path)}">`)
        .join('\n')}
    </video>
  </div>
  <script>
    const video = document.getElementById('video');
    const streamUrl = '${stream.playlistUrl}';
    if (Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: function(xhr, url) {
          xhr.withCredentials = false;
        }
      });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function() {
        video.play().catch(e => console.log('Autoplay policy caught:', e));
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

      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 4567;
      resolve({
        port,
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
  const defaultSub = stream.subtitles.find(s => s.isDefault) || stream.subtitles[0];

  if (playerType === 'browser') {
    await open(`http://127.0.0.1:${serverPort}`);
    return;
  }

  if (playerType === 'ffplay') {
    const headersStr = `Referer: https://majorplay.net/\r\nUser-Agent: ${stream.headers['User-Agent']}\r\nOrigin: https://z2.idlixku.com\r\n`;
    const args = [
      '-headers',
      headersStr,
      '-window_title',
      `IDLIX: ${stream.title}`,
      '-autoexit',
      stream.playlistUrl,
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
      `--http-header-fields=Referer: https://majorplay.net/,Origin: https://z2.idlixku.com,User-Agent: ${stream.headers['User-Agent']}`,
      `--title=IDLIX: ${stream.title}`,
      stream.playlistUrl,
    ];
    if (defaultSub?.path) {
      args.push(`--sub-file=${defaultSub.path}`);
    }

    const child = spawn('mpv', args, {
      stdio: 'inherit',
      detached: true,
    });
    child.unref();
    return;
  }

  if (playerType === 'vlc') {
    const args = [
      `--http-referrer=https://majorplay.net/`,
      `--meta-title=IDLIX: ${stream.title}`,
      stream.playlistUrl,
    ];
    if (defaultSub?.path) {
      args.push(`--sub-source=${defaultSub.path}`);
    }

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
