// Вид отчёта — тоже поведение: пояснения печатаются один раз на группу,
// а не копией на каждую находку.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commonEntityPrefix, findingGroups } from '../lib/report.mjs';

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

test('важность входит в группу: у разной важности разные заголовки', () => {
  const groups = findingGroups([finding({}), finding({ severity: 'P3', fingerprint: 'x' })]);
  assert.equal(groups.length, 2);
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
