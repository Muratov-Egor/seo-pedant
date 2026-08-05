import { judge } from '../../verdict.mjs';
import { hasAnyStem, hasStem, clip } from '../../text.mjs';

export default {
  id: 'title',
  checklist: 'Title страницы',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html'],
  severity: 'P2',

  run(f, ctx) {
    const { title, titleCount } = f.html;
    const max = ctx.thresholds.title_max_len;

    if (!title) {
      return judge(
        [
          {
            entity: 'title',
            expected: 'тег <title> с ключевыми словами',
            actual: 'тега нет или он пустой',
            severity: 'P1',
            fix: 'Добавить в <head> тег <title> с ключевыми словами страницы.',
          },
        ],
        this.severity,
      );
    }

    const findings = [];

    if (titleCount > 1) {
      findings.push({
        entity: 'количество',
        expected: 'один <title>',
        actual: `${titleCount}`,
        fix: 'Оставить в <head> один <title>, лишние убрать.',
      });
    }
    if (title.length > max) {
      findings.push({
        entity: 'длина',
        expected: `не больше ${max} символов`,
        actual: `${title.length} символов`,
        evidence: title,
        fix: `Сократить title до ${max} символов, оставив ключевые слова в начале.`,
      });
    }

    // Ключевые слова: сначала факт наличия, потом позиция — «чем важнее слово,
    // тем ближе к началу» из чеклиста.
    const missing = ctx.keywords.all.filter((k) => !hasAnyStem(title, k.stems));
    if (missing.length) {
      findings.push({
        entity: 'ключевые слова',
        expected: 'title содержит ключевые слова страницы',
        actual: `нет упоминаний: ${missing.map((k) => k.word).join(', ')}`,
        evidence: title,
        note: `Источник ключевых слов: ${ctx.keywords.source}.`,
        fix: 'Добавить в title ключевые слова страницы, ближе к началу.',
      });
    }

    const entity = ctx.keywords.entity;
    // Позицию считаем по той форме, которая на странице правда есть: на английской
    // странице это «Batumi», а не транслит «батуми», и раньше проверка молча пропускалась.
    const present = entity?.stems.find((one) => hasStem(title, one));
    if (present) {
      const at = title.toLowerCase().indexOf(present.slice(0, 4));
      const limit = Math.round(title.length * ctx.thresholds.title_keyword_head_ratio);
      if (at > limit) {
        findings.push({
          entity: 'позиция ключевого слова',
          expected: 'ключевое слово в первой половине title',
          actual: `«${entity.word}» на символе ${at} из ${title.length}`,
          evidence: clip(title, 90),
          severity: 'P3',
          fix: 'Перенести главное ключевое слово в первую половину title.',
        });
      }
    }

    return judge(findings, this.severity);
  },
};
