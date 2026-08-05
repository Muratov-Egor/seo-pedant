// Вид отчёта — тоже поведение: пояснения печатаются один раз на группу,
// а не копией на каждую находку.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { briefText, commonEntityPrefix, findingGroups, headingAnchor } from '../lib/report.mjs';

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
