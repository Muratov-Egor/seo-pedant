import { judge, pass } from '../../verdict.mjs';

const BLOCKING = ['noindex', 'nofollow', 'none'];

export default {
  id: 'meta-robots',
  checklist: 'Тег meta robots не содержит noindex или nofollow',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html'],
  severity: 'P1',

  run(f) {
    const findings = [];

    // Отсутствие тега — норма: по умолчанию индексация разрешена.
    for (const name of ['robots', 'googlebot', 'yandex']) {
      const value = f.html.metaByName[name];
      if (value == null) continue;
      const found = BLOCKING.filter((word) => value.toLowerCase().includes(word));
      if (found.length) {
        findings.push({
          entity: `meta ${name}`,
          expected: 'без noindex и nofollow',
          actual: value,
          evidence: `<meta name="${name}" content="${value}">`,
          fix: `Убрать ${found.join(' и ')} из <meta name="${name}"> — иначе страница выпадает из индекса.`,
        });
      }
    }

    if (!findings.length && f.html.metaByName.robots == null) {
      return pass('тега meta robots нет — индексация разрешена по умолчанию');
    }
    return judge(findings, this.severity);
  },
};
