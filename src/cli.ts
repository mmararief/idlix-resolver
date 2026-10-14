#!/usr/bin/env node

import { IdlixClient } from './client.js';
import { createApiServer } from './api.js';

async function main() {
  const args = process.argv.slice(2);
  const client = new IdlixClient();

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(`
🎬 IDLIX Resolver CLI (z2.idlixku.com) • by amayonaise (@mmararief)
Usage:
  npx idlix-resolver search <query>
  npx idlix-resolver resolve <movie-slug-or-id>
  npx idlix-resolver episode <series-slug-or-id> <season> <episode>
  npx idlix-resolver api [--port 3000]

Examples:
  npx idlix-resolver search "Spider-Man"
  npx idlix-resolver resolve "sin-city-2005"
  npx idlix-resolver episode "visionquest-2026" 1 1
  npx idlix-resolver api --port 3000
`);
    process.exit(0);
  }

  const command = args[0];

  try {
    if (command === 'api' || command === 'server') {
      let port = parseInt(process.env.PORT || '3000', 10);
      const portIdx = args.indexOf('--port');
      if (portIdx !== -1 && args[portIdx + 1]) {
        port = parseInt(args[portIdx + 1], 10);
      }
      const apiServer = createApiServer({ port, client });
      await apiServer.listen();
      return;
    } else if (command === 'search') {
      const q = args.slice(1).join(' ');
      if (!q) {
        console.error('❌ Please provide a search query.');
        process.exit(1);
      }
      console.log(`🔍 Searching IDLIX for: "${q}"...`);
      const res = await client.search(q);
      console.log(`✅ Found ${res.results.length} result(s):\n`);
      for (const item of res.results) {
        console.log(` • [${item.contentType.toUpperCase()}] ${item.title}`);
        console.log(`   Slug: ${item.slug} | ID: ${item.id}`);
        if (item.releaseDate) console.log(`   Release: ${item.releaseDate}`);
        console.log('');
      }
    } else if (command === 'resolve' || command === 'movie') {
      const slug = args[1];
      if (!slug) {
        console.error('❌ Please provide a movie slug or ID.');
        process.exit(1);
      }
      console.log(`🚀 Resolving stream for movie: "${slug}"...`);
      const stream = await client.resolveMovie(slug, {
        onCountdown: sec => {
          process.stdout.write(`\r⏳ Unlocking playback session gate... [${sec}s remaining] `);
        },
      });
      console.log('\n\n🎉 STREAM RESOLVED SUCCESSFULLY!');
      console.log('----------------------------------------------------');
      console.log(`Title:       ${stream.title}`);
      console.log(`Video ID:    ${stream.videoId}`);
      console.log(`Playlist:    ${stream.playlistUrl}`);
      console.log(`Expires At:  ${new Date(stream.expiresAt * 1000).toLocaleString()}`);
      console.log('\n💬 Subtitles:');
      for (const sub of stream.subtitles) {
        console.log(`  [${sub.lang.toUpperCase()}] ${sub.label}${sub.isDefault ? ' (DEFAULT)' : ''}`);
        console.log(`  URL: ${sub.path}`);
      }
      console.log('----------------------------------------------------');
    } else if (command === 'episode') {
      const slug = args[1];
      const season = parseInt(args[2] || '1', 10);
      const episode = parseInt(args[3] || '1', 10);
      if (!slug) {
        console.error('❌ Please provide a series slug or ID.');
        process.exit(1);
      }
      console.log(`🚀 Resolving S${season}E${episode} for series: "${slug}"...`);
      const stream = await client.resolveEpisode(slug, season, episode, {
        onCountdown: sec => {
          process.stdout.write(`\r⏳ Unlocking playback session gate... [${sec}s remaining] `);
        },
      });
      console.log('\n\n🎉 EPISODE STREAM RESOLVED SUCCESSFULLY!');
      console.log('----------------------------------------------------');
      console.log(`Title:       ${stream.title}`);
      console.log(`Playlist:    ${stream.playlistUrl}`);
      console.log('\n💬 Subtitles:');
      for (const sub of stream.subtitles) {
        console.log(`  [${sub.lang.toUpperCase()}] ${sub.label}${sub.isDefault ? ' (DEFAULT)' : ''}`);
        console.log(`  URL: ${sub.path}`);
      }
      console.log('----------------------------------------------------');
    } else {
      // Default to search
      const q = args.join(' ');
      console.log(`🔍 Searching IDLIX for: "${q}"...`);
      const res = await client.search(q);
      console.log(`✅ Found ${res.results.length} results.`);
      for (const item of res.results) {
        console.log(` - [${item.contentType}] ${item.title} (slug: ${item.slug})`);
      }
    }
  } catch (err: any) {
    console.error(`\n❌ Error:`, err?.message || err);
    process.exit(1);
  }
}

main();
