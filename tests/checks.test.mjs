// У каждой проверки минимум один pass-случай и один fail-случай.
// Это и есть страховка от того, что проверка «работает», но не находит ничего.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_CHECKS, checkById } from '../lib/checks/index.mjs';
import { effectiveSeverity } from '../lib/verdict.mjs';
import { parseRobots, normUrl } from '../lib/collect/site.mjs';
import { ctxFor, factsFor, fixture, verdictOf } from './helpers.mjs';

const GOOD = fixture('country-good');
const BAD = fixture('country-bad');
const URL = 'https://www.aviasales.ru/countries/turtsiya';

function check(id) {
  const found = checkById(id);
  assert.ok(found, `в реестре нет проверки ${id}`);
  return found;
}

function robotsSite(text, { sitemapFound = { [normUrl(URL)]: 'sitemap-1.xml' }, sitemap = {} } = {}) {
  const parsed = parseRobots(text);
  return {
    robots: {
      origin: 'https://www.aviasales.ru',
      url: 'https://www.aviasales.ru/robots.txt',
      status: 200,
      error: null,
      text,
      sitemaps: parsed.sitemaps,
      parsed,
    },
    sitemap: {
      entryPoints: ['https://www.aviasales.ru/sitemap.xml'],
      filesChecked: 2,
      filesTotal: 20,
      truncated: false,
      errors: [],
      found: sitemapFound,
      ...sitemap,
    },
  };
}

const ROBOTS_OK = 'User-agent: *\nDisallow: /search\nSitemap: https://www.aviasales.ru/sitemap.xml';

const NO_LIMITS = { development: { enabled: false, internal_links_per_page: null } };

function linksArtifact(statuses, extra = {}) {
  const count = Object.keys(statuses).length;
  return { statuses, checked: count, total: count, skipped: [], scope: NO_LIMITS, ...extra };
}

/** Статусы на все http-ссылки страницы — как будто проверили и всё ответило одинаково. */
function statusesFor(html, status = 200) {
  const statuses = {};
  for (const link of factsFor(html).html.links) {
    if (link.kind === 'http' && link.hrefAbs) statuses[link.hrefAbs] = { status, error: null, method: 'HEAD' };
  }
  return linksArtifact(statuses);
}

test('реестр проверок согласован', () => {
  assert.equal(ALL_CHECKS.length, 23);
  assert.equal(new Set(ALL_CHECKS.map((c) => c.id)).size, ALL_CHECKS.length);
  assert.ok(ALL_CHECKS.every((c) => ['page', 'site'].includes(c.scope)));
  assert.ok(ALL_CHECKS.every((c) => ['P1', 'P2', 'P3'].includes(c.severity)));
});

test('http-status: 200 без редиректов', () => {
  assert.equal(verdictOf(check('http-status'), GOOD).status, 'pass');

  const redirected = verdictOf(check('http-status'), GOOD, {
    url: 'https://aviasales.ru/countries/tailand',
    http: {
      redirected: true,
      chain: [
        { url: 'https://aviasales.ru/countries/tailand', status: 301, location: 'https://www.aviasales.ru/countries/tailand' },
        { url: 'https://www.aviasales.ru/countries/tailand', status: 200, location: null },
      ],
      final: { url: 'https://www.aviasales.ru/countries/tailand', status: 200, bytes: 1 },
    },
  });
  assert.equal(redirected.status, 'fail');
  assert.match(redirected.findings[0].message, /301/);

  const notFound = verdictOf(check('http-status'), GOOD, {
    http: { final: { url: URL, status: 404, bytes: 1 } },
  });
  assert.equal(notFound.status, 'fail');

  const failed = verdictOf(check('http-status'), GOOD, {
    http: { final: null, error: 'connect ETIMEDOUT' },
  });
  assert.equal(failed.status, 'fail');
});

test('url-clean: без параметров и в нижнем регистре', () => {
  assert.equal(verdictOf(check('url-clean'), GOOD).status, 'pass');

  const dirty = verdictOf(check('url-clean'), GOOD, {
    url: 'https://www.aviasales.ru/countries/Turtsiya_Test?utm_source=mail#top',
  });
  assert.equal(dirty.status, 'fail');
  const entities = dirty.findings.map((f) => f.entity);
  assert.ok(entities.includes('параметры'));
  assert.ok(entities.includes('регистр'));
  assert.ok(entities.includes('подчёркивания'));

  const insecure = verdictOf(check('url-clean'), GOOD, { url: 'http://www.aviasales.ru/countries/turtsiya' });
  assert.equal(insecure.status, 'fail');
});

test('title: есть, не длиннее порога, с ключевыми словами ближе к началу', () => {
  assert.equal(verdictOf(check('title'), GOOD).status, 'pass');
  assert.equal(verdictOf(check('title'), BAD).status, 'fail', 'без <title> — нарушение');

  const long = `<html><head><title>${'Авиабилеты в Турцию '.repeat(6)}</title></head><body></body></html>`;
  const longVerdict = verdictOf(check('title'), long);
  assert.equal(longVerdict.status, 'fail');
  assert.ok(longVerdict.findings.some((f) => f.entity === 'длина'));

  const noKeyword = '<html><head><title>Просто страница про поездки</title></head><body></body></html>';
  assert.ok(verdictOf(check('title'), noKeyword).findings.some((f) => f.entity === 'ключевые слова'));

  // Ключевое слово есть, но в хвосте — это замечание, а не нарушение.
  const late = '<html><head><title>Авиабилеты дешёвые прямые рейсы летом в Турцию</title></head><body></body></html>';
  const lateVerdict = verdictOf(check('title'), late);
  assert.equal(lateVerdict.status, 'warn');
  assert.equal(lateVerdict.findings[0].entity, 'позиция ключевого слова');
});

test('description: есть и не длиннее 160 символов', () => {
  assert.equal(verdictOf(check('description'), GOOD).status, 'pass');

  const long = verdictOf(check('description'), BAD);
  assert.equal(long.status, 'fail');
  assert.equal(long.findings[0].entity, 'длина');

  const missing = verdictOf(check('description'), '<html><head></head><body></body></html>');
  assert.equal(missing.status, 'fail');
  assert.match(missing.findings[0].actual, /тега нет/);
});

test('meta-robots: нет noindex и nofollow', () => {
  const ok = verdictOf(check('meta-robots'), GOOD);
  assert.equal(ok.status, 'pass');
  assert.match(ok.note, /по умолчанию/);

  const blocked = verdictOf(check('meta-robots'), BAD);
  assert.equal(blocked.status, 'fail');
  assert.match(blocked.findings[0].actual, /noindex/);
});

test('canonical: на саму страницу и без параметров', () => {
  assert.equal(verdictOf(check('canonical'), GOOD).status, 'pass');

  const wrong = verdictOf(check('canonical'), BAD);
  assert.equal(wrong.status, 'fail');
  const entities = wrong.findings.map((f) => f.entity);
  assert.ok(entities.includes('параметры'));
  assert.ok(entities.includes('адрес'));

  const missing = verdictOf(check('canonical'), '<html><head></head><body></body></html>');
  assert.equal(missing.status, 'fail');

  const relative = verdictOf(
    check('canonical'),
    '<html><head><link rel="canonical" href="/countries/turtsiya"></head><body></body></html>',
  );
  assert.ok(relative.findings.some((f) => f.entity === 'абсолютность'));
});

test('canonical: если расходятся только домены, решение называет именно их', () => {
  const url = 'https://www.aviasales.uz/airports/zhukovsky-international-airport-zia';
  const html = `<html><head><link rel="canonical" href="https://www.aviasales.ru/airports/zhukovsky-international-airport-zia"></head><body></body></html>`;
  const verdict = verdictOf(check('canonical'), html, { url });

  const address = verdict.findings.find((f) => f.entity === 'адрес');
  assert.ok(address, 'расхождение адреса должно находиться');
  assert.equal(address.fix, 'Заменить домен в canonical: www.aviasales.ru → www.aviasales.uz.');

  // А когда отличается путь, а не домен, общего совета про домены быть не должно.
  const otherPath = verdictOf(
    check('canonical'),
    '<html><head><link rel="canonical" href="https://www.aviasales.ru/countries/tailand"></head><body></body></html>',
  );
  const byPath = otherPath.findings.find((f) => f.entity === 'адрес');
  assert.match(byPath.fix, /адрес самой страницы/);
});

test('у каждой находки есть краткое «как исправить»', () => {
  // Проверки, которым хватает HTML и ответа сервера: их можно прогнать по битой
  // фикстуре здесь же. Без этой страховки новая проверка молча приезжает без решения.
  const offline = new Set(['response', 'html']);
  const runnable = ALL_CHECKS.filter(
    (c) => c.scope === 'page' && (c.needs ?? []).every((n) => offline.has(n)),
  );
  assert.ok(runnable.length >= 10, 'фикстура должна покрывать большинство проверок');

  for (const c of runnable) {
    for (const finding of verdictOf(c, BAD).findings) {
      assert.ok(finding.fix, `${c.id}: находка «${finding.entity}» без совета как исправить`);
    }
  }
});

test('h1: один, непустой, с ключевыми словами', () => {
  assert.equal(verdictOf(check('h1'), GOOD).status, 'pass');

  const bad = verdictOf(check('h1'), BAD);
  assert.equal(bad.status, 'fail');
  const entities = bad.findings.map((f) => f.entity);
  assert.ok(entities.includes('количество'));
  assert.ok(entities.includes('ключевые слова'));

  const none = verdictOf(check('h1'), '<html><body><h2>Не заголовок первого уровня</h2></body></html>');
  assert.equal(none.status, 'fail');
  assert.equal(none.findings[0].severity, 'P1');
});

test('headings: иерархия без пропусков уровней', () => {
  assert.equal(verdictOf(check('headings'), GOOD).status, 'pass');

  const skipped = verdictOf(check('headings'), BAD);
  assert.equal(skipped.status, 'fail');
  assert.ok(skipped.findings.some((f) => f.entity === 'h1 → h3'));

  const empty = verdictOf(check('headings'), '<html><body><p>без заголовков</p></body></html>');
  assert.equal(empty.status, 'fail');
});

test('robots-txt: путь страницы не под Disallow', () => {
  const ok = verdictOf(check('robots-txt'), GOOD, { site: robotsSite(ROBOTS_OK) });
  assert.equal(ok.status, 'pass');

  const blocked = verdictOf(check('robots-txt'), GOOD, {
    site: robotsSite('User-agent: *\nDisallow: /countries/\nSitemap: https://www.aviasales.ru/sitemap.xml'),
  });
  assert.equal(blocked.status, 'fail');
  assert.equal(blocked.findings[0].entity, 'запрет обхода');

  // Нет директивы Sitemap — это замечание, а не запрет индексации.
  const noSitemap = verdictOf(check('robots-txt'), GOOD, { site: robotsSite('User-agent: *\nDisallow: /search') });
  assert.equal(noSitemap.status, 'warn');

  const unavailable = verdictOf(check('robots-txt'), GOOD, {
    site: { robots: { status: 404, text: null, error: null, sitemaps: [], parsed: { groups: [], sitemaps: [] } }, sitemap: {} },
  });
  assert.equal(unavailable.status, 'warn');
});

test('sitemap: URL страницы найден в карте сайта', () => {
  const ok = verdictOf(check('sitemap'), GOOD, { site: robotsSite(ROBOTS_OK) });
  assert.equal(ok.status, 'pass');

  const missing = verdictOf(check('sitemap'), GOOD, { site: robotsSite(ROBOTS_OK, { sitemapFound: { [normUrl(URL)]: null } }) });
  assert.equal(missing.status, 'fail');

  // Не досмотрели карту до конца — честнее сказать «не проверено», чем «нет в sitemap».
  const truncated = verdictOf(check('sitemap'), GOOD, {
    site: robotsSite(ROBOTS_OK, { sitemapFound: { [normUrl(URL)]: null }, sitemap: { truncated: true } }),
  });
  assert.equal(truncated.status, 'warn');
});

test('og-twitter: теги заполнены, картинка абсолютным URL', () => {
  assert.equal(verdictOf(check('og-twitter'), GOOD).status, 'pass');

  const bad = verdictOf(check('og-twitter'), BAD);
  assert.equal(bad.status, 'fail', 'относительный og:image ломает шаринг — это важнее P3');
  const image = bad.findings.find((f) => f.entity === 'og:image');
  assert.equal(image.severity, 'P2');
  assert.ok(bad.findings.some((f) => f.entity === 'Twitter meta'));
});

test('content-placeholder: нет заглушек и текст не пустой', () => {
  assert.equal(verdictOf(check('content-placeholder'), GOOD).status, 'pass');

  const bad = verdictOf(check('content-placeholder'), BAD);
  assert.equal(bad.status, 'fail');
  const entities = bad.findings.map((f) => f.entity);
  assert.ok(entities.some((e) => e.includes('lorem ipsum')));
  assert.ok(entities.some((e) => e.includes('тестовый текст')));
  assert.ok(entities.includes('объём текста'));
});

test('keywords: ключевые слова в тексте и в alt', () => {
  assert.equal(verdictOf(check('keywords'), GOOD).status, 'pass');

  const bad = verdictOf(check('keywords'), BAD);
  assert.equal(bad.status, 'fail');
  assert.equal(bad.findings[0].entity, 'текст страницы');

  // Ключевые слова есть в тексте, но ни одного нет в alt — только замечание.
  const noAlt = `<html><head></head><body><p>Авиабилеты в Турцию из Москвы.</p><img src="/a.png" alt="Просто картинка"></body></html>`;
  const verdict = verdictOf(check('keywords'), noAlt);
  assert.equal(verdict.status, 'warn');
  assert.equal(verdict.findings[0].entity, 'alt изображений');
});

test('alt-tags: alt есть у всех картинок', () => {
  assert.equal(verdictOf(check('alt-tags'), GOOD).status, 'pass');

  const bad = verdictOf(check('alt-tags'), BAD);
  assert.equal(bad.status, 'fail');
  const missing = bad.findings.filter((f) => f.actual === 'атрибута alt нет');
  assert.equal(missing.length, 1);
  assert.equal(effectiveSeverity(missing[0], check('alt-tags')), 'P1');
  // Пустой alt и слишком короткое описание — замечания, а не нарушение.
  assert.equal(bad.findings.filter((f) => f.severity === 'P3').length, 2);
});

test('внутренние и внешние ссылки — это две разные проверки', () => {
  // Одна и та же страница судится дважды, с разной строгостью и разными адресами находок.
  assert.equal(check('links-internal').checklist, 'Внутренние ссылки');
  assert.equal(check('links-external').checklist, 'Внешние ссылки');
  assert.equal(check('links-internal').severity, 'P1', 'битая ссылка на свой домен — наш баг');
  assert.equal(check('links-external').severity, 'P2', 'битая ссылка на чужой сайт — не наш баг');
});

test('свой домен — только домен самой страницы, остальные наши тоже внешние', () => {
  const html =
    '<html><body>' +
    '<a href="https://www.aviasales.ru/countries/turtsiya">свой</a>' +
    '<a href="https://m.aviasales.ru/countries/turtsiya">поддомен</a>' +
    '<a href="https://www.aviasales.ge/countries/turtsiya">GE</a>' +
    '<a href="https://www.aviasales.uz/countries/turtsiya">UZ</a>' +
    '<a href="https://example.com/x">чужой</a>' +
    '</body></html>';

  const ru = factsFor(html);
  assert.deepEqual(
    ru.html.links.filter((l) => l.internal).map((l) => l.site),
    ['aviasales.ru', 'aviasales.ru'],
    'поддомен — тот же домен, а вот .ge и .uz для .ru внешние',
  );
  assert.deepEqual(
    ru.html.links.filter((l) => l.external).map((l) => l.site),
    ['aviasales.ge', 'aviasales.uz', 'example.com'],
  );

  // Та же разметка со страницы другого нашего домена: внутренним становится он.
  const ge = factsFor(html, { url: 'https://www.aviasales.ge/cities/batumi-bus' });
  assert.deepEqual(
    ge.html.links.filter((l) => l.internal).map((l) => l.site),
    ['aviasales.ge'],
  );
});

test('links-internal: битые и nofollow на своих ссылках', () => {
  const ok = verdictOf(check('links-internal'), GOOD, { links: statusesFor(GOOD) });
  assert.equal(ok.status, 'pass');
  assert.match(ok.note, /внутренних ссылок на странице 2, проверено 2/);

  const bad = verdictOf(check('links-internal'), BAD, {
    links: linksArtifact({
      'https://www.aviasales.ru/countries/gruziya': { status: 200, error: null },
      'https://www.aviasales.ru/airlines/2s?language=ru': { status: 404, error: null },
    }),
  });
  assert.equal(bad.status, 'fail');
  const broken = bad.findings.find((f) => f.actual === 'HTTP 404');
  assert.equal(effectiveSeverity(broken, check('links-internal')), 'P1');
  assert.ok(bad.findings.some((f) => f.expected.includes('внутренняя ссылка без')));
  // Внешнюю ссылку эта проверка не трогает — ей занимается links-external.
  assert.ok(!bad.findings.some((f) => f.entity.includes('example.com')));

  // Одна ссылка нарушает сразу два требования: адреса находок обязаны различаться,
  // иначе исчезновение одной перебьёт отпечаток другой и она попадёт в «устранено».
  const twoProblems = verdictOf(
    check('links-internal'),
    '<html><body><a href="https://www.aviasales.ru/x" rel="nofollow">x</a></body></html>',
    { links: linksArtifact({ 'https://www.aviasales.ru/x': { status: 404, error: null } }) },
  );
  assert.equal(twoProblems.findings.length, 2);
  assert.equal(new Set(twoProblems.findings.map((f) => f.entity)).size, 2);
});

test('links-internal: лимит на время разработки не превращается в находки', () => {
  const html =
    '<html><body>' +
    '<a href="https://www.aviasales.ru/a">a</a>' +
    '<a href="https://www.aviasales.ru/b">b</a>' +
    '<a href="https://www.aviasales.ru/c">c</a>' +
    '</body></html>';

  // Проверена только первая из трёх: остальные не пропущены молча, о лимите
  // говорит примечание вердикта, а не находка на каждую ссылку.
  const limited = verdictOf(check('links-internal'), html, {
    links: linksArtifact(
      { 'https://www.aviasales.ru/a': { status: 200, error: null } },
      { scope: { development: { enabled: true, internal_links_per_page: 1 } } },
    ),
  });
  assert.equal(limited.status, 'pass');
  assert.match(limited.note, /проверено 1 — лимит 1 на страницу на время разработки$/);
  assert.equal(limited.findings.length, 0);
  // «Пройдено на проверенной части» — отчёт покажет такой пункт как ✅*, а не ✅.
  assert.equal(limited.partial, true);

  // Без режима разработки та же недопроверка — уже находка: значит упёрлись в жёсткий лимит.
  const unexpected = verdictOf(check('links-internal'), html, {
    links: linksArtifact({ 'https://www.aviasales.ru/a': { status: 200, error: null } }),
  });
  assert.ok(unexpected.findings.some((f) => f.entity === 'непроверенные внутренние ссылки'));
  assert.notEqual(unexpected.partial, true, 'без лимита частичность не заявляется');

  // Ссылки, общие для нескольких страниц, проверяются один раз на прогон и достаются
  // странице сверх её лимита. «Проверено больше лимита» — не ошибка, но требует оговорки.
  const shared = verdictOf(check('links-internal'), html, {
    links: linksArtifact(
      {
        'https://www.aviasales.ru/a': { status: 200, error: null },
        'https://www.aviasales.ru/b': { status: 200, error: null },
      },
      { scope: { development: { enabled: true, internal_links_per_page: 1 } } },
    ),
  });
  assert.match(shared.note, /проверено 2 — лимит 1 на страницу.*общие для страниц ссылки проверяются один раз/);
});

test('links-external: nofollow обязателен, битые мягче внутренних', () => {
  const ok = verdictOf(check('links-external'), GOOD, { links: statusesFor(GOOD) });
  assert.equal(ok.status, 'pass');
  assert.match(ok.note, /внешних ссылок на странице 1/);

  const bad = verdictOf(check('links-external'), BAD, {
    links: linksArtifact({ 'https://example.com/partner': { status: 200, error: null } }),
  });
  assert.equal(bad.status, 'fail');
  assert.equal(bad.findings.length, 1);
  assert.ok(bad.findings[0].entity.startsWith('нет nofollow: '));

  const broken = verdictOf(
    check('links-external'),
    '<html><body><a href="https://example.com/x" rel="nofollow">x</a></body></html>',
    { links: linksArtifact({ 'https://example.com/x': { status: 404, error: null } }) },
  );
  assert.equal(effectiveSeverity(broken.findings[0], check('links-external')), 'P2');

  // Антибот ответил отказом — это не битая ссылка, а невозможность проверить.
  // Такие ссылки идут одной находкой: это один факт о прогоне, а не сотни проблем.
  const refused = verdictOf(
    check('links-external'),
    '<html><body><a href="https://vk.com/a" rel="nofollow">a</a><a href="https://vk.com/b" rel="nofollow">b</a></body></html>',
    {
      links: linksArtifact({
        'https://vk.com/a': { status: 418, error: null },
        'https://vk.com/b': { status: 202, error: null },
      }),
    },
  );
  assert.equal(refused.status, 'warn');
  assert.equal(refused.findings.length, 1);
  assert.equal(refused.findings[0].entity, 'внешние ссылки без ответа на проверку');
  assert.match(refused.findings[0].actual, /^2 ссылок/);
});

test('structured-data: валидный ld+json с обязательными полями', () => {
  assert.equal(verdictOf(check('structured-data'), GOOD).status, 'pass');

  const broken = verdictOf(check('structured-data'), BAD);
  assert.equal(broken.status, 'fail');
  assert.equal(broken.findings[0].severity, 'P1');

  const missing = verdictOf(check('structured-data'), '<html><head></head><body></body></html>');
  assert.equal(missing.status, 'fail');

  const incomplete = verdictOf(
    check('structured-data'),
    '<html><head><script type="application/ld+json">{"@type":"Organization"}</script></head><body></body></html>',
  );
  assert.equal(incomplete.status, 'fail');
  assert.ok(incomplete.findings.some((f) => f.entity === 'обязательные поля'));

  // @graph разворачивается: объект внутри него тоже считается.
  const graph = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"A","url":"https://a.ru"}]}</script></head><body></body></html>`;
  const graphVerdict = verdictOf(check('structured-data'), graph);
  assert.equal(graphVerdict.status, 'fail', 'у вложенного объекта нет @context — обязательные поля не собраны');
});

test('uniqueness: дубли между страницами прогона', () => {
  const uniqueness = check('uniqueness');
  const ctx = ctxFor();

  const same = [
    factsFor(GOOD, { slug: 'countries-turtsiya' }),
    factsFor(GOOD, { slug: 'countries-gruziya', url: 'https://www.aviasales.ru/countries/gruziya' }),
  ];
  const duplicated = uniqueness.run(same, ctx);
  assert.equal(duplicated['countries-turtsiya'].status, 'fail');
  assert.equal(duplicated['countries-gruziya'].status, 'fail');
  const entities = duplicated['countries-turtsiya'].findings.map((f) => f.entity);
  assert.ok(entities.includes('title vs countries-gruziya'));
  assert.ok(entities.includes('h1 vs countries-gruziya'));
  assert.ok(entities.includes('текст vs countries-gruziya'));

  const different = [
    factsFor(GOOD, { slug: 'countries-turtsiya' }),
    factsFor(
      `<html><head><title>Авиабилеты в Грузию недорого</title><meta name="description" content="Совсем другое описание страницы про Грузию."></head><body><h1>Авиабилеты в Грузию</h1><p>Тбилиси, Батуми и Кутаиси принимают прямые рейсы круглый год, зимой билеты дешевеют почти вдвое.</p></body></html>`,
      { slug: 'countries-gruziya', url: 'https://www.aviasales.ru/countries/gruziya' },
    ),
  ];
  const unique = uniqueness.run(different, ctx);
  assert.equal(unique['countries-turtsiya'].status, 'pass');
  assert.equal(unique['countries-gruziya'].status, 'pass');
});

test('text-uniqueness-external: пункт честно помечен как непроверяемый', () => {
  const verdict = check('text-uniqueness-external').run();
  assert.equal(verdict.status, 'na');
  assert.match(verdict.reason, /text\.ru/);
});

test('ssr: контент есть в HTML от сервера', () => {
  assert.equal(verdictOf(check('ssr'), GOOD, { dom: GOOD }).status, 'pass');

  // HTML от сервера и из браузера снимаются в разные моменты, цены на страницах живые.
  // Расхождение только в числах — не поломанный SSR.
  const otherPrice = GOOD.replaceAll('11 000 ₽', '12 500 ₽');
  assert.equal(verdictOf(check('ssr'), GOOD, { dom: otherPrice }).status, 'pass');

  // А расхождение не в числах — уже находка.
  const otherTitle = GOOD.replaceAll('в Турцию', 'в Грузию');
  assert.equal(verdictOf(check('ssr'), GOOD, { dom: otherTitle }).status, 'fail');

  // Каркас без контента от сервера, всё дорисовано на клиенте.
  const shell = '<html><head><title>Дешёвые авиабилеты в Турцию</title></head><body><div id="root"></div></body></html>';
  const clientOnly = verdictOf(check('ssr'), shell, { dom: GOOD });
  assert.equal(clientOnly.status, 'fail');
  const entities = clientOnly.findings.map((f) => f.entity);
  assert.ok(entities.includes('h1'));
  assert.ok(entities.includes('объём контента'));
});

test('console-errors: ошибки и неудачные запросы при загрузке', () => {
  const clean = { pageErrors: [], consoleErrors: [], failedRequests: [], requestFailures: [] };
  assert.equal(verdictOf(check('console-errors'), GOOD, { console: clean }).status, 'pass');

  const noisy = verdictOf(check('console-errors'), GOOD, {
    console: {
      pageErrors: [{ message: 'TypeError: x is not a function', stack: 'at main.js:1' }],
      consoleErrors: [],
      failedRequests: [{ url: 'https://img.avs.io/pics/6D.png?v=2', status: 404, resourceType: 'image' }],
      requestFailures: [],
    },
  });
  assert.equal(noisy.status, 'fail');
  assert.equal(effectiveSeverity(noisy.findings[0], check('console-errors')), 'P2');
  // Адрес ресурса в отпечатке — без query, иначе каждый прогон давал бы новую находку.
  assert.ok(noisy.findings.some((f) => f.entity === 'img.avs.io/pics/6D.png'));
});

test('mobile: viewport объявлен и нет горизонтального скролла', () => {
  const ok = {
    viewport: { width: 390, height: 844 },
    hasViewportMeta: true,
    viewportMeta: 'width=device-width, initial-scale=1',
    clientWidth: 390,
    scrollWidth: 390,
    overflowPx: 0,
    overflowingSelectors: [],
  };
  assert.equal(verdictOf(check('mobile'), GOOD, { mobile: ok }).status, 'pass');

  const overflow = verdictOf(check('mobile'), GOOD, {
    mobile: { ...ok, scrollWidth: 520, overflowPx: 130, overflowingSelectors: ['div.wide → правый край 520px'] },
  });
  assert.equal(overflow.status, 'fail');
  assert.equal(overflow.findings[0].entity, 'горизонтальный скролл');

  const noMeta = verdictOf(check('mobile'), GOOD, {
    mobile: { ...ok, hasViewportMeta: false, viewportMeta: null },
  });
  assert.equal(noMeta.status, 'fail');
  assert.equal(noMeta.findings[0].severity, 'P1');

  // Страница не открылась в мобильном браузере — это «не проверено», а не «нет viewport».
  const failedLoad = verdictOf(check('mobile'), GOOD, {
    mobile: { ...ok, error: 'page.goto: Timeout 60000ms exceeded', hasViewportMeta: null, viewportMeta: null },
  });
  assert.equal(failedLoad.status, 'skip');
  assert.match(failedLoad.reason, /не открылась/);
});

test('performance: оценка Lighthouse не ниже порога', () => {
  const good = { desktop: { score: 96, metrics: {}, error: null }, mobile: { score: 92, metrics: {}, error: null } };
  assert.equal(verdictOf(check('performance'), GOOD, { lighthouse: good }).status, 'pass');

  const slow = verdictOf(check('performance'), GOOD, {
    lighthouse: {
      desktop: { score: 57, metrics: { 'Largest Contentful Paint': '4,2 s' }, error: null },
      mobile: { score: 88, metrics: {}, error: null },
    },
  });
  assert.equal(slow.status, 'fail');
  assert.deepEqual(
    slow.findings.map((f) => f.entity),
    ['десктоп', 'мобайл'],
  );

  // Lighthouse не отработал — это не «медленно», а «не измерено».
  const broken = verdictOf(check('performance'), GOOD, {
    lighthouse: { desktop: { score: null, metrics: {}, error: 'NO_FCP' }, mobile: { score: 95, metrics: {}, error: null } },
  });
  assert.equal(broken.status, 'warn');
  assert.equal(broken.findings[0].severity, 'P3');
});
