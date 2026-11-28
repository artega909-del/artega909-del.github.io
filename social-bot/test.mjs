// Проверка бота без настоящего Instagram: запросы к Graph API и к сайту подменяются.
// Запуск: node social-bot/test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, mediaUrl, validate } from './publish.mjs';

const TOKEN = 'EAAtest-SECRET-token-123';
const env = { INSTAGRAM_ACCESS_TOKEN: TOKEN, INSTAGRAM_ACCOUNT_ID: '1784', POLL_MS: '1' };
const NOW = Date.parse('2026-12-01T10:00:00Z');
const dir = await mkdtemp(path.join(tmpdir(), 'social-bot-'));

// поддельный сервер: handler(method, url, params) → { status, json } ; HEAD → { status }
function fakeFetch(handler, calls = []) {
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = new URL(url);
    const b = init.body;
    const params = method === 'GET' || method === 'HEAD' ? Object.fromEntries(u.searchParams)
      : b instanceof URLSearchParams ? Object.fromEntries(b) : typeof b === 'string' ? (b.startsWith('{') ? JSON.parse(b) : Object.fromEntries(new URLSearchParams(b))) : { bytes: b ? b.length : 0 };
    if (init.headers) params.__headers = init.headers;
    calls.push({ method, url: u.origin + u.pathname, params });
    const r = handler(method, u, params) || { status: 404, json: { error: { message: 'unhandled' } } };
    if (method === 'HEAD') return new Response(null, { status: r.status });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status, headers: r.headers || {} });
  };
}
const post = (over = {}) => ({ id: 'p1', brand: 'salam', platform: 'instagram', type: 'REELS', media: 'assets/demo clip.mp4', caption: 'Привет #ai', publish_at: '2026-12-01T09:00:00Z', status: 'scheduled', ...over });
const writeQueue = async (posts, name = 'q.json') => { const p = path.join(dir, name); await writeFile(p, JSON.stringify({ posts })); return p; };
const readPosts = async p => JSON.parse(await readFile(p, 'utf8')).posts;
const run = (mode, queuePath, fetchFn, extra = {}) => { const logs = []; return main({ mode, env: { ...env, ...extra }, fetchFn, now: () => NOW, sleep: async () => {}, queuePath, log: s => logs.push(s) }).then(s => ({ s, logs })); };

// Instagram, который успешно принимает всё
const okInstagram = (state = { polls: 0 }) => (method, u) => {
  if (method === 'HEAD') return { status: 200 };
  if (u.pathname.endsWith('/1784/media')) return { status: 200, json: { id: 'C1' } };
  if (u.pathname.endsWith('/C1')) return { status: 200, json: { status_code: ++state.polls < 2 ? 'IN_PROGRESS' : 'FINISHED' } };
  if (u.pathname.endsWith('/1784/media_publish')) return { status: 200, json: { id: 'M1' } };
  if (u.pathname.endsWith('/M1')) return { status: 200, json: { permalink: 'https://www.instagram.com/reel/XYZ/' } };
  if (u.pathname.endsWith('/1784')) return { status: 200, json: { username: 'salammotion' } };
};

// 1. адрес файла: путь из репозитория → ссылка GitHub Pages, пробелы и русские буквы кодируются
assert.equal(mediaUrl('assets/demo clip.mp4'), 'https://artega909-del.github.io/assets/demo%20clip.mp4');
assert.equal(mediaUrl('https://cdn.example.com/a.mp4'), 'https://cdn.example.com/a.mp4');
console.log('ok 1 ссылки на файлы');

// 2. проверка записей
assert.deepEqual(validate(post()), []);
assert.ok(validate(post({ type: 'VIDEO' })).some(e => /REELS, IMAGE, CAROUSEL или STORY/.test(e)));
assert.ok(validate(post({ media: 'assets/a.png', type: 'IMAGE' })).some(e => /JPEG/.test(e)));
assert.ok(validate(post({ media: 'http://x.com/a.mp4' })).length > 0, 'http без s не принимается');
assert.ok(validate(post({ media: '../secret.mp4' })).length > 0);
assert.ok(validate(post({ caption: 'я'.repeat(2201) })).some(e => /2200/.test(e)));
assert.ok(validate(post({ caption: Array.from({ length: 31 }, (_, i) => '#t' + i).join(' ') })).some(e => /хештег/.test(e)));
assert.ok(validate(post({ publish_at: 'завтра' })).some(e => /publish_at/.test(e)));
assert.ok(validate(post({ platform: 'x' })).some(e => /не поддерживается/.test(e)));
console.log('ok 2 проверка записей');

// 3. check: токен и аккаунт работают; токен уходит в Graph API, но не в логи
{
  const calls = [];
  const { s, logs } = await run('check', await writeQueue([]), fakeFetch(okInstagram(), calls));
  assert.equal(s.username, 'salammotion');
  assert.match(logs.join('\n'), /@salammotion/);
  assert.ok(!logs.join('\n').includes(TOKEN));
  assert.equal(calls[0].params.access_token, TOKEN);
  assert.ok(!calls.some(c => c.method === 'POST'), 'check ничего не публикует');
  assert.match(logs.join('\n'), /Чтение последних постов работает/);
}
console.log('ok 3 check');

// 3б. check не прошёл (нет доступа к аккаунту) → диагностика: чей токен, какие разрешения; токен и полный ID не печатаются
{
  const h = (m, u) => {
    if (u.pathname.endsWith('/1784')) return { status: 400, json: { error: { message: `Unsupported get request. Object with ID '1784' does not exist ${TOKEN}`, code: 100, error_subcode: 33 } } };
    if (u.pathname.endsWith('/debug_token')) return { status: 200, json: { data: { is_valid: true, app_id: '99', expires_at: 0, granular_scopes: [{ scope: 'instagram_basic', target_ids: ['17841000000000001'] }] } } };
    if (u.pathname.endsWith('/me/permissions')) return { status: 200, json: { data: [{ permission: 'instagram_basic', status: 'granted' }] } };
    if (u.pathname.endsWith('/me')) return { status: 200, json: { id: '6159', name: 'salam-bot' } };
  };
  const logs = [];
  await assert.rejects(main({ mode: 'check', env: { ...env, INSTAGRAM_ACCOUNT_ID: '17841449033580265' }, fetchFn: fakeFetch(h), log: s => logs.push(s), now: () => NOW, sleep: async () => {} }), /подсказки выше/);
  const text = logs.join('\n');
  assert.match(text, /17 цифр, начинается с «17841»/); assert.ok(!text.includes('17841449033580265'), 'полный ID не печатается');
  assert.match(text, /Токену доступны Instagram-аккаунты \(ID\): 17841000000000001/); assert.match(text, /НЕ совпадает ни с одним/);
  assert.match(text, /salam-bot/); assert.match(text, /instagram_basic/); assert.match(text, /нет разрешения instagram_content_publish/);
  assert.ok(!text.includes(TOKEN), 'токен не печатается');
}
console.log('ok 3б диагностика при отказе доступа');

// 4. нет секретов → понятная ошибка с именами, без значений
await assert.rejects(main({ mode: 'check', env: { INSTAGRAM_ACCOUNT_ID: '1' }, fetchFn: fakeFetch(okInstagram()) }), /INSTAGRAM_ACCESS_TOKEN/);
await assert.rejects(main({ mode: 'oops', env, fetchFn: fakeFetch(okInstagram()) }), /Неизвестный режим/);
{ // ID с лишними символами (например, два числа подряд) отклоняется до обращения к Instagram, токен не печатается
  const calls = [];
  const err = await main({ mode: 'check', env: { ...env, INSTAGRAM_ACCOUNT_ID: '17841449033580265\n61596101324605' }, fetchFn: fakeFetch(okInstagram(), calls) }).catch(e => e);
  assert.match(err.message, /только из цифр.*32 символов|только из цифр.*символов/); assert.equal(calls.length, 0); assert.ok(!err.message.includes(TOKEN));
}
console.log('ok 4 нет секретов / неверный режим');

// 5. публикация: созданный контейнер → ожидание обработки → публикация; статусы записаны; черновики и будущие посты не тронуты
{
  const calls = [];
  const q = await writeQueue([post(), post({ id: 'draft', status: 'draft' }), post({ id: 'future', publish_at: '2026-12-02T09:00:00Z' }), post({ id: 'done', status: 'published' })]);
  const { s, logs } = await run('publish', q, fakeFetch(okInstagram(), calls));
  assert.deepEqual(s.published, ['p1']); assert.deepEqual(s.waiting, ['future']);
  const posts = await readPosts(q);
  const p1 = posts.find(p => p.id === 'p1');
  assert.equal(p1.status, 'published'); assert.equal(p1.media_id, 'M1'); assert.equal(p1.permalink, 'https://www.instagram.com/reel/XYZ/');
  assert.equal(p1.published_at, '2026-12-01T10:00:00.000Z');
  assert.equal(posts.find(p => p.id === 'draft').status, 'draft');
  assert.equal(posts.find(p => p.id === 'future').status, 'scheduled');
  const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/1784/media'));
  assert.equal(create.params.media_type, 'REELS'); assert.equal(create.params.video_url, 'https://artega909-del.github.io/assets/demo%20clip.mp4');
  assert.equal(create.params.caption, 'Привет #ai'); assert.equal(create.params.share_to_feed, 'true');
  assert.equal(calls.filter(c => c.url.endsWith('/1784/media_publish')).length, 1, 'публикуется ровно один раз');
  assert.ok(!logs.join('\n').includes(TOKEN));
}
console.log('ok 5 публикация Reels');

// 6. фото публикуется как image_url
{
  const calls = [];
  const q = await writeQueue([post({ type: 'IMAGE', media: 'assets/a.jpg' })]);
  await run('publish', q, fakeFetch(okInstagram(), calls));
  const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/1784/media'));
  assert.equal(create.params.image_url, 'https://artega909-del.github.io/assets/a.jpg'); assert.ok(!('video_url' in create.params));
}
console.log('ok 6 публикация фото');

// 7. файл ещё не доступен на сайте → пост остаётся запланированным, ничего не публикуется
{
  const calls = [];
  const q = await writeQueue([post()]);
  const ok = okInstagram();
  const { s } = await run('publish', q, fakeFetch((m, u) => (m === 'HEAD' ? { status: 404 } : ok(m, u)), calls));
  assert.deepEqual(s.skipped, ['p1']);
  assert.equal((await readPosts(q))[0].status, 'scheduled');
  assert.ok(!calls.some(c => c.method === 'POST'));
}
console.log('ok 7 файл ещё не доступен');

// 8. ошибка Instagram → failed, токен в тексте ошибки скрыт, остальные посты продолжают публиковаться
{
  const q = await writeQueue([post({ id: 'bad', caption: 'x' }), post({ id: 'good' })]);
  let first = true;
  const ok = okInstagram(); // один «Instagram» на весь тест, чтобы он помнил ход обработки
  const h = (m, u, p) => {
    if (m === 'POST' && u.pathname.endsWith('/1784/media') && first) { first = false; return { status: 400, json: { error: { message: `Invalid token ${TOKEN}`, code: 190, error_subcode: 463 } } }; }
    return ok(m, u, p);
  };
  const { s, logs } = await run('publish', q, fakeFetch(h));
  assert.deepEqual(s.failed, ['bad']); assert.deepEqual(s.published, ['good']);
  const posts = await readPosts(q);
  assert.equal(posts[0].status, 'failed'); assert.match(posts[0].error, /код 190\/463/);
  assert.ok(!JSON.stringify(posts).includes(TOKEN) && !logs.join('\n').includes(TOKEN), 'токен не попадает ни в очередь, ни в логи');
}
console.log('ok 8 ошибка Instagram, токен скрыт');

// 9. слишком старые посты не публикуются задним числом
{
  const q = await writeQueue([post({ publish_at: '2026-11-20T09:00:00Z' })]);
  const calls = [];
  const { s } = await run('publish', q, fakeFetch(okInstagram(), calls));
  assert.deepEqual(s.missed, ['p1']); assert.equal((await readPosts(q))[0].status, 'missed'); assert.equal(calls.length, 0);
}
console.log('ok 9 пропущенное время');

// 10. не больше MAX_PER_RUN постов за запуск, остальные ждут следующего
{
  const q = await writeQueue([post({ id: 'a' }), post({ id: 'b' }), post({ id: 'c' })]);
  const { s } = await run('publish', q, fakeFetch(okInstagram()), { MAX_PER_RUN: '2' });
  assert.deepEqual(s.published, ['a', 'b']); assert.deepEqual(s.waiting, ['c']);
}
console.log('ok 10 лимит постов за запуск');

// 11. dry-run ничего не публикует и не меняет очередь
{
  const calls = [];
  const q = await writeQueue([post()]);
  const before = await readFile(q, 'utf8');
  const { logs } = await run('dry-run', q, fakeFetch(okInstagram(), calls));
  assert.match(logs.join('\n'), /вышло бы: p1/);
  assert.ok(!calls.some(c => c.method === 'POST')); assert.equal(await readFile(q, 'utf8'), before);
}
console.log('ok 11 dry-run');

// 12. невалидная запись помечается failed с понятной причиной
{
  const q = await writeQueue([post({ media: 'assets/a.png', type: 'IMAGE' })]);
  const { s } = await run('publish', q, fakeFetch(okInstagram()));
  assert.deepEqual(s.failed, ['p1']); assert.match((await readPosts(q))[0].error, /JPEG/);
}
console.log('ok 12 невалидная запись');

// 13. защита от повтора: такой пост уже есть в аккаунте (прошлый запуск не успел сохранить статус) → не публикуем снова
{
  const calls = [];
  const ok = okInstagram();
  const h = (m, u, p) => (m === 'GET' && u.pathname.endsWith('/1784/media')
    ? { status: 200, json: { data: [{ id: 'OLD1', caption: '  Привет #ai ', permalink: 'https://www.instagram.com/reel/OLD/' }] } } : ok(m, u, p));
  const q = await writeQueue([post()]);
  const { s, logs } = await run('publish', q, fakeFetch(h, calls));
  assert.deepEqual(s.published, []); assert.deepEqual(s.duplicates, ['p1']);
  const p1 = (await readPosts(q))[0];
  assert.equal(p1.status, 'published'); assert.equal(p1.media_id, 'OLD1'); assert.match(p1.note, /повторно не публиковался/);
  assert.ok(!calls.some(c => c.method === 'POST'), 'ничего не создаётся и не публикуется');
  assert.match(logs.join('\n'), /уже есть в аккаунте/);
  // repeat: true — осознанный повтор с той же подписью публикуется
  const q2 = await writeQueue([post({ repeat: true })], 'q2.json');
  const r2 = await run('publish', q2, fakeFetch(h));
  assert.deepEqual(r2.s.published, ['p1']);
}
console.log('ok 13 защита от повторной публикации');

// 14. если проверить последние посты не удалось — пишем предупреждение и публикуем (не блокируем очередь)
{
  const ok = okInstagram();
  const h = (m, u, p) => (m === 'GET' && u.pathname.endsWith('/1784/media') ? { status: 500, json: { error: { message: 'temporary' } } } : ok(m, u, p));
  const q = await writeQueue([post()]);
  const { s, logs } = await run('publish', q, fakeFetch(h));
  assert.deepEqual(s.published, ['p1']); assert.match(logs.join('\n'), /не удалось проверить последние посты/);
}
console.log('ok 14 сбой проверки повтора не блокирует публикацию');

// 15. обложка Reels: cover_ms → thumb_offset; неверное значение отклоняется
{
  const calls = [];
  await run('publish', await writeQueue([post({ cover_ms: 1500 })]), fakeFetch(okInstagram(), calls));
  assert.equal(calls.find(c => c.method === 'POST' && c.url.endsWith('/1784/media')).params.thumb_offset, '1500');
  assert.ok(validate(post({ cover_ms: -1 })).some(e => /cover_ms/.test(e)));
  assert.ok(validate(post({ cover_ms: 1.5 })).some(e => /cover_ms/.test(e)));
  assert.ok(validate(post({ type: 'IMAGE', media: 'assets/a.jpg', cover_ms: 0 })).some(e => /только у REELS/.test(e)));
}
console.log('ok 15 обложка Reels');

// 16. dry-run показывает будущие посты и проверяет их файл, ничего не публикуя
{
  const calls = [];
  const q = await writeQueue([post({ id: 'future', publish_at: '2026-12-02T09:00:00Z' })]);
  const { s, logs } = await run('dry-run', q, fakeFetch(okInstagram(), calls));
  assert.deepEqual(s.waiting, ['future']); assert.match(logs.join('\n'), /future: выйдет после 2026-12-02T09:00:00Z.*файл: 200/);
  assert.ok(!calls.some(c => c.method === 'POST'));
}
console.log('ok 16 dry-run: предпросмотр будущих постов');

// 17. карусель: каждый слайд создаётся отдельно, затем общий контейнер с children и подписью; публикуется один раз
{
  const calls = []; let n = 0;
  const h = (m, u, p) => {
    if (m === 'HEAD') return { status: 200 };
    if (m === 'POST' && u.pathname.endsWith('/1784/media')) return { status: 200, json: { id: p.media_type === 'CAROUSEL' ? 'PARENT' : 'CH' + (++n) } };
    if (m === 'GET' && /\/(CH\d|PARENT)$/.test(u.pathname)) return { status: 200, json: { status_code: 'FINISHED' } };
    if (u.pathname.endsWith('/1784/media_publish')) return { status: 200, json: { id: 'M9' } };
    if (u.pathname.endsWith('/M9')) return { status: 200, json: { permalink: 'https://www.instagram.com/p/CAR/' } };
    if (m === 'GET' && u.pathname.endsWith('/1784/media')) return { status: 200, json: { data: [] } };
  };
  const car = post({ type: 'CAROUSEL', media: ['assets/c/01.jpg', 'assets/c/02.jpg', 'assets/c/03.jpg'] });
  assert.deepEqual(validate(car), []);
  const q = await writeQueue([car]);
  const { s } = await run('publish', q, fakeFetch(h, calls));
  assert.deepEqual(s.published, ['p1']);
  const posts = calls.filter(c => c.method === 'POST' && c.url.endsWith('/1784/media'));
  assert.equal(posts.length, 4);
  assert.deepEqual(posts.slice(0, 3).map(c => [c.params.image_url, c.params.is_carousel_item, c.params.caption]),
    [1, 2, 3].map(i => [`https://artega909-del.github.io/assets/c/0${i}.jpg`, 'true', undefined]));
  assert.equal(posts[3].params.media_type, 'CAROUSEL'); assert.equal(posts[3].params.children, 'CH1,CH2,CH3'); assert.equal(posts[3].params.caption, 'Привет #ai');
  const pub = calls.filter(c => c.url.endsWith('/1784/media_publish')); assert.equal(pub.length, 1); assert.equal(pub[0].params.creation_id, 'PARENT');
  assert.equal((await readPosts(q))[0].permalink, 'https://www.instagram.com/p/CAR/');
  // проверки записи
  assert.ok(validate(post({ type: 'CAROUSEL', media: 'assets/a.jpg' })).some(e => /2–10/.test(e)));
  assert.ok(validate(post({ type: 'CAROUSEL', media: ['assets/a.jpg'] })).some(e => /2–10/.test(e)));
  assert.ok(validate(post({ type: 'CAROUSEL', media: ['assets/a.jpg', 'assets/b.png'] })).some(e => /JPEG/.test(e)));
  // один слайд ещё не доступен на сайте → ничего не создаётся, пост ждёт
  const calls2 = [];
  const q2 = await writeQueue([car], 'q2.json');
  const r2 = await run('publish', q2, fakeFetch((m, u, p) => (m === 'HEAD' && u.pathname.endsWith('02.jpg') ? { status: 404 } : h(m, u, p)), calls2));
  assert.deepEqual(r2.s.skipped, ['p1']); assert.ok(!calls2.some(c => c.method === 'POST'));
}
console.log('ok 17 карусель');

// 18. история: картинка или видео уходят как STORIES, без подписи
{
  for (const [media, key] of [['assets/s/a.jpg', 'image_url'], ['assets/s/a.mp4', 'video_url']]) {
    const calls = [];
    const st = post({ id: 'st', type: 'STORY', media, caption: '' });
    assert.deepEqual(validate(st), []);
    const { s } = await run('publish', await writeQueue([st]), fakeFetch(okInstagram(), calls));
    assert.deepEqual(s.published, ['st']);
    const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/1784/media'));
    assert.equal(create.params.media_type, 'STORIES'); assert.ok(create.params[key].endsWith(media.split('/').pop())); assert.ok(!('caption' in create.params));
    assert.ok(!calls.some(c => c.method === 'GET' && c.url.endsWith('/1784/media')), 'у историй нет подписи — проверка повтора по подписи не выполняется');
  }
  assert.ok(validate(post({ type: 'STORY', media: 'assets/a.png' })).some(e => /STORY/.test(e)));
}
console.log('ok 18 история');

// ---------- Threads ----------
const TH = 'THtest-SECRET-threads-456';
const thPost = (over = {}) => ({ id: 't1', brand: 'salam', platform: 'threads', type: 'TEXT', caption: 'Совет дня: одно действие на кадр', publish_at: '2026-12-01T09:00:00Z', status: 'scheduled', ...over });
// Threads, который успешно принимает всё; срок токена — daysLeft дней
const okThreads = (o = {}) => { let n = 0; return (m, u, p) => {
  if (u.host !== 'graph.threads.net') return m === 'HEAD' ? { status: 200 } : okInstagram()(m, u, p);
  if (u.pathname === '/refresh_access_token') return o.refresh ? o.refresh(p) : { status: 200, json: { access_token: TH, token_type: 'bearer', expires_in: 60 * 86400 } };
  if (u.pathname.endsWith('/debug_token')) return { status: 200, json: { data: { is_valid: true, expires_at: Math.floor(NOW / 1000) + (o.daysLeft ?? 50) * 86400 } } };
  if (u.pathname.endsWith('/me')) return { status: 200, json: { id: '777', username: 'salammotion' } };
  if (m === 'GET' && u.pathname.endsWith('/777/threads')) return { status: 200, json: { data: o.recent || [] } };
  if (m === 'POST' && u.pathname.endsWith('/777/threads')) return { status: 200, json: { id: p.media_type === 'CAROUSEL' ? 'TPARENT' : 'TC' + (++n) } };
  if (m === 'GET' && /\/(TC\d|TPARENT)$/.test(u.pathname)) return { status: 200, json: { status: o.status || 'FINISHED', error_message: o.error_message } };
  if (u.pathname.endsWith('/777/threads_publish')) return { status: 200, json: { id: 'TM1' } };
  if (u.pathname.endsWith('/TM1')) return { status: 200, json: { permalink: 'https://www.threads.net/@salammotion/post/ABC' } };
}; };
const thEnv = { THREADS_ACCESS_TOKEN: TH };

// 19. проверка записей для Threads
assert.deepEqual(validate(thPost()), []);
assert.deepEqual(validate(thPost({ link: 'https://salammotion.com' })), []);
assert.deepEqual(validate(thPost({ type: 'IMAGE', media: 'assets/a.png' })), []);
assert.deepEqual(validate(thPost({ type: 'VIDEO', media: 'assets/a.mp4' })), []);
assert.deepEqual(validate(thPost({ type: 'CAROUSEL', media: Array.from({ length: 12 }, (_, i) => `assets/c/${i}.jpg`) })), [], 'в Threads до 20 слайдов');
assert.ok(validate(thPost({ caption: 'я'.repeat(501) })).some(e => /500/.test(e)));
assert.ok(validate(thPost({ caption: ' ' })).some(e => /должен быть текст/.test(e)));
assert.ok(validate(thPost({ media: 'assets/a.jpg' })).some(e => /у TEXT нет media/.test(e)));
assert.ok(validate(thPost({ type: 'REELS', media: 'assets/a.mp4' })).some(e => /для Threads/.test(e)));
assert.ok(validate(thPost({ type: 'VIDEO', media: 'assets/a.jpg' })).some(e => /mp4/.test(e)));
assert.ok(validate(thPost({ type: 'IMAGE', media: 'assets/a.jpg', link: 'https://salammotion.com' })).some(e => /link/.test(e)));
assert.ok(validate(post({ link: 'https://salammotion.com' })).some(e => /link/.test(e)), 'у Instagram ссылок с превью нет');
console.log('ok 19 Threads: проверка записей');

// 20. текстовый пост: уходит на graph.threads.net с токеном Threads, без ожидания обработки; токен не попадает в логи
{
  const calls = [];
  const q = await writeQueue([thPost({ link: 'https://salammotion.com' })]);
  const { s, logs } = await run('publish', q, fakeFetch(okThreads(), calls), thEnv);
  assert.deepEqual(s.published, ['t1']);
  const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/777/threads'));
  assert.equal(create.url, 'https://graph.threads.net/v1.0/777/threads');
  assert.deepEqual([create.params.media_type, create.params.text, create.params.link_attachment, create.params.access_token], ['TEXT', 'Совет дня: одно действие на кадр', 'https://salammotion.com', TH]);
  assert.ok(calls.some(c => c.method === 'GET' && /\/TC1$/.test(c.url)), 'текст тоже ждёт готовности контейнера');
  assert.equal(calls.find(c => c.url.endsWith('/777/threads_publish')).params.creation_id, 'TC1');
  const saved = (await readPosts(q))[0];
  assert.deepEqual([saved.status, saved.media_id, saved.permalink], ['published', 'TM1', 'https://www.threads.net/@salammotion/post/ABC']);
  assert.ok(!logs.join('\n').includes(TH) && !JSON.stringify(saved).includes(TH));
  assert.ok(!calls.some(c => c.url.includes('graph.facebook.com')), 'к Instagram запросов нет');
}
console.log('ok 20 Threads: текстовый пост');

// 21. картинка, видео и карусель; ошибка обработки сохраняется с причиной
{
  for (const [type, media, key] of [['IMAGE', 'assets/a.jpg', 'image_url'], ['VIDEO', 'assets/r.mp4', 'video_url']]) {
    const calls = [];
    const { s } = await run('publish', await writeQueue([thPost({ type, media })]), fakeFetch(okThreads(), calls), thEnv);
    assert.deepEqual(s.published, ['t1']);
    const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/777/threads'));
    assert.equal(create.params.media_type, type); assert.equal(create.params[key], 'https://artega909-del.github.io/' + media);
    assert.ok(calls.some(c => c.method === 'GET' && c.url.endsWith('/TC1') && c.params.fields === 'status,error_message'));
  }
  const calls = [];
  const car = thPost({ type: 'CAROUSEL', media: ['assets/c/01.jpg', 'assets/c/02.mp4'] });
  await run('publish', await writeQueue([car]), fakeFetch(okThreads(), calls), thEnv);
  const posts = calls.filter(c => c.method === 'POST' && c.url.endsWith('/777/threads'));
  assert.deepEqual(posts.map(c => [c.params.media_type, c.params.is_carousel_item, c.params.text]),
    [['IMAGE', 'true', undefined], ['VIDEO', 'true', undefined], ['CAROUSEL', undefined, car.caption]]);
  assert.equal(posts[2].params.children, 'TC1,TC2');
  assert.equal(calls.find(c => c.url.endsWith('/777/threads_publish')).params.creation_id, 'TPARENT');
  const q = await writeQueue([thPost({ type: 'VIDEO', media: 'assets/r.mp4' })]);
  const bad = await run('publish', q, fakeFetch(okThreads({ status: 'ERROR', error_message: 'FAILED_PROCESSING_VIDEO' })), thEnv);
  assert.deepEqual(bad.s.failed, ['t1']); assert.match((await readPosts(q))[0].error, /Threads не смог обработать файл: ERROR — FAILED_PROCESSING_VIDEO/);
}
console.log('ok 21 Threads: картинка, видео, карусель');

// 22. без секрета Threads запись ждёт, Instagram публикуется как обычно; повтор по тексту не публикуется
{
  const q = await writeQueue([thPost(), post()]);
  const calls = [];
  const { s, logs } = await run('publish', q, fakeFetch(okInstagram(), calls));
  assert.deepEqual([s.skipped, s.published], [['t1'], ['p1']]); assert.match(logs.join('\n'), /THREADS_ACCESS_TOKEN не задан/);
  assert.equal((await readPosts(q))[0].status, 'scheduled');
  assert.ok(!calls.some(c => c.url.includes('threads.net')));
  const q2 = await writeQueue([thPost()], 'q2.json');
  const calls2 = [];
  const r2 = await run('publish', q2, fakeFetch(okThreads({ recent: [{ id: 'OLD', text: thPost().caption, permalink: 'https://www.threads.net/@salammotion/post/OLD' }] }), calls2), thEnv);
  assert.deepEqual(r2.s.duplicates, ['t1']); assert.ok(!calls2.some(c => c.method === 'POST'));
}
console.log('ok 22 Threads: без секрета запись ждёт, защита от повтора');

// 23. токен Threads: при сроке больше 45 дней не трогаем; меньше — продлеваем; меньше 10 дней и продлить нельзя — предупреждение
{
  const refreshed = c => c.filter(x => x.url === 'https://graph.threads.net/refresh_access_token');
  let calls = [];
  await run('publish', await writeQueue([]), fakeFetch(okThreads({ daysLeft: 50 }), calls), thEnv);
  assert.equal(refreshed(calls).length, 0);
  calls = [];
  let r = await run('publish', await writeQueue([]), fakeFetch(okThreads({ daysLeft: 30 }), calls), thEnv);
  assert.equal(refreshed(calls).length, 1); assert.equal(refreshed(calls)[0].params.grant_type, 'th_refresh_token');
  assert.match(r.logs.join('\n'), /Токен Threads продлён, действует ещё 60 дн/); assert.equal(r.s.warnings, undefined);
  r = await run('publish', await writeQueue([]), fakeFetch(okThreads({ daysLeft: 5, refresh: () => ({ status: 200, json: { access_token: 'ANOTHER-token', expires_in: 60 * 86400 } }) })), thEnv);
  assert.match(r.s.warnings[0], /истекает через 5 дн/); assert.match(r.logs.join('\n'), /другой токен/); assert.ok(!r.logs.join('\n').includes('ANOTHER-token'));
  r = await run('publish', await writeQueue([]), fakeFetch(okThreads({ daysLeft: 5, refresh: () => ({ status: 400, json: { error: { message: 'cannot refresh', code: 190 } } }) })), thEnv);
  assert.match(r.logs.join('\n'), /продлить токен Threads не удалось/); assert.equal(r.s.warnings.length, 1);
  // dry-run токен не продлевает
  calls = [];
  await run('dry-run', await writeQueue([thPost()]), fakeFetch(okThreads({ daysLeft: 5 }), calls), thEnv);
  assert.ok(!calls.some(c => c.url.includes('refresh_access_token') || c.method === 'POST'));
}
console.log('ok 23 Threads: продление токена');

// 24. check: Threads проверяется вместе с Instagram; без секрета — сообщение, что Threads выключен
{
  let r = await run('check', await writeQueue([]), fakeFetch(okThreads({ daysLeft: 41 })), thEnv);
  assert.equal(r.s.threadsUsername, 'salammotion'); assert.match(r.logs.join('\n'), /Threads: доступ есть: @salammotion[\s\S]*ещё 41 дн/);
  r = await run('check', await writeQueue([]), fakeFetch(okInstagram()));
  assert.match(r.logs.join('\n'), /публикация в Threads выключена/);
  const broken = (m, u, p) => (u.host === 'graph.threads.net' ? { status: 400, json: { error: { message: `Invalid OAuth access token ${TH}`, code: 190 } } } : okInstagram()(m, u, p));
  const logs = [];
  await assert.rejects(main({ mode: 'check', env: { ...env, ...thEnv }, fetchFn: fakeFetch(broken), log: s => logs.push(s), now: () => NOW, sleep: async () => {} }), /Threads не пройдена/);
  assert.ok(!logs.join('\n').includes(TH));
}
console.log('ok 24 Threads: check');

// 25. второй аккаунт (en): Instagram идёт на свой ID с тем же токеном, Threads — со своим токеном; без секретов записи ждут
{
  const TH_EN = 'THen-SECRET-789';
  const h = (m, u, p) => {
    if (m === 'HEAD') return { status: 200 };
    if (u.host === 'graph.threads.net') {
      const en = p.access_token === TH_EN;
      if (u.pathname === '/refresh_access_token') return { status: 200, json: { access_token: p.access_token, expires_in: 60 * 86400 } };
      if (u.pathname.endsWith('/debug_token')) return { status: 200, json: { data: { expires_at: Math.floor(NOW / 1000) + 50 * 86400 } } };
      if (u.pathname.endsWith('/me')) return { status: 200, json: en ? { id: '888', username: 'salammotion.en' } : { id: '777', username: 'salammotion' } };
      if (m === 'GET' && /\/(777|888)\/threads$/.test(u.pathname)) return { status: 200, json: { data: [] } };
      if (m === 'POST' && /\/(777|888)\/threads$/.test(u.pathname)) return { status: 200, json: { id: 'TC_' + u.pathname.split('/')[2] } };
      if (m === 'GET' && /\/TC_\d+$/.test(u.pathname)) return { status: 200, json: { status: 'FINISHED' } };
      if (/\/(777|888)\/threads_publish$/.test(u.pathname)) return { status: 200, json: { id: 'TP_' + u.pathname.split('/')[2] } };
      if (/\/TP_\d+$/.test(u.pathname)) return { status: 200, json: { permalink: 'https://www.threads.com/p/' + u.pathname.split('_')[1] } };
    }
    const m2 = u.pathname.match(/\/(1784|1785)(\/media|\/media_publish)?$/);
    if (m2 && m2[2] === '/media' && m === 'POST') return { status: 200, json: { id: 'C_' + m2[1] } };
    if (m2 && m2[2] === '/media') return { status: 200, json: { data: [] } };
    if (m2 && m2[2] === '/media_publish') return { status: 200, json: { id: 'M_' + m2[1] } };
    if (m2) return { status: 200, json: { username: m2[1] === '1785' ? 'salammotion.en' : 'salammotion' } };
    if (/\/C_\d+$/.test(u.pathname)) return { status: 200, json: { status_code: 'FINISHED' } };
    if (/\/M_\d+$/.test(u.pathname)) return { status: 200, json: { permalink: 'https://www.instagram.com/p/' + u.pathname.split('_')[1] } };
  };
  const enPosts = () => [post({ id: 'ig-en', account: 'en', caption: 'Hello #ai' }), thPost({ id: 'th-en', account: 'en', caption: 'Tip of the day' }), post({ id: 'ig-main' })];
  // без секретов en: записи en ждут, основной публикуется
  let q = await writeQueue(enPosts());
  let r = await run('publish', q, fakeFetch(h));
  assert.deepEqual([r.s.published, r.s.skipped], [['ig-main'], ['ig-en', 'th-en']]);
  assert.match(r.logs.join('\n'), /аккаунт «en» не подключён/);
  // с секретами: каждая запись уходит в свой аккаунт
  const calls = [];
  q = await writeQueue(enPosts(), 'q2.json');
  r = await run('publish', q, fakeFetch(h, calls), { INSTAGRAM_ACCOUNT_ID_EN: '1785', THREADS_ACCESS_TOKEN_EN: TH_EN, ...thEnv });
  assert.deepEqual(r.s.published, ['ig-en', 'th-en', 'ig-main']);
  const pubs = calls.filter(c => c.method === 'POST' && /media_publish|threads_publish/.test(c.url)).map(c => c.url.replace(/^.*\/(\d+)\/(\w+)$/, '$1/$2'));
  assert.deepEqual(pubs, ['1785/media_publish', '888/threads_publish', '1784/media_publish']);
  assert.equal(calls.find(c => c.url.endsWith('/888/threads_publish')).params.access_token, TH_EN);
  assert.equal(calls.find(c => c.url.endsWith('/1785/media_publish')).params.access_token, TOKEN, 'Instagram en — токен системного пользователя');
  const saved = await readPosts(q);
  assert.deepEqual(saved.map(x => x.permalink), ['https://www.instagram.com/p/1785', 'https://www.threads.com/p/888', 'https://www.instagram.com/p/1784']);
  assert.ok(!r.logs.join('\n').includes(TH_EN));
  // только Threads для en подключён — Instagram en ждёт
  r = await run('publish', await writeQueue(enPosts(), 'q3.json'), fakeFetch(h), { THREADS_ACCESS_TOKEN_EN: TH_EN });
  assert.deepEqual([r.s.published, r.s.skipped], [['th-en', 'ig-main'], ['ig-en']]);
  assert.match(r.logs.join('\n'), /INSTAGRAM_ACCOUNT_ID_EN не задан/);
  // check проверяет оба аккаунта
  r = await run('check', await writeQueue([]), fakeFetch(h), { INSTAGRAM_ACCOUNT_ID_EN: '1785', THREADS_ACCESS_TOKEN_EN: TH_EN });
  assert.deepEqual(r.s.extra.en, { username: 'salammotion.en', threadsUsername: 'salammotion.en' });
  // проверка записи и секрета
  assert.ok(validate(post({ account: 'EN' })).some(e => /account/.test(e)));
  // неверный ID второго аккаунта (например, вставлен маркер) — основной аккаунт работает, en пропускается
  r = await run('publish', await writeQueue(enPosts(), 'q4.json'), fakeFetch(h), { INSTAGRAM_ACCOUNT_ID_EN: 'IG' + 'x'.repeat(254) });
  assert.deepEqual([r.s.published, r.s.skipped], [['ig-main'], ['ig-en', 'th-en']]);
  assert.match(r.logs.join('\n'), /попал маркер/); assert.ok(!r.logs.join('\n').includes('x'.repeat(50)));
}
console.log('ok 25 второй аккаунт (en)');

// 26. токен входа через Instagram (IG…) для второго аккаунта: запросы на graph.instagram.com, токен продлевается
{
  const IGT = 'IGtest-SECRET-555';
  const calls = [];
  const h = (m, u, p) => {
    if (m === 'HEAD') return { status: 200 };
    if (u.host === 'graph.instagram.com') {
      if (u.pathname === '/refresh_access_token') return { status: 200, json: { access_token: IGT, expires_in: 5184000 } };
      if (m === 'POST' && u.pathname.endsWith('/1785/media')) return { status: 200, json: { id: 'CI' } };
      if (m === 'GET' && u.pathname.endsWith('/1785/media')) return { status: 200, json: { data: [] } };
      if (u.pathname.endsWith('/CI')) return { status: 200, json: { status_code: 'FINISHED' } };
      if (u.pathname.endsWith('/1785/media_publish')) return { status: 200, json: { id: 'MI' } };
      if (u.pathname.endsWith('/MI')) return { status: 200, json: { permalink: 'https://www.instagram.com/p/EN/' } };
      if (u.pathname.endsWith('/1785')) return { status: 200, json: { username: 'artega.videodesigner' } };
    }
    return okInstagram()(m, u, p);
  };
  const q = await writeQueue([post({ id: 'ig-en', account: 'en', caption: 'Hello' })]);
  const r = await run('publish', q, fakeFetch(h, calls), { INSTAGRAM_ACCOUNT_ID_EN: '1785', INSTAGRAM_ACCESS_TOKEN_EN: IGT });
  assert.deepEqual(r.s.published, ['ig-en']);
  const ref = calls.find(c => c.url === 'https://graph.instagram.com/refresh_access_token');
  assert.equal(ref.params.grant_type, 'ig_refresh_token'); assert.equal(ref.params.access_token, IGT);
  assert.ok(calls.some(c => c.url === 'https://graph.instagram.com/v23.0/1785/media_publish' && c.params.access_token === IGT));
  assert.ok(!calls.some(c => c.url.includes('graph.facebook.com/v23.0/1785')));
  assert.match(r.logs.join('\n'), /Токен Instagram EN продлён, действует ещё 60 дн/);
  assert.ok(!r.logs.join('\n').includes(IGT));
  assert.equal((await readPosts(q))[0].permalink, 'https://www.instagram.com/p/EN/');
  const c = await run('check', await writeQueue([]), fakeFetch(h), { INSTAGRAM_ACCOUNT_ID_EN: '1785', INSTAGRAM_ACCESS_TOKEN_EN: IGT });
  assert.equal(c.s.extra.en.username, 'artega.videodesigner');
}
console.log('ok 26 второй аккаунт: токен входа через Instagram');

// 27. карусель Instagram с анимированной обложкой: первый слайд — видео
{
  const calls = []; let n = 0;
  const h = (m, u, p) => {
    if (m === 'HEAD') return { status: 200 };
    if (m === 'POST' && u.pathname.endsWith('/1784/media')) return { status: 200, json: { id: p.media_type === 'CAROUSEL' ? 'PARENT' : 'CH' + (++n) } };
    if (m === 'GET' && /\/(CH\d|PARENT)$/.test(u.pathname)) return { status: 200, json: { status_code: 'FINISHED' } };
    if (u.pathname.endsWith('/1784/media_publish')) return { status: 200, json: { id: 'M9' } };
    if (u.pathname.endsWith('/M9')) return { status: 200, json: { permalink: 'https://www.instagram.com/p/CAR/' } };
    if (m === 'GET' && u.pathname.endsWith('/1784/media')) return { status: 200, json: { data: [] } };
  };
  const car = post({ type: 'CAROUSEL', media: ['assets/c/01.mp4', 'assets/c/02.jpg'] });
  assert.deepEqual(validate(car), []);
  const { s } = await run('publish', await writeQueue([car]), fakeFetch(h, calls));
  assert.deepEqual(s.published, ['p1']);
  const kids = calls.filter(c => c.method === 'POST' && c.url.endsWith('/1784/media') && c.params.is_carousel_item);
  assert.deepEqual(kids.map(c => [c.params.media_type, c.params.video_url ? 'v' : 'i']), [['VIDEO', 'v'], [undefined, 'i']]);
  assert.ok(validate(post({ type: 'IMAGE', media: 'assets/a.mp4' })).some(e => /JPEG/.test(e)), 'одиночный пост — только JPEG');
}
console.log('ok 27 карусель с видео-обложкой');

// 28. Threads: публикация сразу после создания иногда отвечает «resource does not exist» — бот повторяет
{
  let tries = 0; const calls = [];
  const base = okThreads();
  const h = (m, u, p) => (u.pathname.endsWith('/777/threads_publish') && ++tries < 3
    ? { status: 400, json: { error: { message: 'The requested resource does not exist', code: 24, error_subcode: 4279009 } } } : base(m, u, p));
  const q = await writeQueue([thPost()]);
  const { s } = await run('publish', q, fakeFetch(h, calls), thEnv);
  assert.deepEqual(s.published, ['t1']); assert.equal(tries, 3);
  // другая ошибка не повторяется
  let n2 = 0; const h2 = (m, u, p) => (u.pathname.endsWith('/777/threads_publish') ? (n2++, { status: 400, json: { error: { message: 'Invalid parameter', code: 100 } } }) : base(m, u, p));
  const r2 = await run('publish', await writeQueue([thPost()], 'q2.json'), fakeFetch(h2), thEnv);
  assert.deepEqual(r2.s.failed, ['t1']); assert.equal(n2, 1);
}
console.log('ok 28 Threads: повтор публикации, если контейнер ещё не виден');

// 29. YouTube Shorts: вход по refresh token, загрузка с метаданными, отметка ИИ, защита от повтора, ключи не в логах
{
  const RT = 'RT-SECRET-yt', CS = 'CS-SECRET-yt', AT = 'AT-access-yt';
  const yEnv = { YOUTUBE_CLIENT_ID: 'cid', YOUTUBE_CLIENT_SECRET: CS, YOUTUBE_REFRESH_TOKEN: RT };
  const mk = (o = {}) => (m, u, p) => {
    if (m === 'HEAD') return { status: 200 };
    if (u.host === 'artega909-del.github.io' && m === 'GET') return { status: 200, json: {} };
    if (u.host === 'oauth2.googleapis.com') return o.badToken ? { status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } : { status: 200, json: { access_token: AT, expires_in: 3599 } };
    if (u.pathname === '/youtube/v3/channels') return { status: 200, json: { items: [{ snippet: { title: 'Salam Motion' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] } };
    if (u.pathname === '/youtube/v3/playlistItems') return { status: 200, json: { items: o.recent || [] } };
    if (u.pathname === '/upload/youtube/v3/videos' && m === 'POST') return { status: 200, json: {}, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1' } };
    if (u.pathname === '/upload/youtube/v3/videos' && m === 'PUT') return { status: 200, json: { id: 'VID1', status: { privacyStatus: o.forced || 'public' } } };
    return okInstagram()(m, u, p);
  };
  const sh = (over = {}) => ({ id: 'y1', brand: 'salam', platform: 'youtube', type: 'SHORT', media: 'assets/demo clip.mp4', title: 'One phrase → a flower shop ad', caption: 'Made from one phrase. #shorts', tags: ['ai video'], publish_at: '2026-12-01T09:00:00Z', status: 'scheduled', ...over });
  assert.deepEqual(validate(sh()), []);
  assert.ok(validate(sh({ title: '' })).some(e => /title/.test(e)));
  assert.ok(validate(sh({ media: 'assets/a.jpg' })).some(e => /mp4/.test(e)));
  assert.ok(validate(sh({ type: 'REELS' })).some(e => /SHORT/.test(e)));
  const calls = [];
  const q = await writeQueue([sh()]);
  const { s: r, logs } = await run('publish', q, fakeFetch(mk(), calls), yEnv);
  assert.deepEqual(r.published, ['y1']);
  const tok = calls.find(c => c.url === 'https://oauth2.googleapis.com/token');
  assert.deepEqual([tok.params.grant_type, tok.params.refresh_token], ['refresh_token', RT]);
  const init = calls.find(c => c.method === 'POST' && c.url.endsWith('/upload/youtube/v3/videos'));
  assert.equal(init.params.snippet.title, 'One phrase → a flower shop ad'); assert.equal(init.params.status.privacyStatus, 'public');
  assert.equal(init.params.status.containsSyntheticMedia, true); assert.equal(init.params.status.selfDeclaredMadeForKids, false);
  assert.equal(init.params.__headers.authorization, 'Bearer ' + AT);
  assert.ok(calls.find(c => c.method === 'PUT').params.bytes > 0, 'файл загружается');
  const saved = (await readPosts(q))[0];
  assert.deepEqual([saved.status, saved.permalink], ['published', 'https://www.youtube.com/shorts/VID1']);
  assert.ok(![RT, CS, AT].some(x => logs.join('\n').includes(x) || JSON.stringify(saved).includes(x)));
  // YouTube сделал видео приватным → пометка в записи
  const q2 = await writeQueue([sh()], 'q2.json');
  await run('publish', q2, fakeFetch(mk({ forced: 'private' })), yEnv);
  assert.match((await readPosts(q2))[0].note, /private/);
  // повтор: видео с таким названием уже есть — не загружаем
  const calls3 = [];
  const r3 = await run('publish', await writeQueue([sh()], 'q3.json'), fakeFetch(mk({ recent: [{ snippet: { title: 'One phrase → a flower shop ad', resourceId: { videoId: 'OLD' } } }] }), calls3), yEnv);
  assert.deepEqual(r3.s.duplicates, ['y1']); assert.ok(!calls3.some(c => c.url.includes('/upload/')));
  // ключ отозван — ошибка понятная, секреты скрыты
  const q4 = await writeQueue([sh()], 'q4.json');
  const r4 = await run('publish', q4, fakeFetch(mk({ badToken: true })), yEnv);
  assert.deepEqual(r4.s.failed, ['y1']); const err = (await readPosts(q4))[0].error;
  assert.match(err, /expired or revoked/); assert.ok(![RT, CS].some(x => err.includes(x)));
  // без секретов — ждёт; второй аккаунт берёт YOUTUBE_REFRESH_TOKEN_EN
  const r5 = await run('publish', await writeQueue([sh()], 'q5.json'), fakeFetch(mk()));
  assert.deepEqual(r5.s.skipped, ['y1']); assert.match(r5.logs.join('\n'), /YOUTUBE_REFRESH_TOKEN\) не заданы/);
  const calls6 = [];
  const r6 = await run('publish', await writeQueue([sh({ account: 'en' })], 'q6.json'), fakeFetch(mk(), calls6), { YOUTUBE_CLIENT_ID: 'cid', YOUTUBE_CLIENT_SECRET: CS, YOUTUBE_REFRESH_TOKEN_EN: 'RT-EN' });
  assert.deepEqual(r6.s.published, ['y1']); assert.equal(calls6.find(c => c.url.includes('oauth2')).params.refresh_token, 'RT-EN');
  // check показывает канал
  const r7 = await run('check', await writeQueue([]), fakeFetch(mk()), yEnv);
  assert.equal(r7.s.youtube.main, 'Salam Motion');
}
console.log('ok 29 YouTube Shorts');

// 30. Оформление загруженных видео: отчёт со списком и превью, правки названия/описания/превью, ошибки не роняют остальные
{
  const { report, apply, idHash } = await import('./yt-channel.mjs');
  const yEnv = { YOUTUBE_CLIENT_ID: 'cid', YOUTUBE_CLIENT_SECRET: 'GOCSPX-sec', YOUTUBE_REFRESH_TOKEN: '1//rt' };
  const vids = { V1: { title: 'IMG_0001', description: '', categoryId: '22' }, V2: { title: 'old', description: 'd', categoryId: '22', tags: ['a'] } };
  const h = (method, u, p) => {
    if (u.hostname === 'oauth2.googleapis.com') return { status: 200, json: { access_token: 'AT' } };
    if (u.hostname === 'i.ytimg.com') return { status: 200, json: {} };
    if (u.pathname.endsWith('/channels')) return { status: 200, json: { items: [{ id: 'UC1', snippet: { title: 'SalamMotion', description: '' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] } };
    if (u.pathname.endsWith('/playlistItems')) return { status: 200, json: p.pageToken ? { items: [{ contentDetails: { videoId: 'V2' } }] } : { items: [{ contentDetails: { videoId: 'V1' } }], nextPageToken: 'n' } };
    if (u.pathname.endsWith('/videos') && method === 'GET') return { status: 200, json: { items: p.id.split(',').filter(i => vids[i]).map(i => ({ id: i, snippet: { ...vids[i], publishedAt: 'x', thumbnails: {} }, contentDetails: { duration: 'PT3M' }, status: { privacyStatus: i === 'V1' ? 'unlisted' : 'public', selfDeclaredMadeForKids: false }, statistics: {} })) } };
    if (u.pathname.endsWith('/videos') && method === 'PUT') return { status: 200, json: { id: p.id } };
    if (u.pathname.endsWith('/thumbnails/set')) return { status: 200, json: {} };
  };
  const out = path.join(dir, 'rep');
  const rows = await report({ env: yEnv, fetchFn: fakeFetch(h), outDir: out });
  assert.deepEqual(rows.map(r => [r.id, r.privacy]), [['V1', 'unlisted'], ['V2', 'public']]);
  const rj = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
  assert.equal(rj.channel.title, 'SalamMotion'); assert.ok(!JSON.stringify(rj).includes('1//rt'));
  await readFile(path.join(out, 'img', 'V1-hq2.jpg'));
  // правки
  const ef = path.join(dir, 'edits.json'); await writeFile(path.join(dir, 'th.jpg'), 'jpg');
  await writeFile(ef, JSON.stringify([
    { id: 'V1', title: 'Реклама шоколада из одной фразы', description: 'Описание', tags: ['ии'], thumbnail: 'th.jpg' },
    { id: 'V2', title: 'x'.repeat(101) },
    { id: 'NO', title: 'нет такого' },
    { idHash: idHash('V2'), title: 'По отпечатку', ai: true },
    { idHash: '0000000000000000', title: 'чужое' },
    { id: 'V2', account: 'en', title: 'чужой аккаунт' }]));
  const calls = [];
  const done = await apply({ env: yEnv, fetchFn: fakeFetch(h, calls), file: ef, repoRoot: dir });
  process.exitCode = 0;
  assert.deepEqual(done, ['V1', idHash('V2')]);
  const put = calls.find(c => c.method === 'PUT');
  const put2 = calls.filter(c => c.method === 'PUT')[1].params;
  assert.equal(put2.id, 'V2'); assert.deepEqual(put2.status, { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true });
  assert.equal(put.params.snippet.title, 'Реклама шоколада из одной фразы'); assert.equal(put.params.snippet.categoryId, '22');
  assert.ok(calls.some(c => c.url.endsWith('/thumbnails/set')), 'превью загружено');
  const saved = JSON.parse(await readFile(ef, 'utf8'));
  assert.ok(saved[0].applied); assert.match(saved[1].error, /100/); assert.match(saved[2].error, /не найдено/); assert.ok(saved[3].applied && !saved[3].id); assert.match(saved[4].error, /не найдено/); assert.ok(!saved[5].applied && !saved[5].error);
  assert.ok(!JSON.stringify(saved).includes('"V2"') || saved[1].id === 'V2');
  // описание канала: остальные настройки оформления сохраняются
  const ch = []; const hc = (m, u, p) => u.pathname.endsWith('/channels') && m === 'GET' ? { status: 200, json: { items: [{ id: 'UC1', brandingSettings: { channel: { title: 'SalamMotion', country: 'TM' }, image: { x: 1 } } }] } } : u.pathname.endsWith('/channels') ? { status: 200, json: {} } : h(m, u, p);
  const ef2 = path.join(dir, 'edits2.json'); await writeFile(ef2, JSON.stringify([{ channel: true, description: 'Видео из одной фразы' }]));
  assert.deepEqual(await apply({ env: yEnv, fetchFn: fakeFetch(hc, ch), file: ef2, repoRoot: dir }), ['channel']);
  const cput = ch.find(c => c.method === 'PUT').params;
  assert.deepEqual(cput.brandingSettings, { channel: { title: 'SalamMotion', country: 'TM', description: 'Видео из одной фразы' }, image: { x: 1 } });
  // повторный запуск ничего не трогает у применённых
  const calls2 = []; await apply({ env: yEnv, fetchFn: fakeFetch(h, calls2), file: ef, repoRoot: dir }); process.exitCode = 0;
  assert.ok(!calls2.some(c => c.method === 'PUT' && c.params.id === 'V1'));
}
console.log('ok 30 оформление видео YouTube');

console.log('\nВсе проверки пройдены');
