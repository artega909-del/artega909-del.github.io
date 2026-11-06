// Проверка посредника без настоящей нейросети: запрос к OpenAI подменяется.
// Запуск: node design-api/test.mjs
import worker, { buildPrompt } from './worker.js';
import assert from 'node:assert/strict';

const ORIGIN = 'https://artega909-del.github.io';
const env = { OPENAI_API_KEY: 'sk-test', ALLOWED_ORIGINS: ORIGIN, MAX_VARIANTS: '2' };
const pixel = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
const req = (body, headers = {}, method = 'POST', path = '/generate') =>
  new Request('https://api.example.com' + path, {
    method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });

let upstream;
globalThis.fetch = async (url, init) => { upstream = { url, init }; return upstream.reply; };
const reply = (status, obj) => { upstream = { reply: new Response(JSON.stringify(obj), { status }) }; };
const run = async (r, e = env) => { const res = await worker.fetch(r, e); return { res, data: await res.json().catch(() => null) }; };
const setReply = (status, obj) => { const rep = new Response(JSON.stringify(obj), { status }); globalThis.fetch = async (url, init) => { upstream = { url, init }; return rep; }; };

// 1. успешная генерация
setReply(200, { data: [{ b64_json: 'AAA' }, { b64_json: 'BBB' }] });
let { res, data } = await run(req({ image: pixel, style: 'scandi', room: 'bathroom', wish: 'светлая плитка', n: 5, width: 720, height: 1280 }));
assert.equal(res.status, 200); assert.deepEqual(data.images, ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']);
assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
const sent = upstream.init.body;
assert.equal(upstream.url, 'https://api.openai.com/v1/images/edits');
assert.equal(upstream.init.headers.authorization, 'Bearer sk-test');
assert.equal(sent.get('n'), '2', 'n ограничен MAX_VARIANTS');
assert.equal(sent.get('size'), '1024x1536', 'вертикальное фото → вертикальный размер');
assert.match(sent.get('prompt'), /Scandinavian/); assert.match(sent.get('prompt'), /bathroom/);
console.log('ok 1 генерация, ограничение числа вариантов, размер');

// 2. чужой сайт
({ res } = await run(req({ image: pixel }, { origin: 'https://evil.example' })));
assert.equal(res.status, 403); console.log('ok 2 чужой сайт отклонён');

// 3. ключ доступа
const withTok = { ...env, APP_TOKENS: 'k1,k2' };
({ res } = await run(req({ image: pixel }), withTok)); assert.equal(res.status, 401);
setReply(200, { data: [{ b64_json: 'X' }] });
({ res } = await run(req({ image: pixel }, { 'x-app-token': 'k2' }), withTok)); assert.equal(res.status, 200);
console.log('ok 3 ключ доступа');

// 4. плохой ввод
({ res } = await run(req({ image: 'не картинка' }))); assert.equal(res.status, 400);
({ res } = await run(req({ image: pixel }, {}, 'GET', '/generate'))); assert.equal(res.status, 404);
console.log('ok 4 плохой ввод');

// 5. ошибки провайдера
setReply(400, { error: { code: 'moderation_blocked' } });
({ res, data } = await run(req({ image: pixel }))); assert.equal(res.status, 502); assert.match(data.error, /отклонила/);
setReply(429, { error: { code: 'rate_limit_exceeded' } });
({ res } = await run(req({ image: pixel }))); assert.equal(res.status, 429);
setReply(200, { data: [] });
({ res } = await run(req({ image: pixel }))); assert.equal(res.status, 502);
({ res, data } = await run(req({ image: pixel }), { ...env, OPENAI_API_KEY: '' })); assert.equal(res.status, 500);
console.log('ok 5 ошибки провайдера');

// 6. предварительный запрос браузера и ключ не утекает в ответ
({ res } = await run(req(null, { 'access-control-request-method': 'POST' }, 'OPTIONS'))); assert.equal(res.status, 204);
setReply(200, { data: [{ b64_json: 'Z' }] });
const raw = await (await worker.fetch(req({ image: pixel }), env)).text(); assert.ok(!raw.includes('sk-test'));
assert.ok(!buildPrompt({ wish: 'a\nb' }).includes('\n'));
console.log('ok 6 CORS, ключ не утекает');
