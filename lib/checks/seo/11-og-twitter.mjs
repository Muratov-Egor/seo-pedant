import { judge } from '../../verdict.mjs';

const REQUIRED_OG = ['title', 'description', 'image'];
const REQUIRED_TWITTER = ['card', 'title', 'description', 'image'];

export default {
  id: 'og-twitter',
  checklist: 'Наличие Open Graph / Twitter meta',
  family: 'seo-checklist',
  // Содержание этих тегов на SEO не влияет (так в чеклисте), поэтому дефолт P3.
  // Исключение — относительный URL картинки: он ломает саму функцию шаринга.
  scope: 'page',
  needs: ['html'],
  severity: 'P3',

  run(f) {
    const { og, twitter } = f.html;
    const findings = [];

    const missingOg = REQUIRED_OG.filter((k) => !og[k]);
    if (missingOg.length) {
      findings.push({
        entity: 'Open Graph',
        expected: `заполнены og:${REQUIRED_OG.join(', og:')}`,
        actual: `нет: og:${missingOg.join(', og:')}`,
      });
    }

    const missingTw = REQUIRED_TWITTER.filter((k) => !twitter[k]);
    if (missingTw.length) {
      findings.push({
        entity: 'Twitter meta',
        expected: `заполнены twitter:${REQUIRED_TWITTER.join(', twitter:')}`,
        actual: `нет: twitter:${missingTw.join(', twitter:')}`,
      });
    }

    for (const [label, value] of [
      ['og:image', og.image],
      ['twitter:image', twitter.image],
    ]) {
      if (value && !/^https?:\/\//i.test(value)) {
        findings.push({
          entity: label,
          expected: 'абсолютный URL картинки',
          actual: value,
          evidence: `<meta ${label.startsWith('og') ? 'property' : 'name'}="${label}" content="${value}">`,
          note: 'Соцсети и мессенджеры не достраивают относительный путь — превью не отрисуется.',
          severity: 'P2',
        });
      }
    }

    return judge(findings, this.severity);
  },
};
