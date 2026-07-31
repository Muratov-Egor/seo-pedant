// Сборка объекта facts для тестов: то же, что делает lib/check.mjs, только из строки HTML,
// а не из артефактов прогона. Проверки — чистые функции, поэтому больше ничего не нужно.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlFacts, urlFacts } from '../lib/facts.mjs';
import { keywordsFor } from '../lib/keywords.mjs';
import { configForType, scope } from '../lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = 'https://www.aviasales.ru/countries/turtsiya';

export function fixture(name) {
  return readFileSync(join(HERE, 'fixtures', `${name}.html`), 'utf8');
}

export function factsFor(html, options = {}) {
  const url = options.url ?? DEFAULT_URL;
  const finalUrl = options.finalUrl ?? url;
  // По умолчанию берём наши домены из конфига — так тесты видят ту же картину
  // внутренних и внешних ссылок, что и настоящий прогон.
  const ownDomains = options.ownDomains ?? scope().own_domains;
  return {
    page: {
      slug: options.slug ?? 'countries-turtsiya',
      url,
      label: options.label ?? 'Турция',
      type: options.type ?? 'country',
      adhoc: false,
    },
    http: {
      requested: url,
      chain: [{ url, status: 200, location: null }],
      final: { url: finalUrl, status: 200, contentType: 'text/html', headers: {}, bytes: html.length },
      redirected: false,
      loadMs: 10,
      error: null,
      ...options.http,
    },
    url: urlFacts(url),
    finalUrl: urlFacts(finalUrl),
    html: html == null ? null : htmlFacts(html, finalUrl, { ownDomains }),
    dom: options.dom ? htmlFacts(options.dom, finalUrl, { ownDomains }) : null,
    console: options.console ?? null,
    mobile: options.mobile ?? null,
    lighthouse: options.lighthouse ?? null,
    site: options.site ?? null,
    links: options.links ?? null,
  };
}

export function ctxFor(options = {}) {
  const typeConf = configForType(options.type ?? 'country');
  return {
    thresholds: { ...typeConf.thresholds, ...options.thresholds },
    keywords: keywordsFor({ url: options.url ?? DEFAULT_URL, keywords: options.keywords }),
    config: typeConf,
  };
}

/** Короткая запись «прогнать проверку на этом HTML». */
export function verdictOf(check, html, options = {}) {
  return check.run(factsFor(html, options), ctxFor(options));
}
