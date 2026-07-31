import { judge } from '../../verdict.mjs';
import { hasStem } from '../../text.mjs';

export default {
  id: 'h1',
  checklist: 'H1 только один, с ключевыми словами',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html'],
  severity: 'P2',

  run(f, ctx) {
    const h1 = f.html.h1;

    if (h1.length === 0) {
      return judge([{ entity: 'h1', expected: 'один <h1> с ключевыми словами', actual: 'тега нет', severity: 'P1' }], this.severity);
    }

    const findings = [];

    if (h1.length > 1) {
      findings.push({
        entity: 'количество',
        expected: 'один <h1>',
        actual: `${h1.length}`,
        evidence: h1.join(' | '),
      });
    }
    if (!h1[0]) {
      findings.push({ entity: 'текст', expected: 'непустой заголовок', actual: 'пустой <h1>' });
    } else {
      const missing = ctx.keywords.all.filter((k) => !hasStem(h1[0], k.stem));
      if (missing.length) {
        findings.push({
          entity: 'ключевые слова',
          expected: 'h1 содержит ключевые слова страницы',
          actual: `нет упоминаний: ${missing.map((k) => k.word).join(', ')}`,
          evidence: h1[0],
        });
      }
    }

    return judge(findings, this.severity);
  },
};
