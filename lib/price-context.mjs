// Что означает цена на странице. Чистые функции без зависимостей от разметки:
// на вход идут цены с признаками блока (см. prices в lib/facts.mjs) и предмет страницы.
//
// Зачем: сравнивать title с минимумом по всем числам страницы бессмысленно. Страница
// «Москва — Сочи» показывает и свои билеты, и блок «Другие перелёты» с ценами соседних
// маршрутов, и средние цены в ответах на вопросы. Это разные утверждения, и в обещание
// title входит только первое.

const SUBJECT_SEGMENTS = new Set(['routes', 'countries', 'cities', 'airports', 'airlines']);

const BAGGAGE_RE = /с багажом|with baggage|включая багаж/i;

// График «Динамика цен»: цены по месяцам на будущие даты, а не то, что можно купить
// сейчас. В блоке подряд идут сокращения месяцев — по ним он и узнаётся, потому что
// собственного заголовка у столбиков графика нет.
const MONTH_RE = /янв|фев|мар|апр|мая|май|июн|июл|авг|сен|окт|ноя|дек/gi;
const CHART_HEADING_RE = /динамика цен|цены по месяцам|price dynamics|prices by month/i;
const CHART_MONTHS_MIN = 3;
const AGGREGATE_RE =
  /в среднем|средн(?:яя|ие|его|юю)\s+цен|высокий сезон|низкий сезон|в последний момент|при раннем бронировании|on average|average price/i;

/** Текст вокруг самой цены: по нему видно, что сказано про эту цену, а не про соседнюю. */
function around(price, text, span) {
  const source = String(text ?? '');
  const at = source.indexOf(String(price.raw ?? ''));
  if (at < 0) return source;
  return source.slice(Math.max(0, at - span), at + String(price.raw).length + span);
}

/** Предмет страницы по её пути: с чем сравнивать направление цены. */
export function subjectOf(pathname) {
  const segments = String(pathname ?? '')
    .split('/')
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const [section, ...rest] = segments;
  if (!SUBJECT_SEGMENTS.has(section)) return { kind: 'other', path: `/${segments.join('/')}` };
  if (section === 'routes' && rest.length >= 2) {
    return { kind: 'route', from: rest[0], to: rest[1], path: `/${segments.join('/')}` };
  }
  return { kind: section.replace(/s$/, ''), slug: rest.join('/'), path: `/${segments.join('/')}` };
}

/** Путь ссылки без домена, параметров и хвостового слеша, в нижнем регистре. */
function pathOf(href) {
  if (!href) return null;
  const raw = String(href);
  const withoutOrigin = raw.replace(/^https?:\/\/[^/]+/i, '');
  const path = withoutOrigin.split(/[?#]/)[0].replace(/\/+$/, '');
  return path.startsWith('/') ? path.toLowerCase() : null;
}

/**
 * Направление билета из ссылки на поиск: `/search/KRR2808IST1` — Краснодар → Стамбул.
 * Коды городов в ссылке — единственное место, где направление карточки записано явно,
 * а не текстом, который зависит от языка страницы.
 */
export function directionOf(href) {
  const path = pathOf(href);
  if (!path) return null;
  const search = /^\/search\/([a-z]{3})\d{4}([a-z]{3})/.exec(path);
  if (search) return { from: search[1], to: search[2] };
  const route = /^\/routes\/([a-z]{3})\/([a-z]{3})/.exec(path);
  if (route) return { from: route[1], to: route[2] };
  return null;
}

/**
 * Роль цены — входит ли она в обещание title:
 *
 * - `offer` — цена билета, который страница предлагает по своей теме. Только такие цены
 *   участвуют в минимуме;
 * - `other-page` — цена другой страницы-предмета: блок «Другие перелёты» ссылается на
 *   `/routes/led/aer`, блок «Авиабилеты в города» — на `/cities/...`. Это чужое обещание;
 * - `other-route` — карточка поиска по другому направлению на странице маршрута: у страницы
 *   «Москва — Сочи» цена «Москва — Санкт-Петербург» своей не является;
 * - `baggage` — тот же билет с багажом: цена дороже базовой, минимум ею не задаётся;
 * - `aggregate` — статистика из текста: средняя цена, высокий сезон, раннее бронирование.
 *   Утверждение про диапазон, а не предложение купить;
 * - `chart` — столбик графика «Динамика цен»: цена на другой месяц, а не сейчас;
 * - `unknown` — блок распознать не удалось. В минимум не берём, но и молчать не будем:
 *   проверка выносит это в пояснение.
 */
export function roleOf(price, subject) {
  const own = String(price.own ?? price.raw ?? '');
  const block = String(price.block ?? '');

  if (BAGGAGE_RE.test(around(price, own, 35))) {
    return { role: 'baggage', why: 'цена того же билета с багажом' };
  }
  // Окно вокруг цены, а не весь блок: в абзаце про минимальную цену вторым предложением
  // легко стоит «туда-обратно с багажом», и по всему абзацу баггажной становилась бы
  // и минимальная цена тоже.
  if (AGGREGATE_RE.test(around(price, own.length > 60 ? own : block, 90))) {
    return { role: 'aggregate', why: 'средняя или сезонная цена из текста, а не предложение' };
  }
  const months = block.match(MONTH_RE)?.length ?? 0;
  if (CHART_HEADING_RE.test(price.heading ?? '') || months >= CHART_MONTHS_MIN) {
    return { role: 'chart', why: 'цена из графика динамики по месяцам — другие даты' };
  }

  const path = pathOf(price.href);
  const direction = directionOf(price.href);

  if (path && !path.startsWith('/search')) {
    const section = path.split('/')[1];
    if (SUBJECT_SEGMENTS.has(section)) {
      if (path === subject.path) {
        return { role: 'offer', why: 'ссылка ведёт на саму страницу' };
      }
      return {
        role: 'other-page',
        why: `цена другой страницы: ${path}${price.heading ? ` (блок «${price.heading}»)` : ''}`,
      };
    }
  }

  if (subject.kind === 'route' && direction) {
    if (direction.from === subject.from && direction.to === subject.to) {
      return { role: 'offer', why: `карточка билета ${direction.from.toUpperCase()} → ${direction.to.toUpperCase()}` };
    }
    return {
      role: 'other-route',
      why: `билет по другому направлению: ${direction.from.toUpperCase()} → ${direction.to.toUpperCase()}`,
    };
  }

  if (direction) {
    return { role: 'offer', why: `карточка билета ${direction.from.toUpperCase()} → ${direction.to.toUpperCase()}` };
  }

  // Цена без ссылки: на странице маршрута и города это её собственный блок цен
  // («Самый дешёвый», «Цены по месяцам»), поэтому она считается своей.
  if (!price.href) return { role: 'offer', why: 'цена в блоке страницы, без ссылки на другое направление' };

  return { role: 'unknown', why: 'блок распознать не удалось' };
}

/** Город вылета цены, если он записан в ссылке. */
export function originOf(price) {
  return directionOf(price?.href)?.from ?? null;
}

/**
 * Преобладающий город вылета среди цен — город, из которого страница показывает билеты
 * по умолчанию (обычно определённый по геолокации). Нужен, когда у самой цены из title
 * города вылета нет: сравнивать её с билетом из Ларнаки всё равно нельзя.
 */
export function mainOrigin(prices) {
  const tally = new Map();
  for (const price of prices ?? []) {
    const origin = originOf(price);
    if (origin) tally.set(origin, (tally.get(origin) ?? 0) + 1);
  }
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best ? best[0] : null;
}

const ROLE_LABEL = {
  offer: 'свои предложения',
  'other-page': 'цены других страниц',
  'other-route': 'другие направления',
  baggage: 'с багажом',
  chart: 'график по месяцам',
  aggregate: 'средние и сезонные',
  unknown: 'неразобранные',
};

/**
 * Разбор всех цен страницы: что учитываем в минимуме, что отбросили и почему.
 * Возвращает и сами цены с ролями, и готовую строку разбора для отчёта — чтобы находка
 * объясняла своё решение, а не просто называла число.
 */
export function analyzePrices(prices, subject) {
  const judged = (prices ?? []).map((price) => ({ ...price, ...roleOf(price, subject) }));
  const byRole = new Map();
  for (const p of judged) byRole.set(p.role, (byRole.get(p.role) ?? 0) + 1);

  return {
    all: judged,
    counted: judged.filter((p) => p.role === 'offer'),
    byRole,
    /** «учтено 41 своё предложение; не учтены: 27 цен других страниц, 9 с багажом». */
    summary() {
      const counted = byRole.get('offer') ?? 0;
      const rest = [...byRole.entries()]
        .filter(([role]) => role !== 'offer')
        .sort((a, b) => b[1] - a[1])
        .map(([role, n]) => `${n} — ${ROLE_LABEL[role] ?? role}`);
      const head = `В минимум взято цен: ${counted}`;
      return rest.length ? `${head}; не взято: ${rest.join(', ')}.` : `${head}.`;
    },
  };
}
