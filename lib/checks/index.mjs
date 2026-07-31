// Реестр проверок. Единственное место, где перечислены все проверки бота.
//
// Добавить проверку: создать файл в seo/ (или в папке нового семейства),
// дописать import и строку в ALL_CHECKS, добавить тесты в tests/checks/.
// Порядок в массиве определяет порядок пунктов в отчёте.

import httpStatus from './seo/01-http-status.mjs';
import urlClean from './seo/02-url-clean.mjs';
import title from './seo/03-title.mjs';
import description from './seo/04-description.mjs';
import metaRobots from './seo/05-meta-robots.mjs';
import canonical from './seo/06-canonical.mjs';
import h1 from './seo/07-h1.mjs';
import headings from './seo/08-headings.mjs';
import robotsTxt from './seo/09-robots-txt.mjs';
import sitemap from './seo/10-sitemap.mjs';
import ogTwitter from './seo/11-og-twitter.mjs';
import contentPlaceholder from './seo/12-content-placeholder.mjs';
import keywords from './seo/13-keywords.mjs';
import altTags from './seo/14-alt.mjs';
import linksInternal from './seo/15-links-internal.mjs';
import linksExternal from './seo/16-links-external.mjs';
import structuredData from './seo/17-structured-data.mjs';
import uniqueness from './seo/18-uniqueness.mjs';
import textUniquenessExternal from './seo/19-text-uniqueness-external.mjs';
import ssr from './seo/20-ssr.mjs';
import consoleErrors from './seo/21-console-errors.mjs';
import mobile from './seo/22-mobile.mjs';
import performance from './seo/23-performance.mjs';

export const ALL_CHECKS = [
  httpStatus,
  ssr,
  title,
  description,
  metaRobots,
  canonical,
  h1,
  headings,
  urlClean,
  robotsTxt,
  sitemap,
  ogTwitter,
  contentPlaceholder,
  textUniquenessExternal,
  uniqueness,
  keywords,
  altTags,
  linksInternal,
  linksExternal,
  performance,
  consoleErrors,
  mobile,
  structuredData,
];

const ids = new Set();
for (const check of ALL_CHECKS) {
  for (const field of ['id', 'checklist', 'family', 'scope', 'severity']) {
    if (!check[field]) throw new Error(`у проверки нет поля ${field}: ${check.id ?? '(без id)'}`);
  }
  if (typeof check.run !== 'function') throw new Error(`у проверки ${check.id} нет run()`);
  if (ids.has(check.id)) throw new Error(`дубликат id проверки: ${check.id}`);
  ids.add(check.id);
}

export function checkById(id) {
  return ALL_CHECKS.find((c) => c.id === id) ?? null;
}

/** Пункты чеклиста в порядке отчёта: один пункт может проверяться несколькими проверками. */
export function checklistItems() {
  const items = [];
  for (const check of ALL_CHECKS) {
    let item = items.find((i) => i.checklist === check.checklist);
    if (!item) {
      item = { checklist: check.checklist, checks: [] };
      items.push(item);
    }
    item.checks.push(check.id);
  }
  return items;
}
