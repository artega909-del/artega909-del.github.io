// TikTok: загрузка видео черновиком во «Входящие» автора (Content Posting API, режим Upload, scope video.upload).
// Автор открывает уведомление в TikTok, при желании добавляет звук и нажимает «Опубликовать».
//
// Токен. Доступ живёт 2 часа, ключ обновления — 180 дней и меняется при каждом обновлении
// (старый сразу перестаёт работать). GitHub Secrets бот перезаписать не может, поэтому токены хранятся
// в репозитории в файле social-bot/tiktok-token[-en].json, зашифрованные AES-256-GCM ключом,
// который выводится из секрета TIKTOK_CLIENT_SECRET. Без секрета файл бесполезен.
//
//   node social-bot/tiktok.mjs auth [main|en]   — обменять код со страницы tiktok-callback.html (env TIKTOK_CODE) на токены
import { readFile, writeFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://open.tiktokapis.com';
export const REDIRECT_URI = 'https://artega909-del.github.io/tiktok-callback.html';
export const tokenFile = (account = 'main', root = ROOT) => path.join(root, 'social-bot', account === 'main' ? 'tiktok-token.json' : `tiktok-token-${account}.json`);

const keyFrom = secret => createHash('sha256').update('salam-social-bot/tiktok-token/v1:' + secret).digest();
export function seal(obj, secret) {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function unseal(box, secret) {
  const d = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
}

// Клиент одного аккаунта TikTok. state — расшифрованные токены; save() пишет их обратно в файл.
export function ttClient({ fetchFn, clientKey, clientSecret, file, now = () => Date.now() }) {
  let state = null;
  const secrets = () => [clientSecret, state && state.access_token, state && state.refresh_token].filter(Boolean);
  const redact = s => secrets().reduce((t, x) => t.split(x).join('***'), String(s));
  async function load() {
    if (state) return state;
    let box;
    try { box = JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
    try { state = unseal(box, clientSecret); } catch { throw new Error('файл токена TikTok не расшифровывается: секрет TIKTOK_CLIENT_SECRET сменили? Подключите TikTok заново'); }
    return state;
  }
  const save = () => writeFile(file, JSON.stringify(seal(state, clientSecret), null, 2) + '\n');
  async function oauth(params) {
    const res = await fetchFn(API + '/v2/oauth/token/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
      body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, ...params }).toString() });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.error || !d.access_token) throw new Error(redact(`TikTok вход ${res.status}: ${d.error_description || d.error || 'нет токена в ответе'}`));
    state = { access_token: d.access_token, access_expires_at: now() + (d.expires_in || 7200) * 1000, refresh_token: d.refresh_token,
      refresh_expires_at: now() + (d.refresh_expires_in || 15552000) * 1000, open_id: d.open_id, scope: d.scope };
    await save(); // ключ обновления уже сменился — сохраняем сразу, до любых других запросов
    return state;
  }
  async function token() {
    const s = await load();
    if (!s) throw new Error('TikTok не подключён: нет файла токена');
    if (s.access_expires_at - now() > 10 * 60e3) return s.access_token;
    if (s.refresh_expires_at <= now()) throw new Error('ключ обновления TikTok истёк (180 дней): подключите TikTok заново');
    return (await oauth({ grant_type: 'refresh_token', refresh_token: s.refresh_token })).access_token;
  }
  async function call(pathname, body, method = 'POST') {
    const res = await fetchFn(API + pathname, { method, headers: { authorization: 'Bearer ' + await token(), ...(body ? { 'content-type': 'application/json; charset=UTF-8' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const d = await res.json().catch(() => ({}));
    const e = d.error || {};
    if (!res.ok || (e.code && e.code !== 'ok')) throw new Error(redact(`TikTok API ${res.status}: ${e.code || ''}${e.message ? ' — ' + e.message : ''}`));
    return d.data || {};
  }
  return { load, token, call, oauth, redact, get state() { return state; } };
}

// Размеры частей по правилам TikTok: до 64 МБ — одним куском; больше — куски по 10 МБ, остаток уходит в последний.
export function chunksFor(size) {
  const MB = 1024 * 1024;
  if (size <= 64 * MB) return { chunk: size, count: 1 };
  const chunk = 10 * MB; return { chunk, count: Math.floor(size / chunk) };
}

export async function publishTikTok(item, ctx) {
  const tt = ctx.tt;
  let bytes = null;
  if (!/^https:\/\//i.test(item.media)) bytes = await readFile(path.join(ctx.repoRoot, item.media)).catch(() => null);
  if (!bytes) { const r = await ctx.fetchFn(item.media); if (!r.ok) throw new Error(`не удалось получить видео (${r.status})`); bytes = Buffer.from(await r.arrayBuffer()); }
  const { chunk, count } = chunksFor(bytes.length);
  const init = await tt.call('/v2/post/publish/inbox/video/init/', { source_info: { source: 'FILE_UPLOAD', video_size: bytes.length, chunk_size: chunk, total_chunk_count: count } });
  if (!init.upload_url || !init.publish_id) throw new Error('TikTok не вернул адрес загрузки');
  for (let i = 0; i < count; i++) {
    const a = i * chunk, b = i === count - 1 ? bytes.length : a + chunk;
    const r = await ctx.fetchFn(init.upload_url, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(b - a), 'content-range': `bytes ${a}-${b - 1}/${bytes.length}` }, body: bytes.subarray(a, b) });
    if (![200, 201, 206].includes(r.status)) throw new Error(`TikTok не принял часть файла ${i + 1}/${count} (${r.status})`);
  }
  let st = {};
  for (let i = 0; i < (ctx.maxPolls || 60); i++) { // TikTok обрабатывает файл и кладёт черновик во «Входящие»
    st = await tt.call('/v2/post/publish/status/fetch/', { publish_id: init.publish_id });
    if (['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE'].includes(st.status)) break;
    if (st.status === 'FAILED') throw new Error(`TikTok не обработал видео: ${st.fail_reason || 'причина не указана'}`);
    await ctx.sleep(ctx.pollMs || 5000);
  }
  if (!['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE'].includes(st.status)) throw new Error(`TikTok долго обрабатывает видео (статус ${st.status || 'нет'}), проверьте «Входящие» TikTok позже`);
  return { media_id: init.publish_id, permalink: null, note: 'черновик во «Входящих» TikTok: откройте уведомление, вставьте подпись из caption и нажмите «Опубликовать»' };
}

export function validateTikTok(item, errs) {
  if (item.type !== 'DRAFT') errs.push('для TikTok type должен быть DRAFT (черновик во «Входящие»)');
  if (typeof item.media !== 'string' || !/\.(mp4|mov)$/i.test(item.media)) errs.push('для TikTok нужен один файл .mp4 или .mov');
  else if (!/^https:\/\//i.test(item.media) && (/^[a-z][a-z0-9+.-]*:/i.test(item.media) || item.media.split('/').includes('..'))) errs.push('media: путь внутри репозитория (assets/…) или ссылка https://');
  if (typeof (item.caption ?? '') !== 'string' || [...(item.caption || '')].length > 2200) errs.push('подпись TikTok: до 2200 символов');
  if (item.account !== undefined && !/^[a-z]{2,10}$/.test(item.account)) errs.push('account: короткое имя аккаунта латиницей, например en');
  if (Number.isNaN(Date.parse(item.publish_at))) errs.push('publish_at: время вида 2026-12-01T09:00:00Z');
  return errs;
}

// Обмен кода со страницы tiktok-callback.html на токены (запускается workflow «TikTok — подключение»).
export async function auth({ account = 'main', env = process.env, fetchFn = fetch, root = ROOT, log = console.log } = {}) {
  const clientKey = (env.TIKTOK_CLIENT_KEY || '').trim(), clientSecret = (env.TIKTOK_CLIENT_SECRET || '').trim();
  const raw = (env.TIKTOK_CODE || '').trim();
  const code = /%[0-9a-f]{2}/i.test(raw) ? decodeURIComponent(raw) : raw; // код могли скопировать прямо из адресной строки
  if (!clientKey || !clientSecret) throw new Error('не заданы секреты TIKTOK_CLIENT_KEY и TIKTOK_CLIENT_SECRET');
  if (!code) throw new Error('не передан код со страницы подключения');
  const tt = ttClient({ fetchFn, clientKey, clientSecret, file: tokenFile(account, root) });
  const s = await tt.oauth({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  if (!String(s.scope || '').split(',').includes('video.upload')) log('⚠️  TikTok не выдал право video.upload: при входе отметьте все разрешения или добавьте Content Posting API в приложение');
  let name = '';
  try { const u = await tt.call('/v2/user/info/?fields=display_name', null, 'GET'); name = u.user && u.user.display_name; } catch { /* имя необязательно */ }
  log(`TikTok подключён${name ? `: ${name}` : ''}. Ключ обновления действует ${Math.floor((s.refresh_expires_at - Date.now()) / 864e5)} дн.`);
  return { name, scope: s.scope };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, account = 'main'] = process.argv.slice(2);
  if (cmd !== 'auth') { console.error('Использование: tiktok.mjs auth [main|en]'); process.exitCode = 2; }
  else auth({ account }).catch(e => { console.error('Ошибка: ' + e.message); process.exitCode = 1; });
}
