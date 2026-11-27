// Работа с уже загруженными видео канала YouTube.
//   node social-bot/yt-channel.mjs report [main|en]  — собрать список видео и превью в папку yt-report/
//   node social-bot/yt-channel.mjs apply  [main|en]  — применить правки из social-bot/yt-edits.json
// Отчёт может содержать видео с доступом по ссылке и приватные, поэтому workflow его шифрует
// (social-bot/report-pub.pem) — в публичный лог и репозиторий попадает только шифр.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ytClient } from './publish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(...a);

function clientFor(account, env, fetchFn) {
  const sfx = account === 'main' ? '' : '_' + account.toUpperCase();
  const rt = (env['YOUTUBE_REFRESH_TOKEN' + sfx] || '').trim();
  const id = (env.YOUTUBE_CLIENT_ID || '').trim(); const sec = (env.YOUTUBE_CLIENT_SECRET || '').trim();
  if (!rt || !id || !sec) throw new Error(`не заданы секреты YouTube для аккаунта ${account}`);
  return ytClient({ fetchFn, clientId: id, clientSecret: sec, refreshToken: rt });
}

async function listVideos(yt) {
  const ch = await yt.get('/channels', { part: 'snippet,contentDetails', mine: 'true' });
  const c = ch.items && ch.items[0]; if (!c) throw new Error('канал не найден');
  const ids = []; let pageToken = '';
  do {
    const p = await yt.get('/playlistItems', { part: 'contentDetails', playlistId: c.contentDetails.relatedPlaylists.uploads, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    for (const it of p.items || []) ids.push(it.contentDetails.videoId);
    pageToken = p.nextPageToken || '';
  } while (pageToken);
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await yt.get('/videos', { part: 'snippet,contentDetails,status,statistics', id: ids.slice(i, i + 50).join(',') });
    videos.push(...(v.items || []));
  }
  return { channel: { id: c.id, title: c.snippet.title, description: c.snippet.description }, videos };
}

export async function report({ account = 'main', env = process.env, fetchFn = fetch, outDir = path.join(ROOT, 'yt-report') } = {}) {
  const yt = clientFor(account, env, fetchFn);
  const { channel, videos } = await listVideos(yt);
  await mkdir(path.join(outDir, 'img'), { recursive: true });
  const rows = [];
  for (const v of videos) {
    const s = v.snippet;
    rows.push({ id: v.id, title: s.title, description: s.description, tags: s.tags || [], categoryId: s.categoryId,
      defaultLanguage: s.defaultLanguage || '', defaultAudioLanguage: s.defaultAudioLanguage || '', publishedAt: s.publishedAt,
      duration: v.contentDetails.duration, privacy: v.status.privacyStatus, madeForKids: v.status.madeForKids,
      views: v.statistics && v.statistics.viewCount, thumbs: Object.keys(s.thumbnails || {}) });
    // текущее превью и три кадра, которые YouTube берёт из 25/50/75 % ролика
    for (const name of ['hqdefault', 'hq1', 'hq2', 'hq3']) {
      try {
        const r = await fetchFn(`https://i.ytimg.com/vi/${v.id}/${name}.jpg`);
        if (r.ok) await writeFile(path.join(outDir, 'img', `${v.id}-${name}.jpg`), Buffer.from(await r.arrayBuffer()));
      } catch { /* превью необязательно */ }
    }
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ account, channel, videos: rows }, null, 2));
  log(`Канал «${channel.title}»: видео ${rows.length} (публичных ${rows.filter(r => r.privacy === 'public').length}). Отчёт собран.`);
  return rows;
}

// yt-edits.json: [{ "account": "main", "id": "<videoId>", "title": "...", "description": "...", "tags": [...],
//   "categoryId": "22", "defaultLanguage": "ru", "thumbnail": "assets/...jpg", "privacy": "public" }]
// Поля, которых нет в записи, остаются как были. Применённые записи помечаются "applied".
export async function apply({ account = 'main', env = process.env, fetchFn = fetch, file = path.join(ROOT, 'social-bot', 'yt-edits.json'), repoRoot = ROOT } = {}) {
  const edits = JSON.parse(await readFile(file, 'utf8'));
  const todo = edits.filter(e => (e.account || 'main') === account && !e.applied);
  if (!todo.length) { log('Правок для применения нет.'); return []; }
  const yt = clientFor(account, env, fetchFn); const token = await yt.token();
  const done = [];
  for (const e of todo) {
    try {
      if (e.title && (e.title.length > 100 || /[<>]/.test(e.title))) throw new Error('название длиннее 100 знаков или содержит < >');
      if (e.description && e.description.length > 5000) throw new Error('описание длиннее 5000 знаков');
      const cur = await yt.get('/videos', { part: 'snippet,status', id: e.id });
      const v = cur.items && cur.items[0]; if (!v) throw new Error('видео не найдено на канале');
      const sn = v.snippet;
      const snippet = { title: e.title || sn.title, description: e.description ?? sn.description, tags: e.tags || sn.tags || [],
        categoryId: e.categoryId || sn.categoryId, defaultLanguage: e.defaultLanguage || sn.defaultLanguage, defaultAudioLanguage: e.defaultAudioLanguage || sn.defaultAudioLanguage };
      Object.keys(snippet).forEach(k => snippet[k] === undefined && delete snippet[k]);
      const body = { id: e.id, snippet };
      let parts = 'snippet';
      if (e.privacy) { body.status = { privacyStatus: e.privacy, selfDeclaredMadeForKids: v.status.selfDeclaredMadeForKids ?? false }; parts += ',status'; }
      await yt.json(await fetchFn('https://www.googleapis.com/youtube/v3/videos?part=' + parts, {
        method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }), 'правка видео');
      if (e.thumbnail) {
        const img = await readFile(path.join(repoRoot, e.thumbnail));
        await yt.json(await fetchFn(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${e.id}&uploadType=media`, {
          method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'image/jpeg' }, body: img }), 'превью');
      }
      e.applied = new Date().toISOString(); delete e.error; done.push(e.id);
      log(`✅ ${e.id}: «${snippet.title}»` + (e.thumbnail ? ' + превью' : ''));
    } catch (err) {
      e.error = yt.redact(err.message); log(`❌ ${e.id}: ${e.error}`);
    }
  }
  await writeFile(file, JSON.stringify(edits, null, 2) + '\n');
  if (done.length < todo.length) process.exitCode = 1;
  return done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, account = 'main'] = process.argv.slice(2);
  const fn = cmd === 'report' ? report : cmd === 'apply' ? apply : null;
  if (!fn) { console.error('Использование: yt-channel.mjs report|apply [main|en]'); process.exitCode = 2; }
  else fn({ account }).catch(e => { console.error('Ошибка: ' + e.message); process.exitCode = 1; });
}
