import { judge } from '../../verdict.mjs';
import { clip } from '../../text.mjs';

export default {
  id: 'headings',
  checklist: 'Структура подзаголовков H2–H6',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html'],
  severity: 'P2',

  run(f) {
    const headings = f.html.headings;

    if (headings.length === 0) {
      return judge([{ entity: 'заголовки', expected: 'есть заголовки', actual: 'на странице нет ни одного h1–h6' }], this.severity);
    }

    const findings = [];

    if (headings[0].level !== 1) {
      findings.push({
        entity: 'первый заголовок',
        expected: 'страница начинается с h1',
        actual: `h${headings[0].level}: ${clip(headings[0].text, 60)}`,
        severity: 'P3',
      });
    }

    // Пропуск уровня: заголовок глубже предыдущего больше чем на один шаг.
    let previous = headings[0].level;
    for (const h of headings.slice(1)) {
      if (h.level > previous + 1) {
        findings.push({
          entity: `h${previous} → h${h.level}`,
          expected: `после h${previous} идёт h${previous + 1}`,
          actual: `h${h.level}: ${clip(h.text, 60)}`,
          note: 'Пропуск уровня ломает иерархию: робот теряет вложенность разделов.',
        });
      }
      previous = h.level;
    }

    return judge(findings, this.severity);
  },
};
