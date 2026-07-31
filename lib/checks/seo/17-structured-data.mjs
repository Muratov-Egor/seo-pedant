import { judge } from '../../verdict.mjs';
import { clip } from '../../text.mjs';

const REQUIRED = ['@context', '@type', '@name', '@url'];

/** Разворачивает массивы и @graph: проверять нужно объекты, а не обёртки. */
function objectsOf(parsed) {
  if (Array.isArray(parsed)) return parsed.flatMap(objectsOf);
  if (!parsed || typeof parsed !== 'object') return [];
  const nested = Array.isArray(parsed['@graph']) ? parsed['@graph'].flatMap(objectsOf) : [];
  return [parsed, ...nested];
}

/**
 * Чеклист требует поля @context, @type, @name, @url. В schema.org name и url пишутся
 * без «@», поэтому оба варианта считаются заполнением поля.
 */
function fieldPresent(obj, field) {
  const bare = field.replace('@', '');
  return Boolean(obj[field] ?? obj[bare]);
}

export default {
  id: 'structured-data',
  checklist: 'Структурированные данные (Schema.org)',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html'],
  severity: 'P2',

  run(f) {
    const scripts = f.html.jsonld;

    if (scripts.length === 0) {
      return judge(
        [
          {
            entity: 'ld+json',
            expected: '<script type="application/ld+json"> на странице',
            actual: 'тега нет',
          },
        ],
        this.severity,
      );
    }

    const findings = [];

    scripts.forEach((script, index) => {
      if (script.error) {
        findings.push({
          entity: `ld+json #${index + 1}`,
          expected: 'валидный JSON',
          actual: `ошибка разбора: ${script.error}`,
          evidence: clip(script.raw, 160),
          severity: 'P1',
        });
      }
    });

    const objects = scripts.filter((s) => s.parsed).flatMap((s) => objectsOf(s.parsed));
    const complete = objects.some((obj) => REQUIRED.every((field) => fieldPresent(obj, field)));

    if (objects.length && !complete) {
      const best = objects
        .map((obj) => ({
          type: obj['@type'] ?? 'без @type',
          missing: REQUIRED.filter((field) => !fieldPresent(obj, field)),
        }))
        .sort((a, b) => a.missing.length - b.missing.length)[0];

      findings.push({
        entity: 'обязательные поля',
        expected: `объект со всеми полями: ${REQUIRED.join(', ')}`,
        actual: `ближайший объект (${best.type}) без полей: ${best.missing.join(', ')}`,
        note: `Разобрано объектов: ${objects.length}.`,
      });
    }

    return judge(findings, this.severity);
  },
};
