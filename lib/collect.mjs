#!/usr/bin/env node
// Сбор артефактов прогона. Ходит в сеть, ничего не проверяет и ничего не решает.
//
//   node lib/collect.mjs --all
//   node lib/collect.mjs --slug countries-tailand
//   node lib/collect.mjs --url https://www.aviasales.ru/countries/turtsiya
//   node lib/collect.mjs --all --static-only     # только HTTP, без браузера и Lighthouse
//
// Если страница отдала редирект, сохраняется и цепочка редиректов (её проверяет
// правило http-status), и HTML конечной страницы — то есть того, что реально видит
// пользователь. Проверки контента идут по нему.

import { parseArgs } from 'node:util';
import {
  configForType,
  pages as configuredPages,
  pauseReason,
  scope,
  internalLinkLimit,
} from './config.mjs';
import { ARTIFACTS, SITE_SLUG, newRunId, writeArtifact } from './bundle.mjs';
import { htmlFacts, urlFacts } from './facts.mjs';
import { fetchChain } from './collect/http.mjs';
import { collectRobots, collectSitemap } from './collect/site.mjs';
import { collectLinks } from './collect/links.mjs';

const TYPE_BY_SEGMENT = {
  countries: 'country',
  cities: 'city',
  routes: 'route',
  airlines: 'airline',
  airports: 'airport',
  hotels: 'hotel',
};

/** Страница, заданная только URL: слаг и тип выводятся из пути. */
function pageFromUrl(url) {
  const u = urlFacts(url);
  if (!u.valid) throw new Error(`невалидный URL: ${url}`);
  return {
    slug: u.segments.join('-') || u.host.replace(/\./g, '-'),
    url,
    type: TYPE_BY_SEGMENT[u.segments[0]] ?? 'unknown',
    label: u.segments.at(-1) ?? u.host,
    adhoc: true,
  };
}

function selectPages(values) {
  if (values.url) return values.url.map(pageFromUrl);
  const all = configuredPages();
  if (values.slug?.length) {
    const wanted = new Set(values.slug);
    const found = all.filter((p) => wanted.has(p.slug));
    const missing = [...wanted].filter((s) => !found.some((p) => p.slug === s));
    if (missing.length) throw new Error(`нет таких страниц в config/pages.json: ${missing.join(', ')}`);
    return found;
  }
  if (values.all) return all;
  throw new Error('нужен один из аргументов: --all, --slug <slug> или --url <url>');
}

async function collectPage(runId, page, log) {
  const res = await fetchChain(page.url);
  const status = res.final?.status ?? null;

  const meta = {
    slug: page.slug,
    url: page.url,
    label: page.label ?? null,
    type: page.type ?? 'unknown',
    adhoc: Boolean(page.adhoc),
    collected_at: new Date().toISOString(),
    http: {
      requested: res.requested,
      chain: res.chain,
      final: res.final,
      redirected: res.redirected,
      loadMs: res.loadMs,
      error: res.error,
    },
  };

  writeArtifact(runId, page.slug, ARTIFACTS.meta, meta);
  if (res.html != null) writeArtifact(runId, page.slug, ARTIFACTS.rawHtml, res.html);

  const shape = res.error
    ? `ошибка: ${res.error}`
    : `${status}${res.redirected ? ` (после ${res.chain.length - 1} редиректа)` : ''}, ${
        res.final?.bytes ?? 0
      } байт, ${res.loadMs} мс`;
  log(`  ${page.slug}: ${shape}`);

  return { meta, html: res.html };
}

async function main() {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean', default: false },
      slug: { type: 'string', multiple: true },
      url: { type: 'string', multiple: true },
      'static-only': { type: 'boolean', default: false },
      'no-lighthouse': { type: 'boolean', default: false },
      'run-id': { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });

  const paused = pauseReason();
  if (paused && !values.force) {
    console.error(`${paused}. Снять паузу в config/pause.json или запустить с --force.`);
    process.exit(3);
  }

  const selected = selectPages(values);
  const runId = values['run-id'] ?? newRunId();
  const log = (line) => console.log(line);
  const startedAt = new Date().toISOString();

  log(`Прогон ${runId}: ${selected.length} стр., режим ${values['static-only'] ? 'только HTTP' : 'HTTP + браузер'}`);

  const collected = [];
  for (const page of selected) {
    collected.push(await collectPage(runId, page, log));
  }

  // ── robots.txt и sitemap, по одному разу на хост ──────────────────────────
  const byOrigin = new Map();
  for (const { meta, html } of collected) {
    const effective = meta.http.final?.url ?? meta.url;
    const u = urlFacts(effective);
    if (!u.valid) continue;
    if (!byOrigin.has(u.origin)) byOrigin.set(u.origin, { targets: new Set(), pages: [] });
    const bucket = byOrigin.get(u.origin);
    // Ищем в sitemap только итоговый URL. Запрошенный, если он редиректит, туда попасть
    // и не должен — это забота правила http-status, а лишняя цель ломает ранний выход
    // поиска и заставляет скачивать все под-сайтмапы (~130 МБ) на каждом прогоне.
    bucket.targets.add(effective);
    bucket.pages.push({ meta, html });
  }

  const site = {};
  for (const [origin, bucket] of byOrigin) {
    log(`  ${origin}: robots.txt`);
    const robots = await collectRobots(origin);
    const entryPoints = [...new Set([...(robots.sitemaps ?? []), `${origin}/sitemap.xml`])];
    log(`  ${origin}: sitemap (${entryPoints.length} точк(и) входа, поиск ${bucket.targets.size} URL)`);
    const sitemap = await collectSitemap(entryPoints, [...bucket.targets]);
    log(`    просмотрено файлов: ${sitemap.filesChecked}/${sitemap.filesTotal}${sitemap.truncated ? ' (лимит)' : ''}`);
    site[origin] = { robots, sitemap };
  }

  // ── ссылки: дедуп по всем страницам прогона ───────────────────────────────
  const linkLimit = Math.max(
    ...selected.map((p) => configForType(p.type).thresholds.link_check_limit ?? 500),
  );
  const scopeConf = scope();
  const internalLimit = internalLinkLimit(scopeConf);
  const candidates = new Map();
  let internalOnPages = 0;

  for (const { meta, html } of collected) {
    if (html == null) continue;
    const base = meta.http.final?.url ?? meta.url;
    // Лимит внутренних ссылок считается по странице, а не по прогону: иначе одна
    // страница с большим блоком ссылок съела бы квоту у всех остальных.
    const pageInternal = new Set();

    for (const link of htmlFacts(html, base).links) {
      if (link.kind !== 'http' || !link.hrefAbs) continue;

      if (link.internal) {
        if (!pageInternal.has(link.hrefAbs)) {
          internalOnPages++;
          if (internalLimit != null && pageInternal.size >= internalLimit) continue;
          pageInternal.add(link.hrefAbs);
        }
      }

      if (!candidates.has(link.hrefAbs)) {
        candidates.set(link.hrefAbs, { url: link.hrefAbs, internal: link.internal });
      }
    }
  }

  const internalPicked = [...candidates.values()].filter((c) => c.internal).length;
  log(
    `  ссылки: внутренних ${internalPicked} из ${internalOnPages}` +
      `${internalLimit != null ? ` (лимит ${internalLimit} на страницу, режим разработки)` : ''}` +
      `, внешних ${candidates.size - internalPicked}`,
  );
  const links = await collectLinks([...candidates.values()], { limit: linkLimit });
  // Условия проверки едут вместе с результатом: по ним проверки понимают, что
  // непроверенная ссылка — это лимит, а не пропуск.
  links.scope = scopeConf;
  log(`    проверено ${links.checked}/${links.total}${links.skipped.length ? `, не проверено ${links.skipped.length}` : ''}`);

  if (!values['static-only']) {
    const { collectBrowser } = await import('./collect/browser.mjs');
    await collectBrowser(runId, collected, {
      log,
      lighthouse: !values['no-lighthouse'],
    });
  }

  writeArtifact(runId, SITE_SLUG, 'site.json', site);
  writeArtifact(runId, SITE_SLUG, 'links.json', links);
  writeArtifact(runId, SITE_SLUG, 'collect.json', {
    runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    mode: values['static-only'] ? 'static' : values['no-lighthouse'] ? 'browser' : 'full',
    pages: collected.map(({ meta }) => ({
      slug: meta.slug,
      url: meta.url,
      final: meta.http.final?.url ?? null,
      status: meta.http.final?.status ?? null,
      error: meta.http.error,
    })),
  });

  log(`Готово. Артефакты: data/runs/${runId}/`);
  log(`Дальше: node lib/check.mjs --run ${runId}`);
}

main().catch((err) => {
  console.error(`collect: ${err.message}`);
  process.exit(1);
});
