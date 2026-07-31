// Статусы ссылок. Собираются один раз за прогон по всем страницам сразу:
// на одной странице ~400 ссылок, между страницами они сильно пересекаются,
// поэтому дедупликация экономит основную часть запросов.

import { probe, mapLimit } from './http.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {Array<{url: string, internal: boolean}>} candidates — уже дедуплицированные ссылки
 * @returns {Promise<{statuses: object, checked: number, total: number, skipped: string[]}>}
 *
 * Темп сознательно низкий. Проверка 650 ссылок на восьми потоках без паузы упирается в
 * защиту от ботов: сайт начинает отдавать заглушку WAF вместо страниц, и следующий прогон
 * приходит уже к заблокированному сайту. Четыре потока с паузой проходят те же ссылки
 * примерно за минуту и не будят защиту.
 */
export async function collectLinks(
  candidates,
  { limit = 1000, concurrency = 4, timeoutMs = 15_000, delayMs = 120 } = {},
) {
  // Внутренние ссылки важнее: если упрёмся в лимит, обрежутся внешние.
  const ordered = [...candidates].sort((a, b) => Number(b.internal) - Number(a.internal));
  const toCheck = ordered.slice(0, limit);
  const skipped = ordered.slice(limit).map((c) => c.url);

  const results = await mapLimit(toCheck, concurrency, async (c) => {
    const result = await probe(c.url, { timeoutMs });
    if (delayMs) await sleep(delayMs);
    return result;
  });

  const statuses = {};
  for (const r of results) {
    statuses[r.url] = { status: r.status, error: r.error, method: r.method };
  }

  return {
    statuses,
    checked: toCheck.length,
    total: ordered.length,
    // Не молчим о том, что не проверили: это попадёт в отчёт.
    skipped,
  };
}
