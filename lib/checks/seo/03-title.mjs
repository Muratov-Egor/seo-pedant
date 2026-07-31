import { judge } from '../../verdict.mjs';
import { hasStem, clip } from '../../text.mjs';

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
        [{ entity: 'title', expected: 'тег <title> с ключевыми словами', actual: 'тега нет или он пустой', severity: 'P1' }],
        this.severity,
      );
    }

    const findings = [];

    if (titleCount > 1) {
      findings.push({ entity: 'количество', expected: 'один <title>', actual: `${titleCount}` });
    }
    if (title.length > max) {
      findings.push({
        entity: 'длина',
        expected: `не больше ${max} символов`,
        actual: `${title.length}`,
        evidence: title,
      });
    }

    // Ключевые слова: сначала факт наличия, потом позиция — «чем важнее слово,
    // тем ближе к началу» из чеклиста.
    const missing = ctx.keywords.all.filter((k) => !hasStem(title, k.stem));
    if (missing.length) {
      findings.push({
        entity: 'ключевые слова',
        expected: `упоминание: ${ctx.keywords.all.map((k) => k.word).join(', ')}`,
        actual: `нет: ${missing.map((k) => k.word).join(', ')}`,
        evidence: title,
        note: `Ключевые слова выведены из URL (${ctx.keywords.source}).`,
      });
    }

    const entity = ctx.keywords.entity;
    if (entity && hasStem(title, entity.stem)) {
      const at = title.toLowerCase().indexOf(entity.stem.slice(0, 4));
      const limit = Math.round(title.length * ctx.thresholds.title_keyword_head_ratio);
      if (at > limit) {
        findings.push({
          entity: 'позиция ключевого слова',
          expected: `«${entity.word}» в первой половине title`,
          actual: `символ ${at} из ${title.length}`,
          evidence: clip(title, 90),
          severity: 'P3',
        });
      }
    }

    return judge(findings, this.severity);
  },
};
