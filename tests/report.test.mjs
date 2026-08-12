// Вид отчёта — тоже поведение: пояснения печатаются один раз на группу,
// а не копией на каждую находку.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { briefText, commonEntityPrefix, findingGroups, headingAnchor, html } from '../lib/report.mjs';

import { ALL_CHECKS } from '../lib/checks/index.mjs';

const finding = (over) => ({
  severity: 'P2',
  expected: 'абсолютный URL картинки',
  note: 'превью не отрисуется',
  entity: 'og:image',
  actual: '/og_images/default.png',
  slug: 'countries-belarus',
  status: 'repeat',
  days_seen: 1,
  fingerprint: 'abc123',
  ...over,
});

test('находки группируются по виду проблемы, а не по странице', () => {
  const groups = findingGroups([
    finding({}),
    finding({ entity: 'twitter:image', fingerprint: 'b' }),
    finding({ slug: 'countries-gruziya', fingerprint: 'c' }),
    finding({ severity: 'P1', expected: 'другое правило', note: null, fingerprint: 'd' }),
  ]);

  assert.equal(groups.length, 2, 'одинаковые «ожидалось» и пояснение — одна группа');
  assert.equal(groups[0].length, 3);
  assert.equal(groups[1].length, 1);
});

test('разные способы исправления не сливаются в одну группу', () => {
  const common = 'Заменить относительный путь на абсолютный URL.';
  const shared = findingGroups([
    finding({ fix: common }),
    finding({ entity: 'twitter:image', fingerprint: 'b', fix: common }),
  ]);
  assert.equal(shared.length, 1, 'одно решение на две находки — одна группа');

  const split = findingGroups([
    finding({ fix: common }),
    finding({ entity: 'twitter:image', fingerprint: 'b', fix: 'Убрать тег.' }),
  ]);
  assert.equal(split.length, 2, 'разные решения — разные группы, иначе одно из них потеряется');
});

test('важность входит в группу: у разной важности разные заголовки', () => {
  const groups = findingGroups([finding({}), finding({ severity: 'P3', fingerprint: 'x' })]);
  assert.equal(groups.length, 2);
});

/** Прогон на N страниц, где одна и та же причина повторяется на каждой. */
function runOf(pageCount) {
  const findings = [];
  for (let i = 0; i < pageCount; i++) {
    findings.push(
      finding({
        slug: `page-${i}`,
        fingerprint: `f${i}`,
        message: 'og:image: ожидалось абсолютный URL',
        fix: 'Заменить относительный путь на абсолютный URL.',
        check_id: 'og-twitter',
        checklist: 'Наличие Open Graph / Twitter meta',
      }),
    );
  }
  return {
    runId: '2026-08-05',
    previous_run: null,
    previous_findings_count: 0,
    totals: {
      pages: pageCount,
      findings: findings.length,
      P1: 0,
      P2: findings.length,
      P3: 0,
      new: 0,
      resolved: 0,
      unchecked_now: 0,
      suppressed: 0,
      blocked_pages: 0,
    },
    findings,
    resolved: [],
    unchecked_now: [],
    pages: Array.from({ length: pageCount }, (_, i) => ({ slug: `page-${i}`, verdicts: [] })),
  };
}

test('сводка для агента не растёт вместе с числом страниц', () => {
  const ten = briefText(runOf(10)).split('\n').length;
  const hundred = briefText(runOf(100)).split('\n').length;
  assert.equal(ten, hundred, 'одна причина на всех страницах — одна запись, сколько бы их ни было');

  const brief = briefText(runOf(100));
  assert.match(brief, /все страницы/, 'вместо перечисления ста слагов — «все страницы»');
  assert.ok(!brief.includes('page-42'), 'слаги поштучно в сводку не попадают');
  assert.match(brief, /решение: Заменить относительный путь/, 'решение обязано быть в сводке');
});

test('сводка не путает устранённое с тем, что перестало проверяться', () => {
  const run = runOf(1);
  run.resolved = [{ slug: 'page-0', message: 'og:image был относительным' }];
  run.unchecked_now = [{ slug: 'page-0', message: 'ssr — нет данных' }];
  const brief = briefText(run);
  assert.match(brief, /Устранено с прошлого прогона \(1\)/);
  assert.match(brief, /Перестало проверяться \(1\) — это НЕ устранено/);
});

test('общий префикс адреса не дублируется в каждой строке', () => {
  assert.equal(
    commonEntityPrefix([{ entity: 'нет nofollow: https://a' }, { entity: 'нет nofollow: https://b' }]),
    'нет nofollow: ',
  );
  // Разные виды проблем — префикс общим не является, обрезать нечего.
  assert.equal(commonEntityPrefix([{ entity: 'нет nofollow: https://a' }, { entity: 'битая: https://b' }]), '');
  // Двоеточие без пробела — это часть имени тега, а не префикс вида проблемы.
  assert.equal(commonEntityPrefix([{ entity: 'og:image' }, { entity: 'og:title' }]), '');
});

/** Минимальный прогон под html() из списка находок. */
function runWith(findings) {
  const pages = [...new Set(findings.map((f) => f.slug))].map((slug) => ({ slug, verdicts: [] }));
  const bySev = (s) => findings.filter((f) => f.severity === s).length;
  return {
    runId: '2026-08-12',
    generated_at: '2026-08-12T09:00:00.000Z',
    previous_run: null,
    previous_findings_count: 0,
    scope: {},
    blocked: [],
    resolved: [],
    unchecked_now: [],
    suppressed: [],
    totals: {
      pages: pages.length,
      findings: findings.length,
      P1: bySev('P1'),
      P2: bySev('P2'),
      P3: bySev('P3'),
      new: 0,
      repeat: findings.length,
      resolved: 0,
      unchecked_now: 0,
      suppressed: 0,
      blocked_pages: 0,
    },
    findings,
    pages,
  };
}

/** Имена групп из встроенного JSON html-отчёта. */
function groupNames(run) {
  const out = html(run);
  const json = out.split('<script id="data" type="application/json">')[1].split('</script>')[0];
  return JSON.parse(json.replace(/\\u003c/g, '<')).findGroups.map((g) => g.name);
}

test('заголовки групп одной проверки различаются видом проблемы', () => {
  // Настоящий check_id, иначе группа не соберётся под пунктом чеклиста.
  const links = ALL_CHECKS.find((c) => c.id === 'links-internal');
  assert.ok(links, 'проверка links-internal есть в реестре');
  const base = (over) => ({
    check_id: links.id,
    checklist: links.checklist,
    status: 'repeat',
    days_seen: 1,
    ...over,
  });

  const names = groupNames(
    runWith([
      // Две «битая» с общим префиксом, но разной важностью — префикс совпал, поэтому
      // различитель берётся из «ожидалось».
      base({ slug: 'p1', fingerprint: 'a', severity: 'P1', entity: 'битая: https://a', expected: 'ссылка отдаёт 2xx или 3xx', fix: 'Поправить адрес' }),
      base({ slug: 'p2', fingerprint: 'b', severity: 'P2', entity: 'битая: https://b', expected: 'ссылка открывается', fix: 'Проверить адрес' }),
      // Своя разновидность с уникальным префиксом — различитель берётся из него.
      base({ slug: 'p3', fingerprint: 'c', severity: 'P2', entity: 'nofollow внутри: https://c', expected: 'без nofollow', fix: 'Убрать nofollow' }),
    ]),
  );

  assert.equal(new Set(names).size, 3, 'три группы — три разных заголовка');
  assert.ok(names.every((n) => n.startsWith('Внутренние ссылки')), 'название пункта сохраняется');
  assert.ok(names.some((n) => n.includes('ссылка отдаёт 2xx или 3xx')), 'коллизия префикса разводится через «ожидалось»');
  assert.ok(names.some((n) => n.includes('ссылка открывается')));
  assert.ok(names.some((n) => n.includes('nofollow внутри')), 'уникальный префикс идёт в заголовок как есть');
});

test('одна группа в проверке — заголовок без приписки вида', () => {
  const title = ALL_CHECKS.find((c) => c.id === 'title');
  assert.ok(title, 'проверка title есть в реестре');
  const names = groupNames(
    runWith([
      {
        check_id: title.id,
        checklist: title.checklist,
        slug: 'p1',
        fingerprint: 'a',
        severity: 'P2',
        entity: 'title',
        expected: 'длина 30–70',
        actual: '95',
        status: 'repeat',
        days_seen: 1,
      },
    ]),
  );
  assert.equal(names.length, 1);
  assert.ok(!names[0].includes(' — '), 'при одной группе вид проблемы не приписывается');
});

test('якорь заголовка считается по правилам GitHub', () => {
  // Тире и слэш выбрасываются вместе с пунктуацией, на их месте остаётся дефис от пробела —
  // отсюда двойные дефисы. Если это разойдётся с GitHub, ссылки из таблицы перестанут прыгать.
  assert.equal(headingAnchor('Код ответа сервера — 1'), 'код-ответа-сервера--1');
  // Точка-разделитель выбрасывается так же, как тире: на её месте остаётся дефис от пробела.
  assert.equal(headingAnchor('P1 · Код ответа сервера — 1'), 'p1--код-ответа-сервера--1');
  assert.equal(headingAnchor('P2, P3 · Ключевые слова — 6'), 'p2-p3--ключевые-слова--6');
  assert.equal(headingAnchor('Наличие Open Graph / Twitter meta — 20'), 'наличие-open-graph--twitter-meta--20');
  assert.equal(headingAnchor('Alt-теги у всех изображений — 29'), 'alt-теги-у-всех-изображений--29');
});

// ── интерактивный HTML-отчёт ──────────────────────────────────────────────────

/** Синтетический прогон: три страницы, находки разной важности, устранённое и skip. */
function syntheticRun() {
  // Берём настоящие check_id из реестра — иначе checkLabel вернёт голый id, а матрица
  // и группы не соберутся по пунктам чеклиста.
  const c1 = ALL_CHECKS[0];
  const c2 = ALL_CHECKS[1] ?? ALL_CHECKS[0];

  const f = (over) => ({
    severity: 'P2',
    check_id: c1.id,
    checklist: c1.checklist,
    slug: 'countries-belarus',
    status: 'repeat',
    entity: 'og:image',
    expected: 'абсолютный URL картинки',
    note: 'превью не отрисуется',
    fix: 'Заменить относительный путь на абсолютный URL.',
    evidence: '<meta property="og:image" content="/og.png">',
    actual: '/og.png',
    days_seen: 3,
    fingerprint: 'fp',
    ...over,
  });

  const findings = [
    f({ severity: 'P1', check_id: c2.id, checklist: c2.checklist, status: 'new', fingerprint: 'a', days_seen: 1 }),
    f({ fingerprint: 'b' }),
    f({ slug: 'countries-gruziya', fingerprint: 'c' }),
    f({ severity: 'P3', slug: 'airports-zia', fingerprint: 'd', entity: 'ключевые слова' }),
  ];

  const page = (slug, over) => ({
    slug,
    label: slug,
    url: `https://example.com/${slug}`,
    final_url: `https://example.com/${slug}`,
    http_status: 200,
    type: 'country',
    verdicts: [
      { check_id: c1.id, status: 'fail', findings: [{}] },
      { check_id: c2.id, status: 'pass', findings: [] },
    ],
    ...over,
  });

  return {
    runId: '2026-08-12',
    generated_at: '2026-08-12T09:00:00.000Z',
    previous_run: '2026-08-11',
    previous_findings_count: 6,
    scope: {},
    checks: ALL_CHECKS.map((c) => ({ id: c.id })),
    blocked: [],
    totals: {
      pages: 3,
      blocked_pages: 0,
      findings: findings.length,
      P1: 1,
      P2: 2,
      P3: 1,
      new: 1,
      repeat: 3,
      resolved: 1,
      unchecked_now: 0,
      suppressed: 0,
    },
    pages: [
      page('countries-belarus'),
      page('countries-gruziya'),
      page('airports-zia', {
        verdicts: [
          { check_id: c1.id, status: 'warn', findings: [{}] },
          { check_id: c2.id, status: 'skip', reason: 'ssr — нет данных' },
        ],
      }),
    ],
    findings,
    resolved: [{ slug: 'countries-turtsiya', checklist: c1.checklist, message: 'og:image был относительным' }],
    unchecked_now: [],
    suppressed: [],
  };
}

test('html(run) возвращает самодостаточный документ с ключевыми секциями', () => {
  const out = html(syntheticRun());

  assert.equal(typeof out, 'string');
  assert.match(out, /^<!doctype html>/i, 'полноценный HTML-документ');
  assert.ok(out.trim().endsWith('</html>'), 'документ закрыт');

  // KPI и переключатель срезов.
  assert.match(out, /Критично · P1/);
  assert.match(out, /По важности/);
  assert.match(out, /По страницам/);
  assert.match(out, /Матрица/);

  // Severity-бейджи и данные встроены как JSON.
  assert.match(out, /b-P1/);
  assert.match(out, /<script id="data" type="application\/json">/);

  // Название пункта чеклиста попало в данные.
  assert.ok(out.includes(ALL_CHECKS[0].checklist), 'название чеклист-пункта присутствует');

  // Ни один сырой `<` не утёк в JSON-блок — иначе он закрыл бы </script> раньше времени.
  const json = out.split('<script id="data" type="application/json">')[1].split('</script>')[0];
  assert.ok(!json.includes('<'), 'в JSON-данных нет неэкранированных <');
  const D = JSON.parse(json.replace(/\\u003c/g, '<'));
  assert.equal(D.stats.runId, '2026-08-12');
  assert.ok(D.findGroups.length > 0, 'группы находок построены');
  assert.ok(D.pageSlice.length > 0, 'срез по страницам построен');
  assert.ok(D.matrix.length > 0, 'матрица построена');
});

test('html(run) не падает на первом прогоне без previous_run', () => {
  const run = syntheticRun();
  run.previous_run = null;
  run.previous_findings_count = 0;
  const out = html(run);
  assert.match(out, /первый прогон/);
});
