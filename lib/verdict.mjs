// Вердикт проверки и отпечаток находки.
//
// Проверка всегда возвращает вердикт — так «проверено и всё хорошо» отличается от
// «проверка не запускалась». Отпечаток считает этот модуль, проверки о нём не знают.

import { createHash } from 'node:crypto';

export const PASS = 'pass'; // проверено, соответствует чеклисту
export const FAIL = 'fail'; // проверено, не соответствует
export const WARN = 'warn'; // проверено, соответствует не полностью — на усмотрение владельца
export const SKIP = 'skip'; // не проверено: нет нужных артефактов или проверка отключена
export const NA = 'na'; //   проверка невозможна в этом боте (нужен внешний сервис)

export const SEVERITIES = ['P1', 'P2', 'P3'];

/** Статусы, попадающие в раздел проблем отчёта. */
export function isProblem(status) {
  return status === FAIL || status === WARN;
}

function normalizeFindings(input, status) {
  const list = (Array.isArray(input) ? input : [input]).filter(Boolean);
  if (list.length === 0) {
    throw new Error(`вердикт ${status} без находок — используй pass()`);
  }
  return list.map((f) => {
    const entity = String(f.entity ?? '—');
    const expected = f.expected == null ? null : String(f.expected);
    const actual = f.actual == null ? null : String(f.actual);
    const message =
      f.message ??
      (expected != null && actual != null
        ? `${entity}: ожидалось ${expected}, фактически ${actual}`
        : `${entity}: ${expected ?? actual ?? 'не соответствует чеклисту'}`);
    if (f.severity && !SEVERITIES.includes(f.severity)) {
      throw new Error(`неизвестная важность находки: ${f.severity}`);
    }
    return {
      entity,
      expected,
      actual,
      message,
      // Дословная цитата со страницы — доказательство, что находка не выдумана.
      evidence: f.evidence ?? null,
      // Пояснение, где именно смотреть и почему это проблема.
      note: f.note ?? null,
      // Что сделать, чтобы находки не стало: короткая инструкция в повелительном
      // наклонении. Одна на вид проблемы, а не на страницу: в отчёте она печатается
      // на уровне группы, поэтому «Заменить домен» лучше, чем «Заменить домен на 8 стр.».
      fix: f.fix ?? null,
      // Необязательно: перебивает важность проверки для конкретной находки.
      severity: f.severity ?? null,
      // Блок страницы, где сидит находка (шапка/меню/контент → «Заголовок»). Для
      // находок по видимому контенту — ссылки, картинки. В отпечаток НЕ входит:
      // блок может меняться от вёрстки, а история находки не должна от этого рваться.
      block: f.block ?? null,
    };
  });
}

export function pass(note = null) {
  return { status: PASS, note, findings: [] };
}

export function fail(findings) {
  return { status: FAIL, note: null, findings: normalizeFindings(findings, FAIL) };
}

export function warn(findings) {
  return { status: WARN, note: null, findings: normalizeFindings(findings, WARN) };
}

/**
 * Итоговая важность находки. Проверка может назначить её сама (тогда она главная),
 * иначе берётся переопределение из конфига типа страницы, иначе важность проверки.
 * Правило живёт здесь одно на весь проект: им пользуется и прогон, и тесты.
 */
export function effectiveSeverity(finding, check, overrides = {}) {
  return finding.severity ?? overrides[check.id] ?? check.severity;
}

/**
 * Собирает вердикт из накопленных находок: пусто — pass, есть только P3 — warn,
 * есть что-то важнее — fail. Избавляет проверки от ручного ветвления по статусу.
 */
export function judge(findings, checkSeverity = 'P2') {
  const list = (findings ?? []).filter(Boolean);
  if (list.length === 0) return pass();
  const worst = list.reduce((acc, f) => {
    const s = f.severity ?? checkSeverity;
    return s < acc ? s : acc;
  }, 'P3');
  return worst === 'P3' ? warn(list) : fail(list);
}

export function skip(reason) {
  return { status: SKIP, reason, findings: [] };
}

export function na(reason) {
  return { status: NA, reason, findings: [] };
}

/**
 * Адрес находки в истории прогонов.
 *
 * Внутрь сознательно НЕ входят значения (длины, оценки, цены, статусы) и названия блоков:
 * они меняются от прогона к прогону, и застарелая проблема каждый день выглядела бы новой.
 * dupIndex различает однотипные находки с одинаковым entity в рамках одной проверки.
 * Менять состав ключа нельзя без обнуления data/history.ndjson.
 */
export function fingerprint(slug, checkId, entity, dupIndex = 0) {
  return createHash('sha1')
    .update([slug, checkId, entity, dupIndex].join('::'))
    .digest('hex')
    .slice(0, 12);
}
