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
          // Не «превью не отрисуется»: Facebook относительный путь достраивает сам, и в
          // его отладчике картинка видна. Но спецификация Open Graph требует абсолютный
          // URL, и на снисходительность каждого потребителя рассчитывать нельзя.
          note:
            'Спецификация Open Graph требует абсолютный URL. Facebook относительный путь ' +
            'достраивает сам, поэтому превью может отрисоваться — но так ведут себя не все, ' +
            'и результат зависит от того, кто читает страницу.',
          severity: 'P2',
          // Без имени тега в тексте: og:image и twitter:image ломаются одинаково и лечатся
          // одинаково, поэтому в отчёте это должно остаться одной группой с одним решением.
          fix: 'Заменить относительный путь на абсолютный URL — со схемой и доменом сайта.',
        });
      }
    }

    return judge(findings, this.severity);
  },
};
