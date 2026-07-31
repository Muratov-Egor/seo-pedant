import { judge } from '../../verdict.mjs';
import { clip, normalize } from '../../text.mjs';

// HTML от сервера и HTML из браузера снимаются в разные моменты, а на страницах живые
// цены: «цены от 19 725 ₽» против «цены от 19 801 ₽» — это не поломанный SSR.
// Поэтому тексты сравниваются без чисел.
function sameIgnoringNumbers(a, b) {
  const strip = (s) => normalize(s).replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  return strip(a) === strip(b);
}

export default {
  id: 'ssr',
  checklist: 'SSR — контент доступен сразу в HTML',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html', 'dom'],
  severity: 'P1',

  // Сравниваются не строки HTML, а факты, выведенные из HTML до гидрации и после неё:
  // разница в вёрстке роботу безразлична, разница в контенте — нет.
  run(f, ctx) {
    const raw = f.html;
    const dom = f.dom;
    const findings = [];

    if (dom.h1[0] && !raw.h1[0]) {
      findings.push({
        entity: 'h1',
        expected: 'h1 есть в HTML от сервера',
        actual: 'появляется только после отрисовки на клиенте',
        evidence: clip(dom.h1[0], 100),
      });
    } else if (dom.h1[0] && raw.h1[0] && !sameIgnoringNumbers(dom.h1[0], raw.h1[0])) {
      findings.push({
        entity: 'h1',
        expected: `h1 от сервера совпадает с отрисованным: «${clip(dom.h1[0], 60)}»`,
        actual: `от сервера: «${clip(raw.h1[0], 60)}»`,
        severity: 'P2',
        note: 'Числа при сравнении не учитывались — расхождение не в живых ценах.',
      });
    }

    if (dom.title && (!raw.title || !sameIgnoringNumbers(dom.title, raw.title))) {
      findings.push({
        entity: 'title',
        expected: `title от сервера совпадает с отрисованным: «${clip(dom.title, 60)}»`,
        actual: raw.title ? `от сервера: «${clip(raw.title, 60)}»` : 'от сервера title нет',
        severity: 'P2',
        note: 'Числа при сравнении не учитывались — расхождение не в живых ценах.',
      });
    }

    const ratio = dom.textLen > 0 ? raw.textLen / dom.textLen : 1;
    const min = ctx.thresholds.ssr_text_ratio_min;
    if (ratio < min) {
      findings.push({
        entity: 'объём контента',
        expected: `в HTML от сервера не меньше ${Math.round(min * 100)}% текста`,
        actual: `${Math.round(ratio * 100)}% (${raw.textLen} из ${dom.textLen} символов)`,
        note: 'Остальное дорисовывается на клиенте — робот этого может не увидеть.',
      });
    }

    return judge(findings, this.severity);
  },
};
