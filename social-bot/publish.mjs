#!/usr/bin/env node
// Публикация в Instagram и Threads по очереди social-bot/queue.json (официальные API Meta).
//
//   node social-bot/publish.mjs check     — проверить, что токен и аккаунт работают (ничего не публикует)
//   node social-bot/publish.mjs dry-run   — показать, что вышло бы в эфир сейчас (ничего не публикует)
//   node social-bot/publish.mjs publish   — опубликовать всё, что пора (режим по умолчанию)
//
// Секреты берутся только из переменных окружения INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID
// и THREADS_ACCESS_TOKEN (необязательный: без него записи для Threads просто ждут).
// Токены не печатаются в логах и не попадают в файлы.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SITE = 'https://artega909-del.github.io';
const DEFAULT_QUEUE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'queue.json');
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const isVideo = u => /\.(mp4|mov)(\?|#|$)/i.test(u);

// Файл из репозитория (assets/x.mp4) → публичная ссылка на GitHub Pages; готовую https-ссылку оставляем как есть.
export function mediaUrl(media, site = SITE) {
  if (/^https:\/\//i.test(media)) return media;
  return site + '/' + String(media).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}

// Проверка записи очереди. Возвращает список проблем (пустой — всё в порядке).
export function validate(item) {
  const errs = [];
  if (!item.id) errs.push('нет id');
  const threads = item.platform === 'threads';
  if (item.platform !== 'instagram' && !threads) errs.push(`платформа «${item.platform}» пока не поддерживается`);
  const types = threads ? ['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL'] : ['REELS', 'IMAGE', 'CAROUSEL', 'STORY'];
  if (!types.includes(item.type)) errs.push(`type должен быть ${types.slice(0, -1).join(', ')} или ${types.at(-1)}${threads ? ' (для Threads)' : ''}`);
  const checkOne = media => {
    if (typeof media !== 'string' || !media) { errs.push('не указан media'); return; }
    const isHttps = /^https:\/\//i.test(media);
    if (!isHttps && (/^[a-z][a-z0-9+.-]*:/i.test(media) || media.split('/').includes('..'))) {
      errs.push('media: путь внутри репозитория (assets/…) или ссылка https://');
    }
    if (threads) {
      if (item.type === 'IMAGE' && !/\.(jpe?g|png)(\?|#|$)/i.test(media)) errs.push('для IMAGE в Threads нужен JPEG или PNG');
      if (item.type === 'VIDEO' && !isVideo(media)) errs.push('для VIDEO нужен файл .mp4 или .mov');
      if (item.type === 'CAROUSEL' && !/\.(jpe?g|png|mp4|mov)(\?|#|$)/i.test(media)) errs.push('в карусели Threads — JPEG, PNG или видео .mp4/.mov');
      return;
    }
    if (item.type === 'REELS' && !isVideo(media)) errs.push('для REELS нужен файл .mp4 или .mov');
    if (item.type === 'STORY' && !/\.(jpe?g|mp4|mov)(\?|#|$)/i.test(media)) errs.push('для STORY нужен JPEG (.jpg) или видео .mp4/.mov');
    if (!['REELS', 'STORY'].includes(item.type) && !/\.jpe?g(\?|#|$)/i.test(media)) errs.push(`для ${item.type} нужен JPEG (.jpg)`);
  };
  const maxSlides = threads ? 20 : 10;
  if (item.type === 'CAROUSEL') {
    if (!Array.isArray(item.media) || item.media.length < 2 || item.media.length > maxSlides) errs.push(`для CAROUSEL media — список из 2–${maxSlides} ${threads ? 'файлов' : 'картинок'}`);
    else item.media.forEach(checkOne);
  } else if (threads && item.type === 'TEXT') {
    if (item.media !== undefined) errs.push('у TEXT нет media: для поста с файлом укажите type IMAGE, VIDEO или CAROUSEL');
  } else checkOne(item.media);
  const caption = item.caption ?? '';
  if (typeof caption !== 'string') errs.push('caption должен быть текстом');
  else if (threads) {
    if ([...caption].length > 500) errs.push('текст для Threads длиннее 500 символов');
    if (item.type === 'TEXT' && !caption.trim()) errs.push('у TEXT должен быть текст в caption');
  } else {
    if ([...caption].length > 2200) errs.push('подпись длиннее 2200 символов');
    if ((caption.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) errs.push('больше 30 хештегов');
  }
  if (item.link !== undefined) {
    if (!threads || item.type !== 'TEXT') errs.push('link (ссылка с превью) бывает только у текстового поста Threads');
    else if (typeof item.link !== 'string' || !/^https:\/\/\S+$/i.test(item.link)) errs.push('link: ссылка вида https://…');
  }
  if (Number.isNaN(Date.parse(item.publish_at))) errs.push('publish_at: время вида 2026-12-01T09:00:00Z');
  if (item.cover_ms !== undefined && !(Number.isInteger(item.cover_ms) && item.cover_ms >= 0)) errs.push('cover_ms: целое число миллисекунд от начала видео (кадр-обложка)');
  if (item.cover_ms !== undefined && item.type !== 'REELS') errs.push('cover_ms бывает только у REELS');
  return errs;
}

function graphClient({ fetchFn, token, host = 'https://graph.facebook.com', version, name = 'Instagram' }) {
  const redact = s => String(s).split(token).join('***');
  // noVersion — для адресов без версии API (продление токена Threads)
  async function call(method, pathname, params = {}, { noVersion = false } = {}) {
    const body = new URLSearchParams({ ...params, access_token: token });
    let url = host + (noVersion ? '' : '/' + version) + pathname;
    let init;
    if (method === 'GET') { url += '?' + body; init = { method }; }
    else init = { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body };
    let res;
    try { res = await fetchFn(url, init); }
    catch (e) { throw new Error(redact(`нет связи с ${name} API: ` + (e && e.message))); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const e = data.error || {};
      const code = e.code ? ` (код ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})` : '';
      throw new Error(redact(`${name} API ${res.status}: ${e.message || 'ошибка'}${code}`));
    }
    return data;
  }
  return { call, redact, token };
}

// Проверка, что все файлы поста доступны по публичной ссылке. bad — первый недоступный файл.
async function checkFiles(item, ctx) {
  if (item.media === undefined) return { urls: [], bad: null, text: 'текст без файла' };
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
      const st = await api.call('GET', `/${id}`, { fields: 'status_code,status' });
      if (st.status_code === 'FINISHED') return;
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error('Instagram не смог обработать файл: ' + st.status_code + (st.status && st.status !== st.status_code ? ' — ' + st.status : ''));
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
  if (item.type === 'STORY') { // история: картинка или видео 9:16, подписи у историй нет
    delete params.caption; params.media_type = 'STORIES';
    if (/\.(mp4|mov)(\?|#|$)/i.test(url)) params.video_url = url; else params.image_url = url;
  } else if (item.type === 'REELS') {
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

// Threads: порядок тот же, что у Instagram, — контейнер → ожидание обработки → публикация.
async function threadsUser(ctx) {
  if (!ctx.threadsMe) ctx.threadsMe = await ctx.threads.call('GET', '/me', { fields: 'id,username' });
  return ctx.threadsMe;
}

async function publishThreads(item, ctx) {
  const api = ctx.threads;
  const files = await checkFiles(item, ctx);
  if (files.bad) return { skipped: `файл пока не доступен по ссылке (${files.bad.status}): ${files.bad.url}` };
  const uid = (await threadsUser(ctx)).id;
  const waitReady = async id => {
    for (let i = 0; ; i++) {
      const st = await api.call('GET', `/${id}`, { fields: 'status,error_message' });
      if (st.status === 'FINISHED' || st.status === 'PUBLISHED') return;
      if (st.status === 'ERROR' || st.status === 'EXPIRED') throw new Error('Threads не смог обработать файл: ' + st.status + (st.error_message ? ' — ' + st.error_message : ''));
      if (i >= ctx.maxPolls) throw new Error('Threads слишком долго обрабатывает файл');
      await ctx.sleep(ctx.pollMs);
    }
  };

  // Защита от повторной публикации — по тексту среди последних постов (как у Instagram по подписи).
  const text = (item.caption || '').trim();
  if (text && !item.repeat) {
    try {
      const recent = await api.call('GET', `/${uid}/threads`, { fields: 'id,text,permalink', limit: '25' });
      const same = (recent.data || []).find(m => (m.text || '').trim() === text);
      if (same) return { media_id: same.id, permalink: same.permalink || null, duplicate: true };
    } catch (e) { ctx.log(`⚠️  ${item.id}: не удалось проверить последние посты Threads на повтор (${e.message}), публикую`); }
  }

  const one = u => (isVideo(u) ? { media_type: 'VIDEO', video_url: u } : { media_type: 'IMAGE', image_url: u });
  let params;
  if (item.type === 'TEXT') {
    params = { media_type: 'TEXT', text };
    if (item.link) params.link_attachment = item.link;
  } else if (item.type === 'CAROUSEL') {
    const children = [];
    for (const u of files.urls) {
      const child = await api.call('POST', `/${uid}/threads`, { ...one(u), is_carousel_item: 'true' });
      await waitReady(child.id); children.push(child.id);
    }
    params = { media_type: 'CAROUSEL', children: children.join(','), text };
  } else params = { ...one(files.urls[0]), text };

  const created = await api.call('POST', `/${uid}/threads`, params);
  if (item.type !== 'TEXT') await waitReady(created.id); // тексту обработка не нужна
  const pub = await api.call('POST', `/${uid}/threads_publish`, { creation_id: created.id });
  let permalink = null;
  try { permalink = (await api.call('GET', `/${pub.id}`, { fields: 'permalink' })).permalink || null; } catch { /* ссылка не обязательна */ }
  return { media_id: pub.id, permalink };
}

// Токен Threads живёт 60 дней. Пока он действует, его можно продлевать запросом — бот делает это сам.
// Возвращает, сколько дней осталось (null — узнать не удалось), и предупреждение, если пора действовать вручную.
async function threadsTokenCare({ api, log, now, renew }) {
  let left = null;
  try {
    const d = (await api.call('GET', '/debug_token', { input_token: api.token })).data || {};
    if (d.expires_at) left = (d.expires_at * 1000 - now()) / DAY;
  } catch { /* срок узнаем из ответа на продление */ }
  if (renew && (left === null || left < 45)) {
    try {
      const r = await api.call('GET', '/refresh_access_token', { grant_type: 'th_refresh_token' }, { noVersion: true });
      if (r.access_token === api.token) {
        if (r.expires_in) left = r.expires_in / 86400;
        log(`Токен Threads продлён${left !== null ? `, действует ещё ${Math.floor(left)} дн.` : ''}`);
      } else if (r.access_token) {
        log('⚠️  Threads выдал при продлении другой токен. Бот не может сам записать его в секреты: срок текущего токена не изменился.');
      }
    } catch (e) { if (left === null || left < 20) log('⚠️  продлить токен Threads не удалось: ' + e.message); }
  }
  const warning = left !== null && left < 10
    ? `токен Threads истекает через ${Math.max(0, Math.floor(left))} дн.: выпустите новый и обновите секрет THREADS_ACCESS_TOKEN` : null;
  if (warning) log('⚠️  ' + warning);
  return { left, warning };
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
  const thToken = (env.THREADS_ACCESS_TOKEN || '').trim();
  const threads = thToken ? graphClient({ fetchFn, token: thToken, host: 'https://graph.threads.net', version: env.THREADS_VERSION || 'v1.0', name: 'Threads' }) : null;
  const redact = s => [api, threads].filter(Boolean).reduce((t, a) => a.redact(t), s);
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
    let threadsUsername = null;
    if (!threads) log('Threads: секрет THREADS_ACCESS_TOKEN не задан — публикация в Threads выключена');
    else {
      let me;
      try { me = await threads.call('GET', '/me', { fields: 'id,username' }); }
      catch (e) {
        log('❌ Threads: ' + e.message);
        log('Что проверить: 1) в секрете THREADS_ACCESS_TOKEN лежит токен Threads (из раздела «Доступ к Threads API» приложения), а не токен Instagram;');
        log('2) аккаунт Threads добавлен в приложение как тестировщик, и приглашение принято в настройках Threads;');
        log('3) токену выданы разрешения threads_basic и threads_content_publish; 4) токен не старше 60 дней.');
        throw new Error('проверка доступа к Threads не пройдена, подсказки выше');
      }
      threadsUsername = me.username;
      log(`Threads: доступ есть: @${me.username}`);
      const { left } = await threadsTokenCare({ api: threads, log, now, renew: false });
      log(left === null ? 'Threads: срок токена узнать не удалось' : `Threads: токен действует ещё ${Math.floor(left)} дн. (бот продлевает его сам при публикациях)`);
      try {
        await threads.call('GET', `/${me.id}/threads`, { fields: 'id', limit: '1' });
        log('Threads: чтение последних постов работает (защита от повтора)');
      } catch (e) { log('⚠️  Threads: не удалось прочитать последние посты, защита от повтора не сработает: ' + e.message); }
    }
    return { ok: true, username: acc.username, threadsUsername, ...summary };
  }

  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  const posts = Array.isArray(queue.posts) ? queue.posts : [];
  const maxPerRun = Number(env.MAX_PER_RUN) || 3;
  const maxLate = (Number(env.MAX_LATE_HOURS) || 48) * HOUR;
  const save = () => writeFile(queuePath, JSON.stringify(queue, null, 2) + '\n');
  // ожидание обработки видео: до ~5 минут на пост (3 поста × 5 мин укладываются в лимит задания)
  const ctx = { api, threads, igId, fetchFn, sleep, log, site: env.SITE_URL || SITE, pollMs: Number(env.POLL_MS) || 5000, maxPolls: Number(env.MAX_POLLS) || 60 };

  if (threads && mode === 'publish') { // продление токена Threads и предупреждение, если он скоро истечёт
    const care = await threadsTokenCare({ api: threads, log, now, renew: true });
    if (care.warning) summary.warnings = [care.warning];
  }
  let noThreadsSaid = false;
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
    if (item.platform === 'threads' && !threads) { // Threads ещё не подключён: запись ждёт, остальные публикуются
      summary.skipped.push(item.id);
      if (!noThreadsSaid) log(`⏳ ${item.id}: секрет THREADS_ACCESS_TOKEN не задан, записи для Threads ждут`);
      noThreadsSaid = true;
      continue;
    }
    if (done >= maxPerRun) { summary.waiting.push(item.id); continue; }

    if (mode === 'dry-run') {
      log(`🔎 вышло бы: ${item.id} (${item.platform === 'threads' ? 'Threads, ' : ''}${item.type}) → ${(await checkFiles(item, ctx)).text}`);
      done++;
      continue;
    }

    try {
      const r = await (item.platform === 'threads' ? publishThreads(item, ctx) : publishOne(item, ctx));
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
      item.error = redact(e.message);
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
