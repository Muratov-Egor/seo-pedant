import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collapse, hasAnyStem, hasStem, normalize, similarityPct, wordCount, sentenceWith } from '../lib/text.mjs';
import { keywordsFor, nameTokens, stem, translit } from '../lib/keywords.mjs';
import { groupFor, normUrl, parseRobots, robotsDecision } from '../lib/collect/site.mjs';
import { botWallReason, htmlFacts, urlFacts } from '../lib/facts.mjs';
import { fingerprint, judge, pass } from '../lib/verdict.mjs';
import { fixture } from './helpers.mjs';

test('текст: нормализация и поиск по стему', () => {
  assert.equal(collapse('  два\n\nслова  '), 'два слова');
  assert.equal(normalize('Ёлка, Ель!'), 'елка ель');
  assert.equal(wordCount('Авиабилеты в Анталью Турция'), 4);
  // Стем должен находить слово в любом падеже — иначе проверка ключевых слов ложно падает.
  assert.ok(hasStem('Дешёвые авиабилеты в Турцию', 'турци'));
  assert.ok(hasStem('Цены из Турции', 'турци'));
  assert.ok(!hasStem('Авиабилеты в Грузию', 'турци'));
  assert.equal(sentenceWith('Первое. Тут lorem ipsum внутри. Третье.', 'lorem'), 'Тут lorem ipsum внутри.');
});

test('текст: похожесть считается по совпадению фрагментов', () => {
  const a = 'один два три четыре пять шесть семь восемь';
  assert.equal(similarityPct(a, a), 100);
  assert.equal(similarityPct(a, 'совершенно другой набор слов без пересечений вовсе'), 0);
});

test('ключевые слова выводятся из слага обратной транслитерацией', () => {
  assert.equal(translit('tailand'), 'таиланд');
  assert.equal(translit('turtsiya'), 'турция');
  assert.equal(translit('chernogoriya'), 'черногория');
  assert.equal(translit('gruziya'), 'грузия');
  assert.equal(translit('belarus'), 'беларус');

  // Стем короче слова ровно настолько, чтобы падежи не мешали.
  assert.equal(stem('турция'), 'турци');
  assert.equal(stem('таиланд'), 'таиланд');
  assert.equal(stem('авиабилеты'), 'авиабилет');

  const kw = keywordsFor({ url: 'https://www.aviasales.ru/countries/turtsiya' });
  assert.equal(kw.source, 'URL');
  assert.equal(kw.topic.stem, 'авиабилет');
  assert.equal(kw.entity.stem, 'турци');
});

test('одиночная y в транслите разбирается по соседям', () => {
  // Три разных звука одной буквы: иначе аэропорт «Жуковский» превращается в «жуковскй»,
  // а такого слова на странице нет — и проверка ключевых слов врёт.
  assert.equal(translit('zhukovsky'), 'жуковский');
  assert.equal(translit('krym'), 'крым');
  assert.equal(translit('mytishchi'), 'мытищи');
  assert.equal(translit('yalta'), 'ялта');
  assert.equal(stem('жуковский'), 'жуковск');
});

test('в слаге отбрасываются IATA-коды и английские слова', () => {
  // cities/moskva-mow — код приклеен к названию
  assert.deepEqual(nameTokens('https://www.aviasales.ru/cities/moskva-mow'), ['moskva']);
  // airports/... — к названию добавлены служебные английские слова
  assert.deepEqual(
    nameTokens('https://www.aviasales.uz/airports/zhukovsky-international-airport-zia'),
    ['zhukovsky'],
  );
  // routes/mow/aer — названия в URL нет вообще, только коды
  assert.deepEqual(nameTokens('https://www.aviasales.ru/routes/mow/aer'), []);
  assert.deepEqual(nameTokens('https://www.aviasales.ru/countries/tailand'), ['tailand']);
});

test('ключевые слова выводятся для страниц разных типов', () => {
  const city = keywordsFor({ url: 'https://www.aviasales.ru/cities/moskva-mow', label: 'Москва' });
  assert.equal(city.source, 'URL');
  assert.deepEqual(city.all.map((k) => k.stem), ['авиабилет', 'москв']);

  const airport = keywordsFor({
    url: 'https://www.aviasales.uz/airports/zhukovsky-international-airport-zia',
    label: 'Жуковский (ZIA)',
  });
  assert.equal(airport.source, 'URL');
  assert.deepEqual(airport.all.map((k) => k.stem), ['аэропорт', 'жуковск']);

  // У маршрута в URL только коды, поэтому название берётся из label конфига.
  const route = keywordsFor({ url: 'https://www.aviasales.ru/routes/mow/aer', label: 'Москва — Сочи' });
  assert.equal(route.source, 'URL + label');
  assert.deepEqual(route.all.map((k) => k.stem), ['авиабилет', 'москв', 'сочи']);

  // Нет ни названия в URL, ни label — остаётся только тема, выдуманных слов не появляется.
  const bare = keywordsFor({ url: 'https://www.aviasales.ru/routes/mow/aer' });
  assert.equal(bare.entity, null);
  assert.deepEqual(bare.all.map((k) => k.stem), ['авиабилет']);
});

test('страница на английском: слово ищется и латиницей, и транслитом', () => {
  // aviasales.ge отдаёт страницы на английском, поэтому ждать на них «Батуми» и
  // «авиабилеты» бессмысленно: раньше это давало ложные находки в title, h1 и тексте.
  const kw = keywordsFor({ url: 'https://www.aviasales.ge/cities/batumi-bus', label: 'Батуми' });
  assert.deepEqual(kw.all.map((k) => k.stems), [
    ['авиабилет', 'flight', 'ticket'],
    ['батум', 'batumi'],
  ]);

  for (const text of ['Flights for Batumi', 'Cheap flight tickets to Batumi from ₾136']) {
    assert.deepEqual(
      kw.all.filter((k) => !hasAnyStem(text, k.stems)).map((k) => k.word),
      [],
      `на английском тексте ненайденных слов быть не должно: ${text}`,
    );
  }

  // Русская страница по-прежнему находится по кириллице.
  const ru = keywordsFor({ url: 'https://www.aviasales.ru/countries/turtsiya', label: 'Турция' });
  assert.ok(ru.all.every((k) => hasAnyStem('Дешёвые авиабилеты в Турцию', k.stems)));
});

test('ключевые слова из конфига перекрывают автовывод', () => {
  const kw = keywordsFor({ url: 'https://www.aviasales.ru/x/y', keywords: ['Мальдивы'], label: 'что угодно' });
  assert.equal(kw.source, 'конфиг');
  assert.equal(kw.all[0].stem, 'мальдив');
  assert.equal(kw.all.length, 1);
});

test('robots.txt: группы, wildcard и приоритет длинного правила', () => {
  const parsed = parseRobots(`
    # комментарий
    User-agent: *
    Disallow: /search
    Disallow: /offers/filter*
    Allow: /offers/filter/allowed$
    Disallow:
    Sitemap: https://www.aviasales.ru/sitemap.xml

    User-agent: BadBot
    Disallow: /
  `);

  assert.deepEqual(parsed.sitemaps, ['https://www.aviasales.ru/sitemap.xml']);
  const group = groupFor(parsed, '*');
  assert.ok(group);

  assert.equal(robotsDecision('/countries/turtsiya', group).allowed, true);
  assert.equal(robotsDecision('/search', group).allowed, false);
  assert.equal(robotsDecision('/offers/filter/xyz', group).allowed, false);
  // Более длинное Allow должно побеждать более короткий Disallow.
  assert.equal(robotsDecision('/offers/filter/allowed', group).allowed, true);
  // Правила другого агента не применяются к нашему.
  assert.equal(robotsDecision('/', group).allowed, true);
});

test('robots.txt: пустой Disallow не запрещает всё', () => {
  const group = groupFor(parseRobots('User-agent: *\nDisallow:'), '*');
  assert.equal(robotsDecision('/countries/turtsiya', group).allowed, true);
});

test('URL нормализуется для сравнения с sitemap и canonical', () => {
  assert.equal(
    normUrl('https://WWW.Aviasales.ru/countries/turtsiya/#anchor'),
    'https://www.aviasales.ru/countries/turtsiya',
  );
  assert.equal(urlFacts('https://www.aviasales.ru/countries/turtsiya').site, 'aviasales.ru');
  assert.equal(urlFacts('https://img.avs.io/x').site, 'avs.io');
});

test('facts: из HTML извлекается то, что проверяет чеклист', () => {
  const f = htmlFacts(fixture('country-good'), 'https://www.aviasales.ru/countries/turtsiya');

  assert.equal(f.titleCount, 1);
  assert.ok(f.title.includes('Турцию'));
  assert.ok(f.description.length <= 160);
  assert.equal(f.robots, null, 'meta robots на хорошей странице нет');
  assert.equal(f.canonical, 'https://www.aviasales.ru/countries/turtsiya');
  assert.equal(f.canonicalCount, 1);
  assert.deepEqual(f.h1, ['Дешёвые авиабилеты в Турцию']);
  assert.deepEqual(
    f.headings.map((h) => h.level),
    [1, 2, 2, 3, 3],
  );
  assert.equal(f.og.image, 'https://static.aviasales.ru/og/turtsiya.png');
  assert.equal(f.twitter.card, 'summary_large_image');
  assert.equal(f.images.length, 2);
  assert.ok(f.images.every((i) => i.hasAlt && i.altWords >= 2));
  assert.equal(f.jsonld.length, 1);
  assert.equal(f.jsonld[0].error, null);
  assert.ok(f.textLen > 500);

  const internal = f.links.filter((l) => l.internal);
  const external = f.links.filter((l) => l.external);
  assert.equal(internal.length, 2, 'относительная и абсолютная ссылки на свой домен — внутренние');
  assert.equal(external.length, 1);
  assert.equal(external[0].nofollow, true);
  assert.equal(internal[0].hrefAbs, 'https://www.aviasales.ru/countries/gruziya');
});

test('facts: битый JSON-LD не роняет разбор страницы', () => {
  const f = htmlFacts(fixture('country-bad'), 'https://www.aviasales.ru/countries/turtsiya');
  assert.equal(f.jsonld.length, 1);
  assert.ok(f.jsonld[0].error, 'ошибка разбора должна сохраниться, а не проглотиться');
  assert.equal(f.title, null);
  assert.equal(f.h1.length, 2);
  assert.equal(f.images.filter((i) => !i.hasAlt).length, 1);
});

test('заглушка защиты от ботов не считается страницей', () => {
  assert.equal(botWallReason(200, fixture('country-good')), null);

  // Именно это отдавал aviasales.ru после серии частых запросов.
  const waf = '<html><head><script>window.awsWafCookieDomainList = [];window.gokuProps = {"key":"x"}</script></head></html>';
  assert.match(botWallReason(202, waf), /защиты от ботов/);

  assert.match(botWallReason(202, 'x'.repeat(2000)), /HTTP 202/);
  assert.match(botWallReason(429, ''), /429/);

  // Слово captcha в скриптах настоящей большой страницы не должно обнулять прогон.
  const bigPageWithWord = `${fixture('country-good')}<script>var captcha = 1;${' '.repeat(30_000)}</script>`;
  assert.equal(botWallReason(200, bigPageWithWord), null);
});

test('вердикт: judge выбирает статус по худшей находке', () => {
  assert.equal(judge([]).status, 'pass');
  assert.equal(judge([{ entity: 'x', severity: 'P3' }]).status, 'warn');
  assert.equal(judge([{ entity: 'x', severity: 'P3' }, { entity: 'y', severity: 'P1' }]).status, 'fail');
  assert.equal(judge([{ entity: 'x' }], 'P2').status, 'fail');
  assert.deepEqual(pass().findings, []);
});

test('отпечаток зависит только от адреса находки, но не от значений', () => {
  const a = fingerprint('countries-turtsiya', 'title', 'длина', 0);
  const b = fingerprint('countries-turtsiya', 'title', 'длина', 0);
  assert.equal(a, b, 'одна и та же находка обязана давать один отпечаток между прогонами');
  assert.notEqual(a, fingerprint('countries-turtsiya', 'title', 'длина', 1));
  assert.notEqual(a, fingerprint('countries-gruziya', 'title', 'длина', 0));
  assert.equal(a.length, 12);
});
