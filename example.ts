import { IdlixClient, search, resolveMovie } from './src/index.js';

async function runDemo() {
  console.log('=== IDLIX RESOLVER DEMO ===\n');

  // 1. Search content
  console.log('1. Searching for "Spider-Man"...');
  const results = await search('Spider-Man');
  console.log(`Found ${results.results.length} item(s):`);
  results.results.slice(0, 3).forEach(r => {
    console.log(` - [${r.contentType}] ${r.title} (${r.slug})`);
  });

  // 2. Resolve Movie
  console.log('\n2. Resolving movie "sin-city-2005"...');
  const stream = await resolveMovie('sin-city-2005', {
    onCountdown: sec => {
      process.stdout.write(`\r⏳ Unlocking playback gate... ${sec}s `);
    },
  });

  console.log('\n\n✅ Stream Unlocked!');
  console.log('Playlist URL:', stream.playlistUrl);
  console.log('Video ID:', stream.videoId);
  console.log('Subtitles:', stream.subtitles.length, 'track(s)');
  stream.subtitles.forEach(s => {
    console.log(` - [${s.lang}] ${s.label}: ${s.path}`);
  });
}

runDemo().catch(console.error);
