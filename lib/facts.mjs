// HTML → факты. Чистая функция: та же строка на входе даёт тот же результат.
//
// Единственное место в проекте, которое знает про разметку. Всё остальное работает
// с этим объектом, поэтому проверки не ломаются от смены вёрстки, а факты можно
// перевывести из сохранённого HTML прошлого прогона (lib/check.mjs --from-run).

import * as cheerio from 'cheerio';
import { findPrices } from './price.mjs';
import { clip, collapse, wordCount } from './text.mjs';

export const FACTS_VERSION = 2;

/** Регистрируемый домен без www: aviasales.ru у www.aviasales.ru и img.avs.io у avs.io. */
function site(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  return parts.length <= 2 ? h : parts.slice(-2).join('.');
}

function abs(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function linkKind(href) {
  const h = String(href || '').trim();
  if (!h || h === '#') return 'empty';
  if (h.startsWith('#')) return 'anchor';
  if (/^mailto:/i.test(h)) return 'mailto';
  if (/^tel:/i.test(h)) return 'tel';
  if (/^javascript:/i.test(h)) return 'javascript';
  if (/^data:/i.test(h)) return 'data';
  if (/^https?:/i.test(h) || h.startsWith('/') || h.startsWith('.') || /^[\w.-]+\//.test(h)) return 'http';
  return 'other';
}

function relTokens(rel) {
  return String(rel || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// Заглушки защиты от ботов. Их нельзя проверять как страницу: у заглушки нет ни title,
// ни h1, ни ссылок, и проверки честно «находят» нарушения по всем пунктам, а diff
// объявляет вчерашние проблемы устранёнными. Поэтому такой ответ распознаётся отдельно.
const WAF_MARKERS = ['awswafcookiedomainlist', 'gokuprops', 'cf-browser-verification'];
const CHALLENGE_MARKERS = ['captcha', 'just a moment', 'are you a robot', 'доступ ограничен'];
const SUSPICIOUS_SIZE = 20_000;

/**
 * Причина, по которой ответ нельзя считать страницей, или null.
 * @param {number|null} status
 * @param {string|null} html
 */
export function botWallReason(status, html) {
  if (status === 429) return 'сервер ответил 429 — слишком много запросов';

  const source = String(html ?? '');
  const lower = source.toLowerCase();

  // Маркеры WAF однозначны — размер не важен.
  const waf = WAF_MARKERS.find((m) => lower.includes(m));
  if (waf) return `вместо страницы заглушка защиты от ботов (маркер «${waf}»)`;

  // Общие слова вроде captcha на настоящей странице встречаются в скриптах,
  // поэтому они считаются признаком только у подозрительно короткого ответа.
  const small = source.length < SUSPICIOUS_SIZE;
  const challenge = small ? CHALLENGE_MARKERS.find((m) => lower.includes(m)) : null;
  if (challenge) return `вместо страницы проверка на робота (маркер «${challenge}»)`;

  if (status === 202 && small) {
    return `HTTP 202 и всего ${source.length} байт вместо страницы — похоже на заглушку защиты`;
  }
  return null;
}

/** Разбор URL страницы: то, что нужно проверкам про чистоту URL и canonical. */
export function urlFacts(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { valid: false, href: String(rawUrl) };
  }
  return {
    valid: true,
    href: u.toString(),
    origin: u.origin,
    protocol: u.protocol.replace(':', ''),
    host: u.host,
    site: site(u.host),
    pathname: u.pathname,
    segments: u.pathname.split('/').filter(Boolean),
    search: u.search,
    params: [...u.searchParams.keys()],
    hash: u.hash,
  };
}

/**
 * @param {string} html — сырой HTML (до гидрации) или serialize отрендеренного DOM
 * @param {string} baseUrl — для превращения относительных ссылок в абсолютные
 *
 * Внутренняя ссылка — только на домен самой страницы; поддомены считаются им же
 * (www.aviasales.ru и m.aviasales.ru — это aviasales.ru). Наши остальные страновые
 * домены внешние: со страницы aviasales.ru ссылка на aviasales.uz уходит на другой
 * сайт и отдаёт ему вес так же, как чужому, — значит и требования к ней внешние.
 */
export function htmlFacts(html, baseUrl) {
  const source = String(html ?? '');
  const $ = cheerio.load(source);
  const base = $('base[href]').attr('href');
  const resolveBase = base ? abs(base, baseUrl) || baseUrl : baseUrl;
  const pageSite = urlFacts(baseUrl).site;

  const metaByName = {};
  const metaByProperty = {};
  $('meta').each((_, el) => {
    const $el = $(el);
    const content = $el.attr('content');
    const name = $el.attr('name');
    const property = $el.attr('property');
    if (name != null) metaByName[name.trim().toLowerCase()] ??= content ?? '';
    if (property != null) metaByProperty[property.trim().toLowerCase()] ??= content ?? '';
  });

  const prefixed = (source_, prefix) =>
    Object.fromEntries(
      Object.entries(source_)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => [k.slice(prefix.length), collapse(v)]),
    );

  // OG объявляют через property, Twitter — через name, но в жизни встречается и наоборот.
  const og = { ...prefixed(metaByName, 'og:'), ...prefixed(metaByProperty, 'og:') };
  const twitter = { ...prefixed(metaByProperty, 'twitter:'), ...prefixed(metaByName, 'twitter:') };

  const canonicalRaw =
    $('link')
      .filter((_, el) => relTokens($(el).attr('rel')).includes('canonical'))
      .first()
      .attr('href') ?? null;

  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    headings.push({
      level: Number(el.tagName.slice(1)),
      text: collapse($(el).text()),
    });
  });

  const images = [];
  $('img').each((_, el) => {
    const $el = $(el);
    const alt = $el.attr('alt');
    const src = $el.attr('src') ?? $el.attr('data-src') ?? null;
    images.push({
      src,
      srcAbs: src ? abs(src, resolveBase) : null,
      hasAlt: alt !== undefined,
      alt: alt === undefined ? null : collapse(alt),
      altWords: alt ? wordCount(alt) : 0,
      role: $el.attr('role') ?? null,
      loading: $el.attr('loading') ?? null,
      ariaHidden: $el.attr('aria-hidden') ?? null,
    });
  });

  const links = [];
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    const kind = linkKind(href);
    const hrefAbs = kind === 'http' ? abs(href, resolveBase) : null;
    const rel = relTokens($el.attr('rel'));
    const linkSite = hrefAbs ? urlFacts(hrefAbs).site : null;
    links.push({
      href,
      hrefAbs,
      kind,
      rel,
      nofollow: rel.includes('nofollow'),
      target: $el.attr('target') ?? null,
      text: collapse($el.text()),
      site: linkSite,
      internal: Boolean(linkSite) && linkSite === pageSite,
      external: Boolean(linkSite) && linkSite !== pageSite,
    });
  });

  // Цены вместе с блоком, в котором они стоят. Одной суммы недостаточно: «6 031 ₽» в
  // карточке билета и «6 031 ₽» в блоке «Другие перелёты» — разные утверждения, и судить
  // их одинаково нельзя. Что именно значит блок, решают проверки (lib/price-context.mjs),
  // здесь только собираются признаки: ссылка карточки, её текст, заголовок раздела.
  const prices = [];
  // Только тело страницы: в <head> лежит сам <title> с ценой, и без этого ограничения
  // цена из title «находилась на странице» всегда — сама в себе.
  $('body *').each((_, el) => {
    if (el.type !== 'tag') return;
    const own = collapse(
      $(el)
        .contents()
        .filter((__, node) => node.type === 'text')
        .text(),
    );
    if (!own) return;
    const found = findPrices(own);
    if (!found.length) return;

    const $link = $(el).closest('a[href]');
    const href = $link.attr('href') ?? null;

    // Заголовок раздела ищется вверх по дереву: у карточки цены соседнего заголовка нет,
    // он стоит выше — на уровне блока.
    let heading = null;
    for (let node = $(el); node.length && !heading; node = node.parent()) {
      const found_ = node.prevAll('h1, h2, h3, h4, h5, h6').first();
      if (found_.length) heading = collapse(found_.text()) || null;
    }

    // Окружение цены — ближайший предок, у которого уже есть осмысленный текст: по нему
    // видно, что за предложение, и он же идёт в отчёт цитатой.
    let block = own;
    for (let node = $(el).parent(); node.length && block.length < 40; node = node.parent()) {
      block = collapse(node.text());
    }

    for (const price of found) {
      prices.push({
        ...price,
        own: clip(own, 120),
        heading: heading ? clip(heading, 80) : null,
        block: clip(block, 300),
        href,
        hrefAbs: href ? abs(href, resolveBase) : null,
        linkText: $link.length ? clip(collapse($link.text()), 120) : null,
      });
    }
  });

  const jsonld = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      jsonld.push({ raw, parsed: JSON.parse(raw), error: null });
    } catch (err) {
      jsonld.push({ raw, parsed: null, error: err.message });
    }
  });

  // Видимый текст: без скриптов, стилей и служебной разметки.
  const $text = cheerio.load(source);
  $text('script, style, noscript, template, svg, iframe').remove();
  const bodyText = collapse($text('body').length ? $text('body').text() : $text.root().text());

  return {
    facts_version: FACTS_VERSION,
    lang: $('html').attr('lang') ?? null,
    title: $('title').first().length ? collapse($('title').first().text()) : null,
    titleCount: $('title').length,
    description: metaByName.description != null ? collapse(metaByName.description) : null,
    robots: metaByName.robots != null ? collapse(metaByName.robots) : null,
    viewport: metaByName.viewport != null ? collapse(metaByName.viewport) : null,
    canonical: canonicalRaw,
    canonicalAbs: canonicalRaw ? abs(canonicalRaw, resolveBase) : null,
    canonicalCount: $('link').filter((_, el) => relTokens($(el).attr('rel')).includes('canonical')).length,
    hreflang: $('link[hreflang]')
      .map((_, el) => ({ lang: $(el).attr('hreflang'), href: abs($(el).attr('href'), resolveBase) }))
      .get(),
    og,
    twitter,
    metaByName,
    metaByProperty,
    headings,
    h1: headings.filter((h) => h.level === 1).map((h) => h.text),
    images,
    links,
    prices,
    jsonld,
    text: bodyText,
    textLen: bodyText.length,
    bytes: Buffer.byteLength(source, 'utf8'),
  };
}
