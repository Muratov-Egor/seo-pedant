import { judge, skip } from '../../verdict.mjs';
import { clip, quoteAround, sentenceWith } from '../../text.mjs';
import { cheapest, currencySymbol, diffPct, findPrices, formatPrice } from '../../price.mjs';

/**
 * Цена в title и цены на странице — это одно и то же обещание, данное дважды: в выдаче
 * человек видит «от 9 282 ₽», а на странице обязан найти ровно этот билет, и дешевле него
 * на странице ничего быть не должно — в title кладётся самая дешёвая цена.
 *
 * Отсюда два требования, и оба проверяются:
 *   1. цена из title показана на странице — иначе title обещает билет, которого нет;
 *   2. на странице нет цены дешевле — иначе в title попала не самая дешёвая.
 *
 * Порог допуска — `title_price_tolerance_pct`: цены обновляются между сборкой title и
 * отрисовкой блока, и расхождение в рубль на девяти тысячах — не расхождение.
 *
 * Минимум считается по всем ценам страницы: страница показывает и билеты из других городов
 * вылета, и другие направления, а обещание из title относится ко всей странице целиком.
 * Поэтому к находке всегда идёт предложение со страницы, в котором стоит найденная цена, —
 * по нему видно, из какого блока она приехала. Блок, который считать не надо, глушится
 * через `config/ignores.json`.
 */
export default {
  id: 'title-price',
  checklist: 'Цена в title — самая дешёвая на странице',
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
            fix: `Добавить в title цену вида «от ${formatPrice(pageMin)}» — самую дешёвую из показанных на странице.`,
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

    const currencyMin = cheapest(sameCurrency);
    const match = sameCurrency.find((p) => diffPct(p.amount, inTitle.amount) <= tolerance);

    // Требование 1: цена из title вообще показана на странице.
    if (!match) {
      const closest = sameCurrency.reduce((best, p) =>
        diffPct(p.amount, inTitle.amount) < diffPct(best.amount, inTitle.amount) ? p : best,
      );
      findings.push({
        entity: 'цена в title',
        expected: 'цена из title показана на странице',
        // Числа про конкретную страницу идут в actual, а не в note: note общий на группу
        // однотипных находок, и «ближайшая — 12 698 ₽» в нём разводило бы каждую страницу
        // в свою группу.
        actual:
          `в title ${formatPrice(inTitle)}, такой цены на странице нет; ` +
          `ближайшая — ${formatPrice(closest)}, самая дешёвая — ${formatPrice(currencyMin)}`,
        evidence: clip(title, 200),
        note: `Допуск на обновление цен — ${tolerance}%.`,
        fix: 'Собирать цену в title из того же блока цен, что показан на странице, а не из отдельного кэша.',
      });
    }

    // Требование 2: дешевле, чем в title, на странице ничего нет.
    if (
      currencyMin.amount < inTitle.amount &&
      diffPct(currencyMin.amount, inTitle.amount) > tolerance
    ) {
      const cheaper = sameCurrency.filter(
        (p) => p.amount < inTitle.amount && diffPct(p.amount, inTitle.amount) > tolerance,
      );
      const distinct = new Set(cheaper.map((p) => p.amount)).size;
      findings.push({
        entity: 'минимальная цена страницы',
        expected: 'в title самая дешёвая цена страницы',
        actual:
          `в title ${formatPrice(inTitle)}, на странице есть ${formatPrice(currencyMin)}; ` +
          `дешевле, чем в title, — ${distinct} ${distinct === 1 ? 'цена' : 'цен'}`,
        // Цитата с самой дешёвой ценой — по ней видно, из какого блока она приехала:
        // без неё находка требует лезть на страницу и искать число глазами.
        evidence: quoteAround(text, currencyMin.raw) ?? clip(text, 220),
        note:
          `Допуск на обновление цен — ${tolerance}%. В цитате — окно текста вокруг самой дешёвой ` +
          'цены: по нему видно, из какого блока она приехала.',
        fix: 'Ставить в title минимальную из цен, которые показаны на странице.',
      });
    }

    // Если самая дешёвая цена страницы в другой валюте, сравнить её с title нельзя вообще:
    // человек в выдаче и на странице видит разные числа. Валюта блока цен зависит от домена
    // и геолокации, поэтому это замечание, а не нарушение.
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
