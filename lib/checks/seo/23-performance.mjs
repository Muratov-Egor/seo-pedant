import { judge } from '../../verdict.mjs';

const FORM_FACTORS = [
  ['desktop', 'десктоп'],
  ['mobile', 'мобайл'],
];

export default {
  id: 'performance',
  checklist: 'Перформанс страницы (Lighthouse)',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['lighthouse'],
  severity: 'P2',

  // Оценка Lighthouse шумит на ±10 между прогонами, поэтому в entity (а значит и в
  // отпечатке) идёт только форм-фактор. Иначе каждый прогон давал бы «новую» проблему.
  run(f, ctx) {
    const findings = [];
    const min = ctx.thresholds.lighthouse_min_score;

    for (const [key, label] of FORM_FACTORS) {
      const run = f.lighthouse?.[key];
      if (!run) continue;

      if (run.error) {
        findings.push({
          entity: label,
          expected: `оценка перформанса не ниже ${min}`,
          actual: `Lighthouse не отработал: ${run.error}`,
          severity: 'P3',
        });
        continue;
      }

      if (run.score < min) {
        const worst = Object.entries(run.metrics ?? {})
          .map(([name, value]) => `${name}: ${value}`)
          .join(', ');
        findings.push({
          entity: label,
          expected: `оценка не ниже ${min}`,
          actual: `${run.score}`,
          evidence: worst || null,
          note: 'Оценка колеблется между прогонами: важна тенденция, а не отдельное значение.',
        });
      }
    }

    return judge(findings, this.severity);
  },
};
