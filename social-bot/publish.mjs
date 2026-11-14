#!/usr/bin/env node
// Публикация в Instagram по очереди social-bot/queue.json (Instagram API через Meta Graph).
//
//   node social-bot/publish.mjs check     — проверить, что токен и аккаунт работают (ничего не публикует)
//   node social-bot/publish.mjs dry-run   — показать, что вышло бы в эфир сейчас (ничего не публикует)
//   node social-bot/publish.mjs publish   — опубликовать всё, что пора (режим по умолчанию)
//
// Секреты берутся только из переменных окружения INSTAGRAM_ACCESS_TOKEN и INSTAGRAM_ACCOUNT_ID.
// Токен не печатается в логах и не попадает в файлы.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SITE = 'https://artega909-del.github.io';
const DEFAULT_QUEUE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'queue.json');
const HOUR = 3600e3;

// Файл из репозитория (assets/x.mp4) → публичная ссылка на GitHub Pages; готовую https-ссылку оставляем как есть.
export function mediaUrl(media, site = SITE) {
  if (/^https:\/\//i.test(media)) return media;
  return site + '/' + String(media).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}

// Проверка записи очереди. Возвращает список проблем (пустой — всё в порядке).
export function validate(item) {
  const errs = [];
  if (!item.id) errs.push('нет id');
  if (item.platform !== 'instagram') errs.push(`платформа «${item.platform}» пока не поддерживается`);
  if (!['REELS', 'IMAGE', 'CAROUSEL'].includes(item.type)) errs.push('type должен быть REELS, IMAGE или CAROUSEL');
  const checkOne = media => {
    if (typeof media !== 'string' || !media) { errs.push('не указан media'); return; }
    const isHttps = /^https:\/\//i.test(media);
    if (!isHttps && (/^[a-z][a-z0-9+.-]*:/i.test(media) || media.split('/').includes('..'))) {
      errs.push('media: путь внутри репозитория (assets/…) или ссылка https://');
    }
    if (item.type === 'REELS' && !/\.(mp4|mov)(\?|#|$)/i.test(media)) errs.push('для REELS нужен файл .mp4 или .mov');
    if (item.type !== 'REELS' && !/\.jpe?g(\?|#|$)/i.test(media)) errs.push(`для ${item.type} нужен JPEG (.jpg)`);
  };
  if (item.type === 'CAROUSEL') {
    if (!Array.isArray(item.media) || item.media.length < 2 || item.media.length > 10) errs.push('для CAROUSEL media — список из 2–10 картинок');
    else item.media.forEach(checkOne);
  } else checkOne(item.media);
  const caption = item.caption ?? '';
  if (typeof caption !== 'string') errs.push('caption должен быть текстом');
  else {
    if ([...caption].length > 2200) errs.push('подпись длиннее 2200 символов');
    if ((caption.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) errs.push('больше 30 хештегов');
  }
  if (Number.isNaN(Date.parse(item.publish_at))) errs.push('publish_at: время вида 2026-12-01T09:00:00Z');
  if (item.cover_ms !== undefined && !(Number.isInteger(item.cover_ms) && item.cover_ms >= 0)) errs.push('cover_ms: целое число миллисекунд от начала видео (кадр-обложка)');
  if (item.cover_ms !== undefined && item.type !== 'REELS') errs.push('cover_ms бывает только у REELS');
  return errs;
}

function graphClient({ fetchFn, token, version }) {
  const base = 'https://graph.facebook.com/' + version;
  const redact = s => String(s).split(token).join('***');
  async function call(method, pathname, params = {}) {
    const body = new URLSearchParams({ ...params, access_token: token });
    let url = base + pathname;
    let init;
    if (method === 'GET') { url += '?' + body; init = { method }; }
    else init = { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body };
    let res;
    try { res = await fetchFn(url, init); }
    catch (e) { throw new Error(redact('нет связи с Instagram API: ' + (e && e.message))); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const e = data.error || {};
      const code = e.code ? ` (код ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})` : '';
      throw new Error(redact(`Instagram API ${res.status}: ${e.message || 'ошибка'}${code}`));
    }
    return data;
  }
  return { call, redact, token };
}

// Проверка, что все файлы поста доступны по публичной ссылке. bad — первый недоступный файл.
async function checkFiles(item, ctx) {
  const urls = [].concat(item.media).map(m => mediaUrl(m, ctx.site));
  let bad = null;
  for (const url of urls) {
    const head = await ctx.fetchFn(url, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
    if (!head || !head.ok) { bad = { url, status: head ? head.status : 'нет ответа' }; break; }
  }
  const text = urls.length === 1 ? `${urls[0]} [файл: ${bad ? bad.status : 200}]`
    : `${urls.length} слайдов, ${urls[0]} … [файлы: ${bad ? `${bad.status} — ${bad.url}` : 'все 200'}]`;
  return { urls, bad, text };
}

async function publishOne(item, ctx) {
  const { api, igId, fetchFn, sleep } = ctx;
  // Файлы должны уже быть доступны по ссылке (GitHub Pages обновляется не мгновенно) — иначе ждём следующего запуска.
  const files = await checkFiles(item, ctx);
  if (files.bad) return { skipped: `файл пока не доступен по ссылке (${files.bad.status}): ${files.bad.url}` };
  const url = files.urls[0];
  const waitReady = async id => { // ждём, пока Instagram обработает файл
    for (let i = 0; ; i++) {
      const st = await api.call('GET', `/${id}`, { fields: 'status_code' });
      if (st.status_code === 'FINISHED') return;
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error('Instagram не смог обработать файл: ' + st.status_code);
      if (i >= ctx.maxPolls) throw new Error('Instagram слишком долго обрабатывает файл');
      await sleep(ctx.pollMs);
    }
  };

  // Защита от повторной публикации: если прошлый запуск опубликовал пост, но не успел сохранить статус
  // (сбой, отменённый запуск, конфликт при git push), такой же пост уже есть в аккаунте — второй раз не публикуем.
  const caption = (item.caption || '').trim();
  if (caption && !item.repeat) {
    try {
      const recent = await api.call('GET', `/${igId}/media`, { fields: 'id,caption,permalink', limit: '25' });
      const same = (recent.data || []).find(m => (m.caption || '').trim() === caption);
      if (same) return { media_id: same.id, permalink: same.permalink || null, duplicate: true };
    } catch (e) { ctx.log(`⚠️  ${item.id}: не удалось проверить последние посты на повтор (${e.message}), публикую`); }
  }

  const params = { caption: item.caption || '' };
  if (item.type === 'REELS') {
    params.media_type = 'REELS'; params.video_url = url; params.share_to_feed = 'true';
    if (item.cover_ms !== undefined) params.thumb_offset = String(item.cover_ms);
  } else if (item.type === 'CAROUSEL') { // сначала каждый слайд отдельно, потом общий контейнер
    const children = [];
    for (const u of files.urls) {
      const child = await api.call('POST', `/${igId}/media`, { image_url: u, is_carousel_item: 'true' });
      await waitReady(child.id); children.push(child.id);
    }
    params.media_type = 'CAROUSEL'; params.children = children.join(',');
  } else params.image_url = url;

  const created = await api.call('POST', `/${igId}/media`, params);
  await waitReady(created.id);
  const pub = await api.call('POST', `/${igId}/media_publish`, { creation_id: created.id });
  let permalink = null;
  try { permalink = (await api.call('GET', `/${pub.id}`, { fields: 'permalink' })).permalink || null; } catch { /* ссылка не обязательна */ }
  return { media_id: pub.id, permalink };
}

// Подсказки, если доступ к аккаунту не получен. Секреты не показываем: ID печатается только началом и длиной.
async function diagnose({ api, igId, log }) {
  log(`ID аккаунта в секрете: ${igId.length} цифр, начинается с «${igId.slice(0, 5)}». ID Instagram-аккаунта обычно из 17 цифр и начинается с 17841.`);
  try {
    const me = await api.call('GET', '/me', { fields: 'id,name' });
    log(`Токен принадлежит: ${me.name || '?'} (id ${me.id}). Должен быть системный пользователь salam-bot.`);
  } catch (e) { log('Токен не удалось проверить: ' + e.message); }
  try { // какие именно объекты доступны токену: Meta отдаёт их в granular_scopes (ID аккаунтов не секретны)
    const d = (await api.call('GET', '/debug_token', { input_token: api.token })).data || {};
    log(`Токен: действителен=${d.is_valid}, приложение ${d.app_id}, срок ${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'не истекает'}`);
    const ids = [...new Set((d.granular_scopes || []).filter(s => /^instagram_/.test(s.scope)).flatMap(s => s.target_ids || []))];
    if (!ids.length) log('⚠️  токену не назначен ни один Instagram-аккаунт: назначьте @salammotion пользователю salam-bot (Назначенные объекты) и при необходимости сгенерируйте токен заново');
    else {
      log('Токену доступны Instagram-аккаунты (ID): ' + ids.join(', '));
      log(ids.includes(igId) ? 'ID из секрета есть в этом списке' : '⚠️  ID из секрета НЕ совпадает ни с одним из доступных: исправьте INSTAGRAM_ACCOUNT_ID на один из ID выше');
    }
  } catch (e) { log('Список доступных объектов получить не удалось: ' + e.message); }
  try {
    const p = await api.call('GET', '/me/permissions');
    const granted = (p.data || []).filter(x => x.status === 'granted').map(x => x.permission);
    log('Разрешения токена: ' + (granted.join(', ') || 'нет'));
    for (const need of ['instagram_basic', 'instagram_content_publish']) {
      if (!granted.includes(need)) log(`⚠️  у токена нет разрешения ${need}: сгенерируйте новый токен с этим разрешением`);
    }
  } catch (e) { log('Разрешения прочитать не удалось: ' + e.message); }
  log('Что проверить: 1) Business Settings → Системные пользователи → salam-bot → «Назначенные объекты»: там должен быть @salammotion с управлением контентом;');
  log('2) в секрете INSTAGRAM_ACCOUNT_ID лежит ID именно Instagram-аккаунта (Аккаунты → Аккаунты Instagram), а не приложения или пользователя;');
  log('3) токен создан для приложения Salam Motion Bot.');
}

export async function main({
  mode = 'publish',
  env = process.env,
  fetchFn = globalThis.fetch,
  now = () => Date.now(),
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  queuePath = DEFAULT_QUEUE,
  log = console.log,
} = {}) {
  if (!['check', 'dry-run', 'publish'].includes(mode)) throw new Error(`Неизвестный режим «${mode}». Допустимо: check, dry-run, publish`);
  const missing = ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_ACCOUNT_ID'].filter(k => !(env[k] || '').trim());
  if (missing.length) throw new Error('Не заданы секреты: ' + missing.join(', ') + ' (GitHub → Settings → Secrets and variables → Actions)');
  const token = env.INSTAGRAM_ACCESS_TOKEN.trim();
  const igId = env.INSTAGRAM_ACCOUNT_ID.trim();
  if (!/^\d{4,20}$/.test(igId)) {
    throw new Error(`INSTAGRAM_ACCOUNT_ID должен состоять только из цифр (у Instagram-аккаунта их около 17), а в секрете ${igId.length} символов. ` +
      'Заново скопируйте ID из Business Settings → Аккаунты → Аккаунты Instagram и сохраните секрет без пробелов, переносов строк и лишних чисел.');
  }
  const api = graphClient({ fetchFn, token, version: env.GRAPH_VERSION || 'v23.0' });
  const summary = { published: [], failed: [], missed: [], waiting: [], skipped: [] };

  if (mode === 'check') {
    let acc;
    try { acc = await api.call('GET', `/${igId}`, { fields: 'username' }); }
    catch (e) {
      log('❌ ' + e.message);
      await diagnose({ api, igId, log });
      throw new Error('проверка доступа не пройдена, подсказки выше');
    }
    log(`Доступ есть: @${acc.username}`);
    try { // нужно для защиты от повторной публикации
      const m = await api.call('GET', `/${igId}/media`, { fields: 'id', limit: '1' });
      log(`Чтение последних постов работает (защита от повтора), ${(m.data || []).length ? 'в аккаунте есть посты' : 'постов в аккаунте пока нет'}`);
    } catch (e) { log('⚠️  не удалось прочитать последние посты, защита от повтора не сработает: ' + e.message); }
    return { ok: true, username: acc.username, ...summary };
  }

  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  const posts = Array.isArray(queue.posts) ? queue.posts : [];
  const maxPerRun = Number(env.MAX_PER_RUN) || 3;
  const maxLate = (Number(env.MAX_LATE_HOURS) || 48) * HOUR;
  const save = () => writeFile(queuePath, JSON.stringify(queue, null, 2) + '\n');
  // ожидание обработки видео: до ~5 минут на пост (3 поста × 5 мин укладываются в лимит задания)
  const ctx = { api, igId, fetchFn, sleep, log, site: env.SITE_URL || SITE, pollMs: Number(env.POLL_MS) || 5000, maxPolls: Number(env.MAX_POLLS) || 60 };

  let done = 0;
  for (const item of posts) {
    if (item.status !== 'scheduled') continue;
    const t = Date.parse(item.publish_at);
    if (!Number.isNaN(t) && t > now()) {
      summary.waiting.push(item.id);
      if (mode === 'dry-run') { // предпросмотр будущих постов: запись в порядке? файл уже доступен по ссылке?
        const errs = validate(item);
        log(`⏰ ${item.id}: выйдет после ${item.publish_at}` + (errs.length ? ` ❌ ${errs.join('; ')}` : ` → ${(await checkFiles(item, ctx)).text}`));
      }
      continue;
    }
    if (!Number.isNaN(t) && now() - t > maxLate) {
      summary.missed.push(item.id);
      log(`⏭  ${item.id}: время прошло более ${maxLate / HOUR} ч назад, пропускаю (status → missed)`);
      if (mode === 'publish') { item.status = 'missed'; item.note = 'пропущено: время публикации давно прошло, назначьте новое время и верните status: scheduled'; await save(); }
      continue;
    }
    const errs = validate(item);
    if (errs.length) {
      summary.failed.push(item.id);
      log(`❌ ${item.id}: ${errs.join('; ')}`);
      if (mode === 'publish') { item.status = 'failed'; item.error = errs.join('; '); await save(); }
      continue;
    }
    if (done >= maxPerRun) { summary.waiting.push(item.id); continue; }

    if (mode === 'dry-run') {
      log(`🔎 вышло бы: ${item.id} (${item.type}) → ${(await checkFiles(item, ctx)).text}`);
      done++;
      continue;
    }

    try {
      const r = await publishOne(item, ctx);
      if (r.skipped) { summary.skipped.push(item.id); log(`⏳ ${item.id}: ${r.skipped}`); continue; }
      item.status = 'published';
      item.media_id = r.media_id;
      item.permalink = r.permalink;
      delete item.error;
      if (r.duplicate) {
        item.note = 'уже был в аккаунте (найден по подписи), повторно не публиковался';
        summary.duplicates = [...(summary.duplicates || []), item.id];
        log(`♻️  ${item.id}: такой пост уже есть в аккаунте${r.permalink ? ' → ' + r.permalink : ''}, повторно не публикую`);
      } else {
        item.published_at = new Date(now()).toISOString();
        summary.published.push(item.id);
        log(`✅ ${item.id}: опубликовано${r.permalink ? ' → ' + r.permalink : ''}`);
      }
      done++;
    } catch (e) {
      item.status = 'failed';
      item.error = api.redact(e.message);
      summary.failed.push(item.id);
      log(`❌ ${item.id}: ${item.error}`);
    }
    await save(); // записываем после каждого поста, чтобы не опубликовать дважды при сбое
  }
  log(`Итого: опубликовано ${summary.published.length}, ошибок ${summary.failed.length}, ждут ${summary.waiting.length}, пропущено ${summary.missed.length}, отложено ${summary.skipped.length}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ mode: process.argv[2] || 'publish' })
    .then(s => { if (s.failed && s.failed.length) process.exitCode = 1; })
    .catch(e => { console.error('Ошибка: ' + e.message); process.exitCode = 1; });
}
