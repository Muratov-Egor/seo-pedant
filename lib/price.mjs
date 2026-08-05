// Цены в тексте: поиск, разбор и сравнение. Чистые функции без зависимостей.
//
// Все SEO-страницы — про цены: и в title, и в тексте стоит «от N ₽». Проверкам нужно
// уметь взять эти числа из готового текста, поэтому знание про форматы цен живёт здесь
// одно на весь проект, а не внутри проверки.

/** Символ или слово валюты → код. Только валюты, в которых бывают наши страницы. */
const CURRENCY = [
  ['₽', 'RUB'],
  ['руб', 'RUB'],
  ['₸', 'KZT'],
  ['тенге', 'KZT'],
  ['₾', 'GEL'],
  ['лари', 'GEL'],
  ['₺', 'TRY'],
  ['₴', 'UAH'],
  ['₼', 'AZN'],
  ['сум', 'UZS'],
  ['драм', 'AMD'],
  ['сом', 'KGS'],
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['₹', 'INR'],
];

const SYMBOL_BY_CODE = Object.fromEntries(
  CURRENCY.filter(([token]) => token.length === 1).map(([token, code]) => [code, token]),
);

function currencyCode(token) {
  const t = String(token).toLowerCase();
  const found = CURRENCY.find(([one]) => t.startsWith(one.toLowerCase()));
  return found ? found[1] : null;
}

/** Символ валюты для отчёта: у безымянных кодов остаётся сам код. */
export function currencySymbol(code) {
  return SYMBOL_BY_CODE[code] ?? code;
}

// Пробелы, которыми разделяют разряды: обычный, неразрывный и узкий неразрывный.
const SPACES = '   ';
const TOKENS = CURRENCY.map(([t]) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const NUMBER = `\\d[\\d${SPACES}.,]{0,12}\\d|\\d`;
// Валюта бывает и после числа («2 183 ₽»), и перед ним («₾138.93»).
const PRICE_RE = new RegExp(`(?:(${NUMBER})\\s*(${TOKENS})|(${TOKENS})\\s*(${NUMBER}))`, 'gi');

/**
 * Число из записи цены. Разряды у нас разделяют пробелом, дробную часть — точкой или
 * запятой, но встречается и «1,565» как тысячи, поэтому одиночный разделитель ровно перед
 * тремя цифрами считается разрядным, а не дробным.
 */
export function parseAmount(raw) {
  let s = String(raw).replace(new RegExp(`[${SPACES}]`, 'g'), '');
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  const sep = Math.max(dot, comma);
  if (sep < 0) return Number(s) || 0;

  const tail = s.length - sep - 1;
  const single = dot < 0 || comma < 0;
  const decimal = !(single && tail === 3);
  if (decimal) {
    s = `${s.slice(0, sep).replace(/[.,]/g, '')}.${s.slice(sep + 1)}`;
  } else {
    s = s.replace(/[.,]/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Все цены в тексте по порядку появления.
 * @returns {{raw: string, amount: number, currency: string, at: number}[]}
 */
export function findPrices(text) {
  const source = String(text ?? '');
  const out = [];
  for (const m of source.matchAll(PRICE_RE)) {
    const number = m[1] ?? m[4];
    const code = currencyCode(m[2] ?? m[3]);
    if (!number || !code) continue;
    const amount = parseAmount(number);
    if (!(amount > 0)) continue;
    out.push({ raw: m[0].replace(new RegExp(`[${SPACES}]`, 'g'), ' ').trim(), amount, currency: code, at: m.index ?? 0 });
  }
  return out;
}

/** Самая дешёвая из цен, иначе null. */
export function cheapest(prices) {
  return (prices ?? []).reduce((min, p) => (min == null || p.amount < min.amount ? p : min), null) ?? null;
}

/** Цена как строка для отчёта: «9 283 ₽». */
export function formatPrice(price) {
  if (!price) return '—';
  const whole = Math.trunc(price.amount);
  const frac = price.amount - whole;
  const digits = whole.toLocaleString('ru-RU').replace(/ /g, ' ');
  const tail = frac ? String(Math.round(frac * 100)).padStart(2, '0') : null;
  return `${digits}${tail ? `,${tail}` : ''} ${currencySymbol(price.currency)}`;
}

/**
 * Насколько две цены расходятся, в процентах от меньшей. Проценты, а не рубли:
 * расхождение в рубль на 9 283 ₽ и на 138 ₾ — разные по смыслу вещи.
 */
export function diffPct(a, b) {
  const base = Math.min(a, b);
  if (!(base > 0)) return 100;
  return (Math.abs(a - b) / base) * 100;
}
