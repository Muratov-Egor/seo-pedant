import { judge, skip } from '../../verdict.mjs';
import { hasStem } from '../../text.mjs';

export default {
  id: 'keywords',
  checklist: 'Ключевые слова встречаются в тексте и alt-тегах',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html'],
  severity: 'P2',

  run(f, ctx) {
    if (!ctx.keywords.all.length) {
      return skip('не удалось вывести ключевые слова из URL — задать keywords в config/pages.json');
    }

    const findings = [];
    const text = f.html.text;

    const missingInText = ctx.keywords.all.filter((k) => !hasStem(text, k.stem));
    if (missingInText.length) {
      // «Ожидалось» описывает правило, а не эту конкретную страницу: иначе в отчёте
      // каждая страница образует свою группу с одинаковым по смыслу пояснением.
      findings.push({
        entity: 'текст страницы',
        expected: 'в тексте есть ключевые слова страницы',
        actual: `нет упоминаний: ${missingInText.map((k) => k.word).join(', ')}`,
        note: `Ключевые слова выведены из URL (${ctx.keywords.source}).`,
      });
    }

    const alts = f.html.images.map((i) => i.alt).filter(Boolean);
    if (alts.length) {
      const inAlt = ctx.keywords.all.some((k) => alts.some((alt) => hasStem(alt, k.stem)));
      if (!inAlt) {
        findings.push({
          entity: 'alt изображений',
          expected: 'хотя бы один alt содержит ключевое слово страницы',
          actual: `ни в одном из ${alts.length} alt нет: ${ctx.keywords.all.map((k) => k.word).join(', ')}`,
          evidence: alts.slice(0, 5).join(' | '),
          severity: 'P3',
        });
      }
    }

    return judge(findings, this.severity);
  },
};
