// Посредник между страницей /design/ и нейросетью для генерации интерьера.
// Работает как Cloudflare Worker. Ключ нейросети хранится только здесь (секрет OPENAI_API_KEY),
// страница его никогда не видит.
//
// Настройки (wrangler.toml → [vars], либо секреты через `wrangler secret put`):
//   OPENAI_API_KEY   секрет, обязателен
//   ALLOWED_ORIGINS  адреса сайтов через запятую, которым можно обращаться (CORS)
//   APP_TOKENS       секрет, необязателен: список ключей доступа клиентов через запятую.
//                    Если задан, запрос без подходящего ключа отклоняется (основа для подписки).
//   IMAGE_MODEL      модель, по умолчанию gpt-image-1
//   IMAGE_QUALITY    low | medium | high, по умолчанию medium (влияет на цену)
//   MAX_VARIANTS     сколько вариантов за один запрос максимум, по умолчанию 2
//   ALLOW_LOCAL      "1" разрешает запросы с локального файла (для проверки на своём компьютере)

const STYLES = {
  scandi:  'Scandinavian style: white and light wood palette, natural materials, soft daylight, cozy textiles',
  loft:    'industrial loft style: exposed brick, concrete, black metal details, warm bulbs',
  modern:  'modern minimalist style: clean lines, neutral palette, concealed storage, matte surfaces',
  classic: 'classic style: wall moldings, symmetrical layout, warm timeless palette, brass details',
  japandi: 'Japandi style: warm wood, muted earth tones, simple natural forms, calm atmosphere',
  eco:     'eco style: natural stone, wood, plants, linen, green and beige palette',
};
const ROOMS = {
  bathroom: 'bathroom', kitchen: 'kitchen', living: 'living room',
  bedroom: 'bedroom', hall: 'hallway', other: 'room',
};
const MAX_BODY = 7 * 1024 * 1024; // ~5 МБ картинки после base64

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors } });

function corsFor(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || 'https://artega909-del.github.io').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || (env.ALLOW_LOCAL === '1' && (origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)));
  return {
    ok,
    headers: ok ? {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-app-token',
      'access-control-max-age': '86400',
      vary: 'origin',
    } : { vary: 'origin' },
  };
}

export function buildPrompt({ style, room, wish }) {
  const roomName = ROOMS[room] || ROOMS.other;
  const styleText = STYLES[style] || STYLES.modern;
  const w = String(wish || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
  return [
    `Photorealistic interior design visualization of this exact ${roomName}, shown as a finished, professionally renovated space.`,
    'Keep the camera angle, perspective, room proportions and the positions of windows, doors and structural elements exactly as in the photo.',
    'Remove construction debris, dust, exposed wires, peeling plaster and any damage, and build all surfaces anew: walls, floor, ceiling, lighting, fixtures and furniture.',
    `Style: ${styleText}.`,
    w ? `Client wishes: ${w}.` : '',
    'Natural realistic lighting, high detail, no text, no watermarks, no people.',
  ].filter(Boolean).join(' ');
}

function pickSize(w, h) {
  const r = w / h;
  if (r > 1.2) return '1536x1024';
  if (r < 0.83) return '1024x1536';
  return '1024x1024';
}

function parseDataUrl(s) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s || '');
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { type: m[1], bytes };
}

export default {
  async fetch(request, env) {
    const cors = corsFor(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors.ok ? 204 : 403, headers: cors.headers });
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true }, 200, cors.headers);
    if (!cors.ok) return json({ error: 'Этому сайту запрещено обращаться к серверу генерации.' }, 403, cors.headers);
    if (request.method !== 'POST' || url.pathname !== '/generate') return json({ error: 'Не найдено.' }, 404, cors.headers);

    if (!env.OPENAI_API_KEY) return json({ error: 'На сервере не задан ключ нейросети.' }, 500, cors.headers);

    if (env.APP_TOKENS) {
      const tokens = env.APP_TOKENS.split(',').map(s => s.trim()).filter(Boolean);
      if (!tokens.includes(request.headers.get('x-app-token') || '')) {
        return json({ error: 'Неверный ключ доступа. Проверьте его в настройках.' }, 401, cors.headers);
      }
    }

    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_BODY) return json({ error: 'Фото слишком большое. Уменьшите его и повторите.' }, 413, cors.headers);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Некорректный запрос.' }, 400, cors.headers); }

    const img = parseDataUrl(body.image);
    if (!img) return json({ error: 'Нужно фото в формате JPG, PNG или WebP.' }, 400, cors.headers);
    if (img.bytes.length > 5 * 1024 * 1024) return json({ error: 'Фото слишком большое. Уменьшите его и повторите.' }, 413, cors.headers);

    const maxN = Math.max(1, Math.min(4, Number(env.MAX_VARIANTS || 2)));
    const n = Math.max(1, Math.min(maxN, Math.floor(Number(body.n) || 1)));
    const w = Number(body.width) || 1, h = Number(body.height) || 1;

    const fd = new FormData();
    fd.append('model', env.IMAGE_MODEL || 'gpt-image-1');
    fd.append('prompt', buildPrompt(body));
    fd.append('n', String(n));
    fd.append('size', pickSize(w, h));
    fd.append('quality', env.IMAGE_QUALITY || 'medium');
    fd.append('output_format', 'jpeg');
    fd.append('output_compression', '85');
    fd.append('image', new Blob([img.bytes], { type: img.type }), img.type === 'image/png' ? 'room.png' : 'room.jpg');

    let up;
    try {
      up = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST', headers: { authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: fd,
      });
    } catch {
      return json({ error: 'Не удалось связаться с нейросетью. Повторите через минуту.' }, 502, cors.headers);
    }

    let data = null;
    try { data = await up.json(); } catch { /* ответ не JSON */ }
    if (!up.ok) {
      const code = data && data.error && (data.error.code || data.error.type) || '';
      const msg = /moderation|safety/i.test(code) ? 'Нейросеть отклонила это фото или описание. Попробуйте другой снимок или уберите лишнее из пожеланий.'
        : up.status === 429 ? 'Слишком много запросов или закончился лимит у провайдера. Повторите позже.'
        : up.status === 401 ? 'Ключ нейросети на сервере недействителен.'
        : 'Нейросеть не смогла нарисовать вариант. Попробуйте ещё раз.';
      return json({ error: msg }, up.status === 429 ? 429 : 502, cors.headers);
    }
    const images = ((data && data.data) || []).filter(d => d.b64_json).map(d => 'data:image/jpeg;base64,' + d.b64_json);
    if (!images.length) return json({ error: 'Нейросеть не вернула картинку. Попробуйте ещё раз.' }, 502, cors.headers);
    return json({ images }, 200, cors.headers);
  },
};
