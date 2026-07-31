import { judge } from '../../verdict.mjs';
import { normalize, similarityPct, clip } from '../../text.mjs';

// Проверка уровня сайта: получает все страницы прогона сразу и возвращает
// вердикт на каждую. Так требование чеклиста «уникальный на всём сайте»
// проверяется хотя бы в пределах того, что бот действительно видел.
const FIELDS = [
  { label: 'title', get: (p) => p.html.title },
  { label: 'description', get: (p) => p.html.description },
  { label: 'h1', get: (p) => p.html.h1[0] },
];

export default {
  id: 'uniqueness',
  checklist: 'Контент уникален и релевантен странице',
  family: 'seo-checklist',
  scope: 'site',
  needs: ['html'],
  severity: 'P2',

  run(all, ctx) {
    const usable = all.filter((p) => p.html);
    const findings = new Map(usable.map((p) => [p.page.slug, []]));

    for (let i = 0; i < usable.length; i++) {
      for (let j = i + 1; j < usable.length; j++) {
        const a = usable[i];
        const b = usable[j];

        for (const field of FIELDS) {
          const va = normalize(field.get(a) ?? '');
          const vb = normalize(field.get(b) ?? '');
          if (!va || !vb || va !== vb) continue;

          for (const [self, other] of [
            [a, b],
            [b, a],
          ]) {
            findings.get(self.page.slug).push({
              entity: `${field.label} vs ${other.page.slug}`,
              expected: `${field.label} уникален на всём сайте`,
              actual: `дословно совпадает со страницей ${other.page.url}`,
              evidence: clip(field.get(self), 120),
            });
          }
        }

        const sim = similarityPct(a.html.text, b.html.text);
        if (sim >= ctx.thresholds.duplicate_text_pct) {
          for (const [self, other] of [
            [a, b],
            [b, a],
          ]) {
            findings.get(self.page.slug).push({
              entity: `текст vs ${other.page.slug}`,
              expected: `совпадение текста меньше ${ctx.thresholds.duplicate_text_pct}%`,
              actual: `${sim}% общих фрагментов с ${other.page.url}`,
              note: 'Считается по совпадению пятисловных фрагментов видимого текста.',
            });
          }
        }
      }
    }

    return Object.fromEntries(
      [...findings].map(([slug, list]) => [slug, judge(list, this.severity)]),
    );
  },
};
