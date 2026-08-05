import { judge } from '../../verdict.mjs';

const REQUIRED_OG = ['title', 'description', 'image'];
const REQUIRED_TWITTER = ['card', 'title', 'description', 'image'];

export default {
  id: 'og-twitter',
  checklist: 'Наличие Open Graph / Twitter meta',
  family: 'seo-checklist',
  // Содержание этих тегов на SEO не влияет (так в чеклисте), поэтому P3.
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
        fix: `Добавить в <head> теги og:${missingOg.join(', og:')}.`,
      });
    }

    const missingTw = REQUIRED_TWITTER.filter((k) => !twitter[k]);
    if (missingTw.length) {
      findings.push({
        entity: 'Twitter meta',
        expected: `заполнены twitter:${REQUIRED_TWITTER.join(', twitter:')}`,
        actual: `нет: twitter:${missingTw.join(', twitter:')}`,
        fix: `Добавить в <head> теги twitter:${missingTw.join(', twitter:')}.`,
      });
    }

    // Относительный путь в og:image / twitter:image находкой не считается: владелец
    // проверил на своих страницах, что и Facebook, и Twitter достраивают его сами и
    // превью отрисовывается. Проверка следит только за тем, что теги вообще есть.

    return judge(findings, this.severity);
  },
};
