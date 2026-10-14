import { Impit } from 'impit';
import {
  IdlixMediaDetail,
  IdlixSearchResponse,
  MajorplayRedeemResponse,
  PlayInfoGate,
  ClaimSessionResponse,
  ResolvedStream,
  ResolverOptions,
} from './types.js';
import { normalizeSubtitles, rewriteM3u8Urls } from './parser.js';

export class IdlixClient {
  private client: Impit;
  private baseUrl: string;
  private cookieJar: Map<string, string> = new Map();
  private userAgent: string;

  constructor(options: { baseUrl?: string; userAgent?: string } = {}) {
    this.baseUrl = (options.baseUrl || 'https://z2.idlixku.com').replace(/\/+$/, '');
    this.userAgent =
      options.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    this.client = new Impit({ browser: 'chrome' });
  }

  private updateCookies(resHeaders: Headers) {
    const rawCookies = resHeaders.get('set-cookie');
    if (!rawCookies) return;

    // Split multiple cookies if present
    const cookieLines = rawCookies.split(/,(?=[^;]+=[^;]+)/g);
    for (const c of cookieLines) {
      const parts = c.split(';')[0].trim();
      const eqIdx = parts.indexOf('=');
      if (eqIdx !== -1) {
        const name = parts.substring(0, eqIdx).trim();
        const value = parts.substring(eqIdx + 1).trim();
        if (name && value) {
          this.cookieJar.set(name, value);
        }
      }
    }
  }

  private getCookieHeader(): string {
    return Array.from(this.cookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private async fetchWithCookies(url: string, init: any = {}): Promise<any> {
    const headers = new Headers(init.headers || {});
    if (!headers.has('User-Agent')) headers.set('User-Agent', this.userAgent);
    if (!headers.has('Referer')) headers.set('Referer', `${this.baseUrl}/`);
    if (!headers.has('Origin')) headers.set('Origin', this.baseUrl);

    const cookies = this.getCookieHeader();
    if (cookies) {
      headers.set('Cookie', cookies);
    }

    const res = await this.client.fetch(url, {
      ...init,
      headers: Object.fromEntries(headers.entries()),
    });

    this.updateCookies(res.headers);
    return res;
  }

  /**
   * Search movies and TV series on IDLIX
   */
  async search(query: string): Promise<IdlixSearchResponse> {
    const url = `${this.baseUrl}/api/search?q=${encodeURIComponent(query.trim())}`;
    const res = await this.fetchWithCookies(url, {
      headers: { Accept: 'application/json, text/plain, */*' },
    });

    if (!res.ok) {
      throw new Error(`IDLIX Search failed (${res.status}): ${await res.text()}`);
    }

    return (await res.json()) as IdlixSearchResponse;
  }

  /**
   * Fetch Movie details by slug
   */
  async getMovie(slug: string): Promise<IdlixMediaDetail> {
    const cleanSlug = slug.replace(/^\/movie\//, '').replace(/\/$/, '');
    const url = `${this.baseUrl}/api/movies/${cleanSlug}`;
    const res = await this.fetchWithCookies(url, {
      headers: { Accept: 'application/json, text/plain, */*' },
    });

    if (!res.ok) {
      throw new Error(`Failed to get movie "${cleanSlug}" (${res.status})`);
    }

    return (await res.json()) as IdlixMediaDetail;
  }

  /**
   * Fetch TV Series details by slug
   */
  async getSeries(slug: string): Promise<IdlixMediaDetail> {
    const cleanSlug = slug.replace(/^\/series\//, '').replace(/\/$/, '');
    const url = `${this.baseUrl}/api/series/${cleanSlug}`;
    const res = await this.fetchWithCookies(url, {
      headers: { Accept: 'application/json, text/plain, */*' },
    });

    if (!res.ok) {
      throw new Error(`Failed to get series "${cleanSlug}" (${res.status})`);
    }

    return (await res.json()) as IdlixMediaDetail;
  }

  /**
   * Resolve movie stream and Indonesian subtitles
   */
  async resolveMovie(slugOrId: string, options: ResolverOptions = {}): Promise<ResolvedStream> {
    let movieId = slugOrId;
    let movieTitle = slugOrId;

    // If it's a slug or path (contains letters/hyphens), look up movie ID first
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId)) {
      const movie = await this.getMovie(slugOrId);
      movieId = movie.id;
      movieTitle = movie.title;
    }

    return this.resolvePlayGate('movie', movieId, movieTitle, options);
  }

  /**
   * Resolve TV series episode stream and Indonesian subtitles
   */
  async resolveEpisode(
    seriesSlugOrId: string,
    seasonNumber: number,
    episodeNumber: number,
    options: ResolverOptions = {}
  ): Promise<ResolvedStream> {
    let series = seriesSlugOrId;
    let episodeId: string | undefined;
    let episodeTitle = `S${seasonNumber}E${episodeNumber}`;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seriesSlugOrId)) {
      const detail = await this.getSeries(seriesSlugOrId);
      const targetSeason = detail.seasons?.find(s => s.seasonNumber === seasonNumber);
      const targetEp = targetSeason?.episodes?.find(e => e.episodeNumber === episodeNumber);
      if (targetEp) {
        episodeId = targetEp.id;
        episodeTitle = `${detail.title} - S${seasonNumber}E${episodeNumber}`;
      } else {
        episodeId = detail.id;
        episodeTitle = `${detail.title} - S${seasonNumber}E${episodeNumber}`;
      }
    } else {
      episodeId = seriesSlugOrId;
    }

    return this.resolvePlayGate('series', episodeId, episodeTitle, options);
  }

  /**
   * Internal Pentos Play Gate resolver
   */
  private async resolvePlayGate(
    contentType: 'movie' | 'series',
    contentId: string,
    title: string,
    options: ResolverOptions = {}
  ): Promise<ResolvedStream> {
    // 1. Request Play Info Gate
    const playInfoUrl = `${this.baseUrl}/api/watch/play-info/${contentType}/${contentId}`;
    const playInfoRes = await this.fetchWithCookies(playInfoUrl, {
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (!playInfoRes.ok) {
      const err = await playInfoRes.text();
      throw new Error(`IDLIX PlayInfo failed (${playInfoRes.status}): ${err}`);
    }

    const gate = (await playInfoRes.json()) as PlayInfoGate;
    if (gate.kind !== 'gate' || !gate.gateToken) {
      throw new Error(`Unexpected gate response format: ${JSON.stringify(gate)}`);
    }

    // 2. Wait for gate countdown (serverNow -> unlockAt)
    const rawWaitMs = Math.max(0, gate.unlockAt - gate.serverNow + 1200);
    const totalSec = Math.ceil(rawWaitMs / 1000);

    for (let s = totalSec; s > 0; s--) {
      if (options.onCountdown) {
        options.onCountdown(s);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (options.onCountdown) {
      options.onCountdown(0);
    }

    // 3. Claim Session
    const claimUrl = `${this.baseUrl}/api/watch/session/claim`;
    const claimRes = await this.fetchWithCookies(claimUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
      },
      body: JSON.stringify({ gateToken: gate.gateToken }),
    });

    if (!claimRes.ok) {
      const err = await claimRes.text();
      throw new Error(`IDLIX Claim Session failed (${claimRes.status}): ${err}`);
    }

    const claimData = (await claimRes.json()) as ClaimSessionResponse;
    if (!claimData.claim || !claimData.redeemUrl) {
      throw new Error(`Claim response missing claim or redeemUrl: ${JSON.stringify(claimData)}`);
    }

    // 4. Redeem Pentos Stream from Majorplay CDN
    const redeemRes = await this.client.fetch(claimData.redeemUrl, {
      method: 'POST',
      headers: {
        'User-Agent': this.userAgent,
        'Content-Type': 'application/json',
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/`,
      },
      body: JSON.stringify({
        claim: claimData.claim,
        mode: 'browser',
      }),
    });

    if (!redeemRes.ok) {
      const err = await redeemRes.text();
      throw new Error(`Majorplay Redeem failed (${redeemRes.status}): ${err}`);
    }

    const streamData = (await redeemRes.json()) as MajorplayRedeemResponse;
    if (!streamData.url) {
      throw new Error(`Majorplay stream data missing URL: ${JSON.stringify(streamData)}`);
    }

    // 5. Fetch and rewrite master playlist content
    let masterM3u8Content: string | undefined;
    try {
      const m3u8Res = await this.client.fetch(streamData.url, {
        headers: {
          'User-Agent': this.userAgent,
          Origin: this.baseUrl,
          Referer: 'https://majorplay.net/',
        },
      });
      if (m3u8Res.ok) {
        const rawM3u8 = await m3u8Res.text();
        masterM3u8Content = rewriteM3u8Urls(rawM3u8, streamData.url);
      }
    } catch {
      // Non-fatal if pre-fetching master playlist fails
    }

    const subtitles = normalizeSubtitles(streamData.subtitles);

    return {
      title: claimData.title || title,
      videoId: streamData.videoId || claimData.videoId,
      playlistUrl: streamData.url,
      masterM3u8Content,
      expiresAt: streamData.expiresAt,
      ttlSeconds: streamData.ttlSeconds,
      subtitles,
      headers: {
        'User-Agent': this.userAgent,
        Referer: 'https://majorplay.net/',
        Origin: this.baseUrl,
      },
    };
  }
}
