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
    const params = Object.fromEntries(method === 'GET' ? u.searchParams : new URLSearchParams(init.body));
    calls.push({ method, url: u.origin + u.pathname, params });
    const r = handler(method, u, params) || { status: 404, json: { error: { message: 'unhandled' } } };
    if (method === 'HEAD') return new Response(null, { status: r.status });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
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
assert.ok(validate(post({ type: 'VIDEO' })).some(e => /REELS или IMAGE/.test(e)));
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
  assert.equal(calls.length, 1, 'check ничего не публикует');
}
console.log('ok 3 check');

// 4. нет секретов → понятная ошибка с именами, без значений
await assert.rejects(main({ mode: 'check', env: { INSTAGRAM_ACCOUNT_ID: '1' }, fetchFn: fakeFetch(okInstagram()) }), /INSTAGRAM_ACCESS_TOKEN/);
await assert.rejects(main({ mode: 'oops', env, fetchFn: fakeFetch(okInstagram()) }), /Неизвестный режим/);
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
  const create = calls.find(c => c.url.endsWith('/1784/media'));
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

console.log('\nВсе проверки пройдены');
