import { SubtitleTrack } from './types.js';

export function normalizeSubtitles(subtitles: SubtitleTrack[] = []): SubtitleTrack[] {
  return subtitles.map(sub => {
    const isIndo =
      sub.lang.toLowerCase() === 'id' ||
      sub.lang.toLowerCase() === 'ind' ||
      sub.label.toLowerCase().includes('indonesia');
    return {
      ...sub,
      isDefault: isIndo,
    };
  });
}

export function rewriteM3u8Urls(masterM3u8: string, baseUrl: string): string {
  const urlObj = new URL(baseUrl);
  const origin = urlObj.origin;
  const pathParts = urlObj.pathname.split('/');
  pathParts.pop();
  const basePath = pathParts.join('/');

  return masterM3u8
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        // Handle URI="..." inside tags like #EXT-X-MEDIA:TYPE=AUDIO,URI="/v/..."
        return line.replace(/URI=["']([^"']+)["']/g, (match, uri) => {
          if (uri.startsWith('http://') || uri.startsWith('https://')) return match;
          if (uri.startsWith('/')) return `URI="${origin}${uri}"`;
          return `URI="${origin}${basePath}/${uri}"`;
        });
      }

      // Segment or sub-playlist URL line
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed;
      }
      if (trimmed.startsWith('/')) {
        return `${origin}${trimmed}`;
      }
      return `${origin}${basePath}/${trimmed}`;
    })
    .join('\n');
}
