// Сетевой слой: единственное место, которое ходит в интернет по HTTP.
//
// Редиректы НЕ следуются автоматически: цепочка редиректов — это предмет проверки
// (чеклист требует 200 без всяких 3xx), поэтому она сохраняется целиком.

// UA обычного десктопного Chrome: нужно видеть ровно то, что отдаётся браузеру,
// иначе CDN может ответить другим HTML и находки будут не про реальную страницу.
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'user-agent': USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers) out[k] = v;
  return out;
}

async function request(url, { timeoutMs, method = 'GET', headers = {} }) {
  return fetch(url, {
    method,
    redirect: 'manual',
    headers: { ...DEFAULT_HEADERS, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Загружает страницу, сохраняя всю цепочку редиректов.
 *
 * @returns {Promise<{requested: string, chain: Array, final: object|null, html: string|null,
 *                    redirected: boolean, loadMs: number, error: string|null}>}
 */
export async function fetchChain(url, { timeoutMs = 30_000, maxHops = 5 } = {}) {
  const started = Date.now();
  const chain = [];
  let current = url;

  for (let hop = 0; hop <= maxHops; hop++) {
    let res;
    try {
      res = await request(current, { timeoutMs });
    } catch (err) {
      return {
        requested: url,
        chain,
        final: null,
        html: null,
        redirected: chain.length > 0,
        loadMs: Date.now() - started,
        error: `${current}: ${err.message}`,
      };
    }

    const location = res.headers.get('location');
    chain.push({ url: current, status: res.status, location: location ?? null });

    if (res.status >= 300 && res.status < 400 && location) {
      let next;
      try {
        next = new URL(location, current).toString();
      } catch {
        return {
          requested: url,
          chain,
          final: null,
          html: null,
          redirected: true,
          loadMs: Date.now() - started,
          error: `нечитаемый Location: ${location}`,
        };
      }
      if (chain.some((c) => c.url === next)) {
        return {
          requested: url,
          chain,
          final: null,
          html: null,
          redirected: true,
          loadMs: Date.now() - started,
          error: `цикл редиректов на ${next}`,
        };
      }
      current = next;
      continue;
    }

    let html = null;
    let error = null;
    try {
      html = await res.text();
    } catch (err) {
      error = `тело ответа не прочитано: ${err.message}`;
    }

    return {
      requested: url,
      chain,
      final: {
        url: current,
        status: res.status,
        contentType: res.headers.get('content-type') ?? null,
        headers: headersToObject(res.headers),
        bytes: html == null ? 0 : Buffer.byteLength(html, 'utf8'),
      },
      html,
      redirected: chain.length > 1,
      loadMs: Date.now() - started,
      error,
    };
  }

  return {
    requested: url,
    chain,
    final: null,
    html: null,
    redirected: true,
    loadMs: Date.now() - started,
    error: `больше ${maxHops} редиректов`,
  };
}

/** Простое чтение текстового ресурса (robots.txt, sitemap.xml). Редиректы следуются. */
export async function fetchText(url, { timeoutMs = 30_000 } = {}) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { ...DEFAULT_HEADERS, accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = res.ok ? await res.text() : null;
    return { url, status: res.status, finalUrl: res.url, text, error: null };
  } catch (err) {
    return { url, status: null, finalUrl: null, text: null, error: err.message };
  }
}

// Ответы, которые означают «мне не нравится твой запрос», а не «страницы нет».
// На HEAD их отдают и серверы без поддержки метода, и антибот-защита: vk.com отвечает
// на HEAD 418, а на GET — 301. Поэтому такой ответ повод повторить запрос через GET.
// 202 сюда входит потому, что защита aviasales.ru отдаёт на проверку ссылки именно его
// вместе с заглушкой WAF: для ссылки на веб-страницу это не «принято», а «не отвечу».
export const REFUSED_STATUSES = new Set([202, 401, 403, 405, 418, 429, 501, 999]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Одна попытка проверки: HEAD, а при отказе — GET.
 * Тело при GET не читается, поток обрывается — иначе проверка сотен ссылок
 * вытянула бы десятки мегабайт.
 */
async function probeOnce(url, timeoutMs) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        headers: { ...DEFAULT_HEADERS, accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      res.body?.cancel?.().catch(() => {});
      if (method === 'HEAD' && REFUSED_STATUSES.has(res.status)) continue;
      return { url, status: res.status, method, finalUrl: res.url, error: null };
    } catch (err) {
      if (method === 'GET') return { url, status: null, method, finalUrl: null, error: err.message };
    }
  }
  return { url, status: null, method: 'GET', finalUrl: null, error: 'не удалось проверить' };
}

/**
 * Проверка доступности ссылки с одним повтором на сетевую ошибку.
 *
 * Сбой сети — это не «ссылка битая». HEAD и GET идут подряд, поэтому одна икота DNS или
 * обрыв соединения убивали сразу обе попытки, и в отчёт приезжала ложная битая ссылка:
 * так случилось с https://www.aviasales.ge/help?language=en, который на проверку руками
 * отвечает 200. Повтор идёт только когда ответа не было вовсе (status === null) — на
 * честный 404 второго запроса не будет, и темп проверки от этого не страдает.
 */
export async function probe(url, { timeoutMs = 15_000, retryDelayMs = 1500 } = {}) {
  const first = await probeOnce(url, timeoutMs);
  if (first.status !== null) return first;

  await sleep(retryDelayMs);
  const second = await probeOnce(url, timeoutMs);
  if (second.status !== null) return second;
  // Обе попытки без ответа — это уже похоже на настоящую проблему, и в находке видно,
  // что дело не в одном неудачном запросе.
  return { ...second, error: `${second.error} (и после повтора)` };
}

/** Параллельная обработка с ограничением одновременных запросов. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
