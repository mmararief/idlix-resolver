export { IdlixClient } from './client.js';
export { startTUI } from './tui.js';
export * from './types.js';
export * from './parser.js';
export * from './player.js';

import { IdlixClient } from './client.js';

// Default global instance for convenience
const defaultClient = new IdlixClient();

export const search = defaultClient.search.bind(defaultClient);
export const getMovie = defaultClient.getMovie.bind(defaultClient);
export const getSeries = defaultClient.getSeries.bind(defaultClient);
export const resolveMovie = defaultClient.resolveMovie.bind(defaultClient);
export const resolveEpisode = defaultClient.resolveEpisode.bind(defaultClient);

export default defaultClient;
