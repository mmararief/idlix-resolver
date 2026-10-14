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
  const search = urlObj.search; // Contains auth token '?t=...&pm=browser'
  const pathParts = urlObj.pathname.split('/');
  pathParts.pop();
  const basePath = pathParts.join('/');

  const appendToken = (urlStr: string): string => {
    if (!search) return urlStr;
    const tokenQuery = search.startsWith('?') ? search.slice(1) : search;
    return urlStr.includes('?') ? `${urlStr}&${tokenQuery}` : `${urlStr}?${tokenQuery}`;
  };

  return masterM3u8
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        // Handle URI="..." inside tags like #EXT-X-MEDIA:TYPE=AUDIO,URI="/v/..." or #EXT-X-MAP:URI="..."
        return line.replace(/URI=["']([^"']+)["']/g, (match, uri) => {
          let fullUrl = uri;
          if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
            fullUrl = uri.startsWith('/') ? `${origin}${uri}` : `${origin}${basePath}/${uri}`;
          }
          return `URI="${appendToken(fullUrl)}"`;
        });
      }

      // Sub-playlist line or Segment line
      let fullUrl = trimmed;
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        fullUrl = trimmed.startsWith('/') ? `${origin}${trimmed}` : `${origin}${basePath}/${trimmed}`;
      }
      return appendToken(fullUrl);
    })
    .join('\n');
}
