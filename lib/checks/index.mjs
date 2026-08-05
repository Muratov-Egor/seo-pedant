// Реестр проверок. Единственное место, где перечислены все проверки бота.
//
// Добавить проверку: создать файл в seo/ (или в папке нового семейства),
// дописать import и строку в ALL_CHECKS, добавить тесты в tests/checks/.
// Порядок в массиве определяет порядок пунктов в отчёте.
//
// Семейство — это раздел отчёта: техническое SEO и содержание страницы читают разные
// люди и правят разными руками, поэтому в отчёте они не перемешиваются.

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
import titlePrice from './content/01-title-price.mjs';

/**
 * Семейства проверок в порядке разделов отчёта. Ключ — поле family у проверки.
 * Новое семейство добавляется здесь: без записи реестр проверок не соберётся.
 */
export const FAMILIES = [
  {
    id: 'seo-checklist',
    title: 'SEO-проверки',
    // Короткая метка — для строчных сводок: в Slack «Проверки контента» на каждой строке
    // съедает половину ширины, а различать семейства всё равно надо.
    short: 'SEO',
    about: 'Техническое SEO: разметка, метатеги, ссылки, скорость.',
  },
  {
    id: 'content',
    title: 'Проверки контента',
    short: 'Контент',
    about: 'Что страница обещает и что показывает: цены, тексты, соответствие обещанию.',
  },
];

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
  titlePrice,
];

const ids = new Set();
const knownFamilies = new Set(FAMILIES.map((f) => f.id));
for (const check of ALL_CHECKS) {
  for (const field of ['id', 'checklist', 'family', 'scope', 'severity']) {
    if (!check[field]) throw new Error(`у проверки нет поля ${field}: ${check.id ?? '(без id)'}`);
  }
  if (typeof check.run !== 'function') throw new Error(`у проверки ${check.id} нет run()`);
  if (ids.has(check.id)) throw new Error(`дубликат id проверки: ${check.id}`);
  if (!knownFamilies.has(check.family)) {
    throw new Error(`у проверки ${check.id} неизвестное семейство ${check.family} — добавь его в FAMILIES`);
  }
  ids.add(check.id);
}

export function familyById(id) {
  return FAMILIES.find((f) => f.id === id) ?? { id, title: id, short: id, about: null };
}

export function checkById(id) {
  return ALL_CHECKS.find((c) => c.id === id) ?? null;
}

/**
 * Пункты чеклиста в порядке отчёта: один пункт может проверяться несколькими проверками.
 * Пункты одного семейства идут подряд — отчёт выводит их разделами.
 */
export function checklistItems() {
  const items = [];
  for (const family of FAMILIES) {
    for (const check of ALL_CHECKS.filter((c) => c.family === family.id)) {
      let item = items.find((i) => i.family === check.family && i.checklist === check.checklist);
      if (!item) {
        item = { checklist: check.checklist, family: check.family, checks: [] };
        items.push(item);
      }
      item.checks.push(check.id);
    }
  }
  return items;
}

/** То же, но разложенное по семействам: [{ family, items }] в порядке разделов отчёта. */
export function familySections() {
  const all = checklistItems();
  return FAMILIES.map((family) => ({
    family,
    items: all.filter((i) => i.family === family.id),
  })).filter((section) => section.items.length);
}
