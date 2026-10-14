export type ContentType = 'movie' | 'series';

export interface IdlixSearchItem {
  id: string;
  contentType: ContentType;
  title: string;
  originalTitle?: string;
  slug: string;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  releaseDate?: string;
  voteAverage?: string | number;
}

export interface IdlixSearchResponse {
  results: IdlixSearchItem[];
}

export interface IdlixEpisode {
  id: string;
  episodeNumber: number;
  seasonNumber: number;
  title: string;
  overview?: string;
  stillPath?: string;
  airDate?: string;
}

export interface IdlixSeason {
  seasonNumber: number;
  title?: string;
  episodes: IdlixEpisode[];
}

export interface IdlixMediaDetail {
  id: string;
  tmdbId?: number;
  imdbId?: string;
  title: string;
  slug: string;
  originalTitle?: string;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  releaseDate?: string;
  runtime?: number;
  quality?: string;
  genres?: Array<{ id: string | number; name: string }>;
  seasons?: IdlixSeason[];
}

export interface PlayInfoGate {
  kind: 'gate';
  gateToken: string;
  serverNow: number;
  unlockAt: number;
  countdownSec?: number;
  viewerTier?: string;
  maxHeight?: number;
}

export interface ClaimSessionResponse {
  kind: 'pentos';
  claim: string;
  claimExpiresAt: number;
  redeemUrl: string;
  videoId: string;
  title: string;
  durationSec: number;
  renewalToken?: string;
}

export interface SubtitleTrack {
  lang: string;
  label: string;
  path: string;
  isDefault?: boolean;
}

export interface MajorplayRedeemResponse {
  code: 'ok' | string;
  url: string;
  expiresAt: number;
  mode: string;
  ttlSeconds: number;
  videoId: string;
  subtitles: SubtitleTrack[];
}

export interface ResolvedStream {
  title: string;
  videoId: string;
  playlistUrl: string;
  masterM3u8Content?: string;
  expiresAt: number;
  ttlSeconds: number;
  subtitles: SubtitleTrack[];
  headers: Record<string, string>;
}

export interface ResolverOptions {
  baseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  onCountdown?: (secondsRemaining: number) => void;
}
