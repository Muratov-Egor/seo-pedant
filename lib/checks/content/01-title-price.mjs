import { judge, skip } from '../../verdict.mjs';
import { clip } from '../../text.mjs';
import { cheapest, currencySymbol, diffPct, findPrices, formatPrice } from '../../price.mjs';
import { analyzePrices, mainOrigin, originOf, subjectOf } from '../../price-context.mjs';

/**
 * Цена в title и цены на странице — это одно и то же обещание, данное дважды: в выдаче
 * человек видит «от 9 282 ₽», а на странице обязан найти ровно этот билет, и дешевле него
 * на странице ничего быть не должно — в title кладётся самая дешёвая цена.
 *
 * Отсюда два требования, и оба проверяются:
 *   1. цена из title показана на странице — иначе title обещает билет, которого нет;
 *   2. на странице нет цены дешевле — иначе в title попала не самая дешёвая.
 *
 * Но сравнивать с минимумом по всем числам страницы нельзя: страница «Москва — Сочи»
 * показывает и свои билеты, и блок «Другие перелёты» с ценами соседних маршрутов, и средние
 * цены в ответах на вопросы. Поэтому каждая цена сначала разбирается по блоку — чья она
 * (`lib/price-context.mjs`), — и в минимум идут только предложения самой страницы. Разбор
 * печатается в находке: сколько цен учтено, сколько отброшено и почему.
 *
 * Порог допуска — `title_price_tolerance_pct`: цены обновляются между сборкой title и
 * отрисовкой блока, и расхождение в рубль на девяти тысячах — не расхождение.
 */
export default {
  id: 'title-price',
  checklist: 'Цена в title — самая дешёвая на странице',
  family: 'content',
  scope: 'page',
  needs: ['html'],
  severity: 'P2',

  run(f, ctx) {
    // Судим то, что видит человек: отрисованный DOM, если он снят. В HTML от сервера цены
    // те же, но блоки бывают недорисованы, и роль цены тогда определяется хуже.
    const view = f.dom ?? f.html;
    const title = view.title;
    if (!title) return skip('нет title — сравнивать нечего, см. пункт «Title страницы»');

    if (!view.prices.length) return skip('на странице не показаны цены — сравнивать не с чем');

    const subject = subjectOf(f.finalUrl?.pathname ?? f.url.pathname);
    const analysis = analyzePrices(view.prices, subject);
    const pageMin = cheapest(analysis.counted);
    // Все цены страницы — чужие: одни блоки про другие направления, другие про средние
    // значения. Сравнивать не с чем, и выдумывать сравнение нельзя.
    if (!pageMin) {
      return skip(
        `цены на странице есть, но ни одна не является предложением самой страницы. ${analysis.summary()}`,
      );
    }

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
            note: `${analysis.summary()} Самая дешёвая из них — ${formatPrice(pageMin)}.`,
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
    const sameCurrency = analysis.counted.filter((p) => p.currency === inTitle.currency);

    if (!sameCurrency.length) {
      const currencies = [...new Set(analysis.counted.map((p) => p.currency))];
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
    // Цена из title обычно стоит на странице несколько раз: в заголовке блока без ссылки
    // («Самый дешёвый») и в самой карточке билета. Город вылета знает только карточка,
    // поэтому среди совпавших цен ищем ту, у которой он есть.
    const matches = sameCurrency.filter((p) => diffPct(p.amount, inTitle.amount) <= tolerance);
    const match = matches.find((p) => originOf(p)) ?? matches[0] ?? null;

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
          `в title ${formatPrice(inTitle)}, среди предложений страницы такой цены нет; ` +
          `ближайшая — ${formatPrice(closest)}, самая дешёвая — ${formatPrice(currencyMin)}`,
        evidence: clip(title, 200),
        note: `Допуск на обновление цен — ${tolerance}%.`,
        fix: 'Собирать цену в title из того же блока цен, что показан на странице, а не из отдельного кэша.',
      });
    }

    // Требование 2: дешевле, чем в title, среди предложений страницы ничего нет.
    //
    // Сравниваем внутри того же города вылета, что и цена в title: страна показывает билеты
    // из десятка городов, и билет из Кишинёва дешевле не делает title для Москвы ложью —
    // человек из Москвы его не купит. Город вылета берём из ссылки карточки, совпавшей с
    // ценой title; цены без города вылета — это утверждения самой страницы («Самый дешёвый»,
    // «Самая низкая цена»), поэтому они считаются всегда.
    const exactOrigin = match ? originOf(match) : null;
    // Если у самой цены из title города вылета нет, берём преобладающий на странице: страница
    // показывает билеты из города по геолокации, и сравнивать «от 19 739 ₽» с билетом
    // Белград — Подгорица всё равно нельзя.
    const titleOrigin = exactOrigin ?? mainOrigin(analysis.counted);
    const comparable = titleOrigin
      ? sameCurrency.filter((p) => {
          const origin = originOf(p);
          return origin === null || origin === titleOrigin;
        })
      : sameCurrency;
    const scopeNote = titleOrigin
      ? `Сравнивали с билетами из ${exactOrigin ? 'того же города вылета, что в title' : 'преобладающего на странице города вылета'} ` +
        `(${titleOrigin.toUpperCase()}), и с ценами самой страницы без города вылета.`
      : 'Город вылета на странице не указан — сравнивали со всеми предложениями страницы.';
    const comparableMin = cheapest(comparable);

    if (
      comparableMin.amount < inTitle.amount &&
      diffPct(comparableMin.amount, inTitle.amount) > tolerance
    ) {
      const cheaper = comparable.filter(
        (p) => p.amount < inTitle.amount && diffPct(p.amount, inTitle.amount) > tolerance,
      );
      const distinct = new Set(cheaper.map((p) => p.amount)).size;
      findings.push({
        entity: 'минимальная цена страницы',
        expected: 'в title самая дешёвая цена страницы',
        actual:
          `в title ${formatPrice(inTitle)}, на странице есть ${formatPrice(comparableMin)} ` +
          `(${comparableMin.why}); дешевле, чем в title, — ${distinct} ${distinct === 1 ? 'цена' : 'цен'}`,
        // Цитата — блок, в котором стоит самая дешёвая цена: по ней видно, что это
        // действительно предложение страницы, а не соседнее направление.
        evidence: comparableMin.linkText || comparableMin.block || comparableMin.own,
        note: `${analysis.summary()} ${scopeNote} Допуск на обновление цен — ${tolerance}%.`,
        fix: 'Ставить в title минимальную из цен, которые страница предлагает по своей теме.',
      });
    }

    return judge(findings, this.severity);
  },
};
