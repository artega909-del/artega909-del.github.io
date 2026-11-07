// Проверка посредника без настоящей нейросети: запрос к OpenAI подменяется.
// Запуск: node design-api/test.mjs
import worker, { buildPrompt, buildEditPrompt } from './worker.js';
import assert from 'node:assert/strict';

const ORIGIN = 'https://artega909-del.github.io';
const TOKEN = 'k1';
const env = { OPENAI_API_KEY: 'sk-test', ALLOWED_ORIGINS: ORIGIN, MAX_VARIANTS: '2', APP_TOKENS: TOKEN + ',k2', RATE_LIMIT_PER_MIN: '1000' };

// минимальные настоящие заголовки файлов, чтобы пройти проверку размеров
const b64 = bytes => Buffer.from(bytes).toString('base64');
const jpeg = (w, h) => 'data:image/jpeg;base64,' + b64([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const png = (w, h) => 'data:image/png;base64,' + b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, w >>> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255, h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255, 8, 2, 0, 0, 0, 0, 0, 0, 0]);
const pixel = jpeg(768, 1024);

const req = (body, headers = {}, method = 'POST', path = '/generate', raw) =>
  new Request('https://api.example.com' + path, {
    method, headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-app-token': TOKEN, ...headers },
    body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined,
  });

let upstream;
const setReply = (status, obj) => { const rep = () => new Response(JSON.stringify(obj), { status }); globalThis.fetch = async (url, init) => { upstream = { url, init }; return rep(); }; };
const run = async (r, e = env) => { const res = await worker.fetch(r, e); return { res, data: await res.json().catch(() => null) }; };

// 1. успешная генерация
setReply(200, { data: [{ b64_json: 'AAA' }, { b64_json: 'BBB' }] });
let { res, data } = await run(req({ image: pixel, style: 'scandi', room: 'bathroom', wish: 'светлая плитка', n: 5 }));
assert.equal(res.status, 200); assert.deepEqual(data.images, ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']);
assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
const sent = upstream.init.body;
assert.equal(upstream.url, 'https://api.openai.com/v1/images/edits');
assert.equal(upstream.init.headers.authorization, 'Bearer sk-test');
assert.equal(sent.get('n'), '2', 'n ограничен MAX_VARIANTS');
assert.equal(sent.get('size'), '1024x1536', 'вертикальное фото → вертикальный размер (по настоящим размерам файла)');
assert.match(sent.get('prompt'), /Scandinavian/); assert.match(sent.get('prompt'), /bathroom/);
console.log('ok 1 генерация, ограничение числа вариантов, размер по файлу');

// 2. чужой сайт
({ res } = await run(req({ image: pixel }, { origin: 'https://evil.example' })));
assert.equal(res.status, 403); console.log('ok 2 чужой сайт отклонён');

// 3. закрыто по умолчанию, ключи доступа
const noTok = { ...env, APP_TOKENS: '' };
({ res, data } = await run(req({ image: pixel }), noTok)); assert.equal(res.status, 503); assert.match(data.error, /APP_TOKENS/);
({ res } = await run(req({ image: pixel }, { 'x-app-token': 'wrong' }))); assert.equal(res.status, 401);
({ res } = await run(req({ image: pixel }, { 'x-app-token': '' }))); assert.equal(res.status, 401);
setReply(200, { data: [{ b64_json: 'X' }] });
({ res } = await run(req({ image: pixel }, { 'x-app-token': 'k2' }))); assert.equal(res.status, 200);
({ res } = await run(req({ image: pixel }), { ...noTok, ALLOW_OPEN: '1' })); assert.equal(res.status, 200, 'явно открытый режим работает');
console.log('ok 3 закрыто по умолчанию, ключи доступа, открытый режим только явно');

// 4. ограничение частоты
const lim = { ...env, APP_TOKENS: 'k3,k4', RATE_LIMIT_PER_MIN: '2' };
for (let i = 0; i < 2; i++) { ({ res } = await run(req({ image: pixel }, { 'x-app-token': 'k3' }), lim)); assert.equal(res.status, 200); }
({ res } = await run(req({ image: pixel }, { 'x-app-token': 'k3' }), lim)); assert.equal(res.status, 429);
({ res } = await run(req({ image: pixel }, { 'x-app-token': 'k4' }), lim)); assert.equal(res.status, 200, 'у другого ключа свой счётчик');
console.log('ok 4 ограничение частоты по ключу');

// 5. плохой ввод: ни одна ошибка не должна давать пустой 500, ответ всегда с CORS
const bad = async (label, r, status) => { const o = await run(r); assert.equal(o.res.status, status, label + ' → ' + o.res.status); assert.ok(o.data && o.data.error, label + ': нет текста ошибки'); assert.equal(o.res.headers.get('access-control-allow-origin'), ORIGIN, label + ': нет CORS'); };
await bad('не картинка', req({ image: 'не картинка' }), 400);
await bad('тело null', req(null), 400);
await bad('тело — массив', req([1, 2]), 400);
await bad('не JSON', req(null, {}, 'POST', '/generate', '{oops'), 400);
await bad('битый base64 (проходит регулярку)', req({ image: 'data:image/png;base64,A=A=' }), 400);
await bad('нет заголовка файла', req({ image: 'data:image/jpeg;base64,' + b64([1, 2, 3, 4, 5, 6, 7, 8]) }), 400);
await bad('слишком большое тело (без Content-Length)', req(null, {}, 'POST', '/generate', 'x'.repeat(7 * 1024 * 1024 + 10)), 413);
await bad('PNG 20000×20000', req({ image: png(20000, 20000) }), 413);
await bad('JPEG 7000×7000', req({ image: jpeg(7000, 7000) }), 413);
({ res } = await run(req({ image: pixel }, {}, 'GET', '/generate'))); assert.equal(res.status, 404);
console.log('ok 5 плохой ввод и огромные размеры отклоняются с понятной ошибкой');

// 6. промпт: прототипные ключи не попадают в текст
assert.ok(!buildPrompt({ style: 'constructor', room: '__proto__', wish: 'a\nb' }).includes('native code'));
assert.ok(!buildPrompt({ wish: 'a\nb' }).includes('\n'));
assert.match(buildPrompt({ style: 'constructor' }), /modern minimalist/);
console.log('ok 6 стиль и помещение берутся только из списка');

// 7. ошибки провайдера и нет ключа нейросети
setReply(400, { error: { code: 'moderation_blocked' } });
({ res, data } = await run(req({ image: pixel }))); assert.equal(res.status, 502); assert.match(data.error, /отклонила/);
setReply(429, { error: { code: 'rate_limit_exceeded' } });
({ res } = await run(req({ image: pixel }))); assert.equal(res.status, 429);
setReply(200, { data: [] });
({ res } = await run(req({ image: pixel }))); assert.equal(res.status, 502);
setReply(200, { data: [null, { b64_json: 'Z' }] });
({ res, data } = await run(req({ image: pixel }))); assert.equal(res.status, 200); assert.equal(data.images.length, 1, 'пустые элементы ответа пропускаются');
globalThis.fetch = async () => { throw new Error('сеть'); };
({ res } = await run(req({ image: pixel }))); assert.equal(res.status, 502);
({ res } = await run(req({ image: pixel }), { ...env, OPENAI_API_KEY: '' })); assert.equal(res.status, 500);
console.log('ok 7 ошибки провайдера');

// 8. предварительный запрос браузера и ключ не утекает в ответ
({ res } = await run(req(null, { 'access-control-request-method': 'POST' }, 'OPTIONS'))); assert.equal(res.status, 204);
setReply(200, { data: [{ b64_json: 'Z' }] });
const raw = await (await worker.fetch(req({ image: pixel }), env)).text(); assert.ok(!raw.includes('sk-test'));
console.log('ok 8 CORS, ключ не утекает');

// 9. перерисовка участка по маске (/edit)
const pngA = (w, h, ct = 6) => { const b = Buffer.from(png(w, h).split(',')[1], 'base64'); b[25] = ct; return 'data:image/png;base64,' + b.toString('base64'); };
const ok1024 = jpeg(1024, 1024), mask1024 = pngA(1024, 1024);
setReply(200, { data: [{ b64_json: 'EDIT' }] });
({ res, data } = await run(req({ image: ok1024, mask: mask1024, desc: 'светлый паркет ёлочкой', room: 'bathroom' }, {}, 'POST', '/edit')));
assert.equal(res.status, 200); assert.deepEqual(data.images, ['data:image/jpeg;base64,EDIT']);
const ed = upstream.init.body;
assert.ok(ed.get('mask'), 'маска ушла в нейросеть'); assert.equal(ed.get('size'), '1024x1024'); assert.equal(ed.get('n'), '1');
assert.match(ed.get('prompt'), /only the masked area/); assert.match(ed.get('prompt'), /светлый паркет/); assert.match(ed.get('prompt'), /bathroom/);
for (const [label, body, st] of [
  ['нет описания', { image: ok1024, mask: mask1024, desc: '' }, 400],
  ['нет маски', { image: ok1024, desc: 'паркет' }, 400],
  ['маска — JPEG', { image: ok1024, mask: jpeg(1024, 1024), desc: 'паркет' }, 400],
  ['маска другого размера', { image: ok1024, mask: pngA(1024, 1536), desc: 'паркет' }, 400],
  ['маска без прозрачности (RGB)', { image: ok1024, mask: pngA(1024, 1024, 2), desc: 'паркет' }, 400],
  ['фото недопустимого размера', { image: jpeg(800, 600), mask: pngA(800, 600), desc: 'паркет' }, 400],
]) { const o = await run(req(body, {}, 'POST', '/edit')); assert.equal(o.res.status, st, label + ' → ' + o.res.status); assert.ok(o.data.error, label); assert.equal(o.res.headers.get('access-control-allow-origin'), ORIGIN, label + ': CORS'); }
({ res } = await run(req({ image: ok1024, mask: mask1024, desc: 'паркет' }, { 'x-app-token': 'wrong' }, 'POST', '/edit'))); assert.equal(res.status, 401, '/edit тоже закрыт ключом');
assert.ok(!buildEditPrompt({ desc: 'a\nb\r\nc', room: '__proto__' }).includes('\n'));
console.log('ok 9 перерисовка участка по маске: маска уходит, плохой ввод отклоняется, ключ нужен');

// 10. по итогам второго аудита
// 10a. тело без Content-Length читается потоком и обрывается на лимите
{
  const huge = new ReadableStream({ start(c) { for (let i = 0; i < 12; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1024 * 1024))); c.close(); } });
  const r = new Request('https://api.example.com/generate', { method: 'POST', headers: { origin: ORIGIN, 'x-app-token': TOKEN, 'content-type': 'application/json' }, body: huge, duplex: 'half' });
  const o = await run(r); assert.equal(o.res.status, 413, 'огромное потоковое тело отклонено');
}
// 10b. в открытом режиме случайные значения x-app-token не обходят лимит
{
  const open = { ...env, APP_TOKENS: '', ALLOW_OPEN: '1', RATE_LIMIT_PER_MIN: '2' };
  setReply(200, { data: [{ b64_json: 'X' }] });
  const ipH = { 'cf-connecting-ip': '203.0.113.9' }; let last;
  for (let i = 0; i < 4; i++) last = (await run(req({ image: pixel }, { ...ipH, 'x-app-token': 'rnd' + i }), open)).res.status;
  assert.equal(last, 429, 'лимит считается по IP, а не по подставному ключу');
}
// 10c. маска: сигнатура PNG и IHDR проверяются целиком, размер ограничен
{
  const bad = Buffer.from(png(1024, 1024).split(',')[1], 'base64'); bad[2] = 0; // портим сигнатуру
  const o1 = await run(req({ image: ok1024, mask: 'data:image/png;base64,' + bad.toString('base64'), desc: 'паркет' }, {}, 'POST', '/edit')); assert.equal(o1.res.status, 400, 'битая сигнатура PNG');
  const big = Buffer.concat([Buffer.from(pngA(1024, 1024).split(',')[1], 'base64'), Buffer.alloc(4 * 1024 * 1024 + 10)]);
  const o2 = await run(req({ image: ok1024, mask: 'data:image/png;base64,' + big.toString('base64'), desc: 'паркет' }, {}, 'POST', '/edit')); assert.equal(o2.res.status, 413, 'маска больше 4 МБ');
}
console.log('ok 10 поток с лимитом, лимит по IP в открытом режиме, строгая проверка маски');
