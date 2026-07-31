// Оценка перформанса. Гоняется в том же браузере, что и остальные браузерные проверки:
// Lighthouse подключается к нему по CDP-порту, поэтому второй Chrome не нужен.
//
// Оценка шумит на ±10 между прогонами на одной и той же странице. Поэтому в отчёт идёт
// и число, и предупреждение о разбросе, а в отпечаток находки оценка не входит вовсе
// (см. lib/checks/seo/22-performance.mjs).

import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';

const METRICS = [
  'first-contentful-paint',
  'largest-contentful-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
  'speed-index',
];

async function runOne(url, port, formFactor) {
  try {
    const result = await lighthouse(
      url,
      { port, output: 'json', logLevel: 'error', onlyCategories: ['performance'] },
      formFactor === 'desktop' ? desktopConfig : undefined,
    );
    const lhr = result?.lhr;
    if (!lhr) throw new Error('Lighthouse не вернул результат');

    const score = lhr.categories?.performance?.score;
    const metrics = Object.fromEntries(
      METRICS.filter((id) => lhr.audits?.[id]).map((id) => [
        lhr.audits[id].title ?? id,
        lhr.audits[id].displayValue ?? String(lhr.audits[id].numericValue ?? ''),
      ]),
    );

    return {
      score: score == null ? null : Math.round(score * 100),
      metrics,
      version: lhr.lighthouseVersion ?? null,
      fetched_at: lhr.fetchTime ?? null,
      error: score == null ? 'оценка перформанса не посчитана' : null,
    };
  } catch (err) {
    return { score: null, metrics: {}, version: null, fetched_at: null, error: err.message };
  }
}

export async function runLighthouse(url, port, log = () => {}) {
  const out = {};
  for (const formFactor of ['desktop', 'mobile']) {
    out[formFactor] = await runOne(url, port, formFactor);
    const r = out[formFactor];
    log(`    lighthouse ${formFactor}: ${r.error ? `ошибка — ${r.error}` : r.score}`);
  }
  return out;
}
