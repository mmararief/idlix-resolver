#!/usr/bin/env node

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { IdlixClient } from './client.js';
import { detectPlayers, launchPlayer, startLocalPlayerServer } from './player.js';
import { IdlixSearchItem, ResolvedStream } from './types.js';

const client = new IdlixClient();

async function renderBanner() {
  console.clear();
  const art = pc.red(`
   ██╗██████╗ ██╗     ██╗██╗  ██╗
   ██║██╔══██╗██║     ██║╚██╗██╔╝
   ██║██║  ██║██║     ██║ ╚███╔╝ 
   ██║██║  ██║██║     ██║ ██╔██╗ 
   ██║██████╔╝███████╗██║██╔╝ ██╗
   ╚═╝╚═════╝ ╚══════╝╚═╝╚═╝  ╚═╝
`) + pc.cyan(`   🍿 TERMINAL STREAMING & PLAYER (v1.0.0)\n   🇮🇩 Indonesian Subtitle Stream Resolver\n`);
  console.log(pc.bold(art));
}

export async function startTUI() {
  await renderBanner();
  p.intro(pc.bgRed(pc.white(' IDLIX WATCH EXPERIENCE ')));

  while (true) {
    const action = await p.select({
      message: 'Pilih aksi yang ingin kamu lakukan:',
      options: [
        { value: 'search', label: '🔍 Cari Film / TV Series', hint: 'Ketik judul apa saja' },
        { value: 'direct', label: '🔗 Masukkan Slug Film Langsung', hint: 'Contoh: sin-city-2005' },
        { value: 'exit', label: '❌ Keluar' },
      ],
    });

    if (p.isCancel(action) || action === 'exit') {
      p.outro(pc.yellow('Sampai jumpa lagi! Selamat menonton 🍿'));
      process.exit(0);
    }

    if (action === 'search') {
      await handleSearchFlow();
    } else if (action === 'direct') {
      await handleDirectFlow();
    }
  }
}

async function handleSearchFlow() {
  const query = await p.text({
    message: 'Ketik judul film atau serial yang ingin ditonton:',
    placeholder: 'Spider-Man / Sin City / Inception ...',
    validate: v => (!v || !v.trim() ? 'Input tidak boleh kosong!' : undefined),
  });

  if (p.isCancel(query)) return;

  const s = p.spinner();
  s.start(pc.cyan(`Mencari "${query}" di IDLIX...`));

  let results: IdlixSearchItem[] = [];
  try {
    const res = await client.search(query);
    results = res.results || [];
    s.stop(pc.green(`Ditemukan ${results.length} hasil!`));
  } catch (err: any) {
    s.stop(pc.red('Gagal melakukan pencarian'));
    p.note(err?.message || String(err), 'Error');
    return;
  }

  if (results.length === 0) {
    p.note(`Tidak ditemukan konten untuk "${query}". Coba kata kunci lain.`, 'Info');
    return;
  }

  const selectedItem = await p.select({
    message: 'Pilih film atau serial yang ingin ditonton:',
    options: results.map(item => ({
      value: item,
      label: `${item.contentType === 'movie' ? '🎬' : '📺'} ${item.title}`,
      hint: `${item.releaseDate ? item.releaseDate.slice(0, 4) + ' | ' : ''}slug: ${item.slug}`,
    })),
  });

  if (p.isCancel(selectedItem)) return;

  await processMediaSelection(selectedItem as IdlixSearchItem);
}

async function handleDirectFlow() {
  const slug = await p.text({
    message: 'Masukkan slug film IDLIX:',
    placeholder: 'sin-city-2005',
    validate: v => (!v || !v.trim() ? 'Slug tidak boleh kosong!' : undefined),
  });

  if (p.isCancel(slug)) return;

  await resolveAndWatch('movie', slug.trim(), slug.trim());
}

async function processMediaSelection(item: IdlixSearchItem) {
  if (item.contentType === 'movie') {
    await resolveAndWatch('movie', item.slug, item.title);
  } else {
    // TV Series flow
    const s = p.spinner();
    s.start(pc.cyan(`Memuat daftar episode untuk "${item.title}"...`));

    try {
      const seriesDetail = await client.getSeries(item.slug);
      s.stop(pc.green(`Ditemukan ${seriesDetail.seasons?.length || 0} Season.`));

      if (!seriesDetail.seasons || seriesDetail.seasons.length === 0) {
        p.note('Serial ini belum memiliki episode yang tersedia.', 'Info');
        return;
      }

      const selectedSeason = await p.select({
        message: 'Pilih Season:',
        options: seriesDetail.seasons.map(season => ({
          value: season,
          label: `Season ${season.seasonNumber}`,
          hint: `${season.episodes?.length || 0} episode`,
        })),
      });

      if (p.isCancel(selectedSeason)) return;

      const seasonObj = selectedSeason as any;
      if (!seasonObj.episodes || seasonObj.episodes.length === 0) {
        // Fallback to resolve by series slug directly
        await resolveAndWatch('series', item.slug, `${item.title} S${seasonObj.seasonNumber}`);
        return;
      }

      const selectedEpisode = await p.select({
        message: 'Pilih Episode:',
        options: seasonObj.episodes.map((ep: any) => ({
          value: ep,
          label: `Episode ${ep.episodeNumber}: ${ep.title || 'Episode ' + ep.episodeNumber}`,
          hint: ep.airDate || '',
        })),
      });

      if (p.isCancel(selectedEpisode)) return;

      const epObj = selectedEpisode as any;
      await resolveAndWatch(
        'series',
        epObj.id || item.slug,
        `${item.title} - S${seasonObj.seasonNumber}E${epObj.episodeNumber}`
      );
    } catch (err: any) {
      s.stop(pc.red('Gagal memuat serial'));
      p.note(err?.message || String(err), 'Error');
    }
  }
}

async function resolveAndWatch(type: 'movie' | 'series', slugOrId: string, displayTitle: string) {
  const s = p.spinner();
  s.start(pc.cyan(`Membuka kunci sesi stream IDLIX untuk "${displayTitle}"...`));

  let stream: ResolvedStream;
  try {
    if (type === 'movie') {
      stream = await client.resolveMovie(slugOrId, {
        onCountdown: sec => {
          if (sec > 0) {
            s.message(pc.yellow(`⏳ Melewati Gate Countdown IDLIX... [${sec} detik tersisa]`));
          } else {
            s.message(pc.cyan(`🔑 Mengklaim sesi & mengambil link HLS...`));
          }
        },
      });
    } else {
      // Series resolve
      stream = await client.resolveEpisode(slugOrId, 1, 1, {
        onCountdown: sec => {
          if (sec > 0) {
            s.message(pc.yellow(`⏳ Melewati Gate Countdown IDLIX... [${sec} detik tersisa]`));
          } else {
            s.message(pc.cyan(`🔑 Mengklaim sesi & mengambil link HLS...`));
          }
        },
      });
    }
    s.stop(pc.green(`🎉 Stream berhasil didapatkan!`));
  } catch (err: any) {
    s.stop(pc.red('Gagal mendapatkan stream'));
    p.note(err?.message || String(err), 'Error');
    return;
  }

  // Detect players
  const availablePlayers = await detectPlayers();
  const playerChoices = availablePlayers.map(pl => ({
    value: pl.id,
    label: pl.isAvailable ? pc.green(`▶️  ${pl.name}`) : pc.dim(`❌ ${pl.name} (Tidak terdeteksi)`),
    hint: pl.path ? `Path: ${pl.path}` : undefined,
  }));

  // Auto-filter or prioritize available
  const chosenPlayerId = await p.select({
    message: 'Pilih aplikasi untuk langsung memutar video:',
    options: playerChoices,
    initialValue: availablePlayers.find(p => p.isAvailable)?.id || 'browser',
  });

  if (p.isCancel(chosenPlayerId)) return;

  const defaultSub = stream.subtitles.find(sub => sub.isDefault) || stream.subtitles[0];

  p.note(
    `Judul:     ${stream.title}
Playlist:  ${stream.playlistUrl}
Subtitle:  ${defaultSub ? `${defaultSub.label} (${defaultSub.lang})` : 'Tidak tersedia'}
Player:    ${chosenPlayerId.toString().toUpperCase()}`,
    'Informasi Putar Video'
  );

  const localServer = await startLocalPlayerServer(stream);

  try {
    p.log.info(pc.cyan(`🚀 Meluncurkan pemutar video... Nikmati tontonan Anda!`));
    await launchPlayer(chosenPlayerId as any, stream, localServer.port);
    p.log.success(pc.green(`Sedang memutar... Tekan tombol apapun untuk kembali ke menu.`));
  } catch (err: any) {
    p.log.error(pc.red(`Gagal meluncurkan pemutar: ${err?.message || err}`));
    p.log.info(pc.yellow(`Membuka pemutar web browser sebagai alternatif...`));
    await launchPlayer('browser', stream, localServer.port);
  }

  // Keep local server alive for the user
  await p.text({
    message: pc.dim('Ketik enter untuk kembali ke menu utama IDLIX...'),
    placeholder: 'Enter',
  });

  localServer.close();
}

// Direct execution
startTUI().catch(err => {
  console.error(pc.red('\nFatal error:'), err);
  process.exit(1);
});

