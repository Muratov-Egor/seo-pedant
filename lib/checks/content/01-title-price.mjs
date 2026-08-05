import { judge, skip } from '../../verdict.mjs';
import { clip, sentenceWith } from '../../text.mjs';
import { cheapest, currencySymbol, diffPct, findPrices, formatPrice } from '../../price.mjs';

/**
 * Цена в title и цены на странице — это одно и то же обещание, данное дважды: в выдаче
 * человек видит «от 9 282 ₽», а на странице обязан найти ровно этот билет. Расходятся они,
 * когда title собран отдельно от блока цен — по устаревшему кэшу, по другому городу вылета
 * или по другой валюте, — и это видно только сравнением.
 *
 * Что проверяем: цена из title есть среди цен, показанных на странице. Порог допуска —
 * `title_price_tolerance_pct`: цены обновляются между сборкой title и отрисовкой блока,
 * и расхождение в рубль на девяти тысячах — не расхождение.
 *
 * Чего НЕ проверяем: что цена из title — минимум среди всех чисел на странице. Страница
 * страны показывает и билеты из других городов вылета, и другие направления: минимум по
 * всему тексту почти всегда ниже честной цены из title, и правило «title = минимум по
 * тексту» срабатывало бы на каждой странице, ничего не сообщая. Сузить его можно, только
 * зная разметку блока цен, — тогда это отдельная проверка.
 */
export default {
  id: 'title-price',
  checklist: 'Цена в title показана на странице',
  family: 'content',
  scope: 'page',
  needs: ['html'],
  severity: 'P2',

  run(f, ctx) {
    const title = f.html.title;
    if (!title) return skip('нет title — сравнивать нечего, см. пункт «Title страницы»');

    const text = f.html.text;
    const pagePrices = findPrices(text);
    // Страница без цен — не нарушение этой проверки: так выглядят, например, страницы
    // аэропортов с табло и расписанием. Требовать цену в title там нечего.
    if (!pagePrices.length) return skip('на странице не показаны цены — сравнивать не с чем');

    const pageMin = cheapest(pagePrices);
    const titlePrices = findPrices(title);
    const tolerance = ctx.thresholds.title_price_tolerance_pct;

    if (!titlePrices.length) {
      return judge(
        [
          {
            entity: 'цена в title',
            expected: 'title содержит цену — страница про цены на билеты',
            actual: 'в title нет цены',
            evidence: clip(title, 200),
            note: `На странице цены есть, самая дешёвая — ${formatPrice(pageMin)}.`,
            fix: `Добавить в title цену вида «от ${formatPrice(pageMin)}» — ту же, что показана на странице.`,
          },
        ],
        this.severity,
      );
    }

    // Если в title несколько цен, судим самую дешёвую: это она стоит в «от N» и её
    // человек видит в выдаче.
    const inTitle = cheapest(titlePrices);
    const findings = [];
    const sameCurrency = pagePrices.filter((p) => p.currency === inTitle.currency);

    if (!sameCurrency.length) {
      const currencies = [...new Set(pagePrices.map((p) => p.currency))];
      findings.push({
        entity: 'валюта цены в title',
        expected: `цена в title в той же валюте, что на странице (${currencies.map(currencySymbol).join(', ')})`,
        actual: `в title ${currencySymbol(inTitle.currency)} — ${inTitle.raw}`,
        evidence: clip(title, 200),
        severity: 'P1',
        note: 'Цена в чужой валюте вводит в заблуждение сильнее, чем её отсутствие.',
        fix: 'Собирать цену в title в валюте страницы — той, в которой показан блок цен.',
      });
      return judge(findings, this.severity);
    }

    const match = sameCurrency.find((p) => diffPct(p.amount, inTitle.amount) <= tolerance);
    if (!match) {
      const closest = sameCurrency.reduce((best, p) =>
        diffPct(p.amount, inTitle.amount) < diffPct(best.amount, inTitle.amount) ? p : best,
      );
      const currencyMin = cheapest(sameCurrency);
      findings.push({
        entity: 'цена в title',
        expected: 'цена из title показана на странице',
        actual: `в title ${formatPrice(inTitle)}, такой цены на странице нет`,
        evidence: clip(title, 200),
        note:
          `Ближайшая цена на странице — ${formatPrice(closest)}, самая дешёвая — ${formatPrice(currencyMin)}. ` +
          `Допуск на обновление цен — ${tolerance}%.`,
        fix: 'Собирать цену в title из того же блока цен, что показан на странице, а не из отдельного кэша.',
      });
      return judge(findings, this.severity);
    }

    // Цена совпала — но если самая дешёвая цена страницы в другой валюте, человек в выдаче
    // и на странице видит разные числа. Это замечание, а не нарушение: валюта блока цен
    // зависит от домена и геолокации.
    if (pageMin.currency !== inTitle.currency) {
      findings.push({
        entity: 'валюта минимальной цены',
        expected: 'все цены страницы в одной валюте',
        actual: `в title ${currencySymbol(inTitle.currency)}, самая дешёвая цена страницы — ${formatPrice(pageMin)}`,
        evidence: sentenceWith(text, pageMin.raw) ?? clip(text, 200),
        severity: 'P3',
        fix: 'Приводить цены страницы к одной валюте — той, что стоит в title.',
      });
    }

    return judge(findings, this.severity);
  },
};
