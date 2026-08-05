// Ожидаемые ключевые слова страницы, выведенные из её URL.
//
// Слаг страницы — это транслит русского названия (tailand, turtsiya, chernogoriya),
// поэтому обратная транслитерация даёт нужное слово без ручного конфига. Сравнение
// идёт по стему, иначе падежи («в Турцию», «из Турции») ломали бы проверку.
//
// Если автовывод для какого-то типа страниц не сработает, в config/pages.json
// у страницы можно задать keywords: [...] — он перекрывает автовывод.

import { normalize } from './text.mjs';

// Порядок важен: многобуквенные сочетания идут раньше одиночных букв.
const TRANSLIT = [
  ['shch', 'щ'],
  ['sch', 'щ'],
  ['zh', 'ж'],
  ['kh', 'х'],
  ['ts', 'ц'],
  ['ch', 'ч'],
  ['sh', 'ш'],
  ['yu', 'ю'],
  ['ya', 'я'],
  ['yo', 'ё'],
  ['iu', 'ю'],
  ['ia', 'я'],
  ['a', 'а'],
  ['b', 'б'],
  ['v', 'в'],
  ['g', 'г'],
  ['d', 'д'],
  ['e', 'е'],
  ['z', 'з'],
  ['i', 'и'],
  ['k', 'к'],
  ['l', 'л'],
  ['m', 'м'],
  ['n', 'н'],
  ['o', 'о'],
  ['p', 'п'],
  ['r', 'р'],
  ['s', 'с'],
  ['t', 'т'],
  ['u', 'у'],
  ['f', 'ф'],
  ['h', 'х'],
  ['c', 'к'],
  ['j', 'ж'],
  ['q', 'к'],
  ['w', 'в'],
  ['x', 'кс'],
  ['-', ' '],
  ['_', ' '],
];

const TAIL = new Set(['а', 'е', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я', 'ь', 'ъ', 'й']);
const MIN_STEM = 5;
const MAX_STRIP = 2;

const CONSONANT = /[bcdfghjklmnpqrstvwxz]/;

/**
 * tailand → таиланд, turtsiya → турция, zhukovsky → жуковский, krym → крым.
 *
 * Одиночная «y» разбирается по соседям, потому что в транслите она означает три
 * разных звука: на конце слова после согласной это «ий» (zhukovsky), между
 * согласными — «ы» (krym), в остальных случаях — «й». Сочетания ya/yu/yo/ye
 * разбираются раньше по таблице.
 */
export function translit(slugPart) {
  const source = String(slugPart || '').toLowerCase();
  let rest = source;
  let out = '';

  outer: while (rest.length) {
    for (const [lat, cyr] of TRANSLIT) {
      if (rest.startsWith(lat)) {
        out += cyr;
        rest = rest.slice(lat.length);
        continue outer;
      }
    }

    if (rest[0] === 'y') {
      const previous = source[source.length - rest.length - 1] ?? '';
      const afterConsonant = CONSONANT.test(previous);
      out += rest.length === 1 && afterConsonant ? 'ий' : afterConsonant ? 'ы' : 'й';
      rest = rest.slice(1);
      continue;
    }

    out += rest[0];
    rest = rest.slice(1);
  }
  return out;
}

/** Отрезает падежное окончание: турция → турци, черногория → черногор, таиланд → таиланд. */
export function stem(word) {
  let s = normalize(word);
  let stripped = 0;
  while (s.length > MIN_STEM && stripped < MAX_STRIP && TAIL.has(s.at(-1))) {
    s = s.slice(0, -1);
    stripped++;
  }
  return s;
}

// Первый сегмент пути задаёт тему страницы. Новый тип страниц — новая строка здесь.
//
// Формы через запятую — одно и то же слово на разных языках: страницы aviasales.ge
// и aviasales.uz бывают на английском, и ждать на них «авиабилеты» бессмысленно.
// Первая форма идёт в текст находки, совпасть достаточно любой.
const TOPIC_BY_SEGMENT = {
  countries: ['авиабилеты', 'flight', 'ticket'],
  cities: ['авиабилеты', 'flight', 'ticket'],
  routes: ['авиабилеты', 'flight', 'ticket'],
  airlines: ['авиакомпания', 'airline'],
  airports: ['аэропорт', 'airport'],
  hotels: ['отели', 'hotel'],
};

/** Ключевое слово: что печатать в находке и по каким формам искать на странице. */
function keyword(forms, role) {
  const list = [...new Set(forms.filter(Boolean))];
  return {
    word: list[0],
    stem: stem(list[0]),
    stems: [...new Set(list.map(stem))],
    role,
  };
}

// Слаг несёт название страницы не всегда. У маршрута это два IATA-кода
// (routes/mow/aer), у города код приклеен к названию (cities/moskva-mow), у аэропорта
// к названию добавлены английские слова (airports/zhukovsky-international-airport-zia).
// Дословная транслитерация такого даёт «аер» и «жуковскй интернатионал аирпорт» —
// слова, которых на странице нет, то есть гарантированное ложное срабатывание.
const IATA = /^[a-z]{3}$/;
const FILLER = new Set([
  'international',
  'intl',
  'airport',
  'airports',
  'station',
  'terminal',
  'city',
  'the',
  'and',
  'of',
]);

/** Токены названия из последнего сегмента пути. Пусто, если названия в URL нет. */
export function nameTokens(url) {
  let segments;
  try {
    segments = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }

  const last = segments.at(-1);
  if (!last || last === segments[0]) return [];

  let tokens = last.split(/[-_]/).filter(Boolean);
  // Код в конце слага — идентификатор, а не слово: cities/moskva-mow → moskva.
  if (tokens.length > 1 && IATA.test(tokens.at(-1))) tokens = tokens.slice(0, -1);
  tokens = tokens.filter((t) => !FILLER.has(t) && !/^\d+$/.test(t));
  // Сегмент состоит из одного кода: routes/mow/aer — названия в URL просто нет.
  if (tokens.length === 1 && IATA.test(tokens[0])) return [];
  return tokens;
}

/** Слова человеческого названия: «Москва — Сочи» → [Москва, Сочи], «Жуковский (ZIA)» → [Жуковский]. */
function labelWords(label) {
  return String(label ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
}

/**
 * @param {{url: string, keywords?: string[], label?: string}} page
 * @returns {{source: string, topic: object|null, entity: object|null, all: object[]}}
 */
export function keywordsFor(page) {
  if (Array.isArray(page.keywords) && page.keywords.length) {
    return {
      source: 'конфиг',
      topic: null,
      entity: null,
      all: page.keywords.map((w) => keyword([w], 'custom')),
    };
  }

  let firstSegment = null;
  try {
    firstSegment = new URL(page.url).pathname.split('/').filter(Boolean)[0] ?? null;
  } catch {
    return { source: 'URL', topic: null, entity: null, all: [] };
  }

  const topicForms = TOPIC_BY_SEGMENT[firstSegment] ?? null;
  const topic = topicForms ? keyword(topicForms, 'topic') : null;

  let source = 'URL';
  // Обе формы названия: латиницу из слага и её транслит. «Batumi» на английской
  // странице и «Батуми» на русской — одно слово, и раньше находилось только второе.
  let words = nameTokens(page.url).map((token) => [translit(token), token]);

  // Названия в URL нет — маршрут это пара кодов. Берём его из label конфига:
  // «Москва — Сочи» даёт ровно те слова, которые ожидаются в тексте страницы.
  if (!words.length) {
    const fromLabel = labelWords(page.label);
    if (fromLabel.length) {
      words = fromLabel.map((word) => [word]);
      source = 'URL + label';
    }
  }

  const entities = words.map((forms) => keyword(forms, 'entity'));
  return {
    source,
    topic,
    // Проверка позиции ключевого слова в title смотрит на главное из них.
    entity: entities[0] ?? null,
    all: [topic, ...entities].filter(Boolean),
  };
}
