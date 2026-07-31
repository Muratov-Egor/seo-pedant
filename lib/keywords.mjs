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
  ['y', 'й'],
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

/** tailand → таиланд, turtsiya → турция, chernogoriya → черногория. */
export function translit(slugPart) {
  let rest = String(slugPart || '').toLowerCase();
  let out = '';
  outer: while (rest.length) {
    for (const [lat, cyr] of TRANSLIT) {
      if (rest.startsWith(lat)) {
        out += cyr;
        rest = rest.slice(lat.length);
        continue outer;
      }
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
const TOPIC_BY_SEGMENT = {
  countries: 'авиабилеты',
  cities: 'авиабилеты',
  routes: 'авиабилеты',
  airlines: 'авиакомпания',
  airports: 'аэропорт',
  hotels: 'отели',
};

/**
 * @param {{url: string, keywords?: string[], label?: string}} page
 * @returns {{source: 'config'|'url', topic: object|null, entity: object|null, all: object[]}}
 */
export function keywordsFor(page) {
  if (Array.isArray(page.keywords) && page.keywords.length) {
    const all = page.keywords.map((w) => ({ word: w, stem: stem(w), role: 'custom' }));
    return { source: 'config', topic: null, entity: null, all };
  }

  let segments = [];
  try {
    segments = new URL(page.url).pathname.split('/').filter(Boolean);
  } catch {
    return { source: 'url', topic: null, entity: null, all: [] };
  }

  const topicWord = TOPIC_BY_SEGMENT[segments[0]] ?? null;
  const topic = topicWord ? { word: topicWord, stem: stem(topicWord), role: 'topic' } : null;

  const last = segments.at(-1);
  const entityWord = last && last !== segments[0] ? translit(last) : null;
  const entity = entityWord ? { word: entityWord, stem: stem(entityWord), role: 'entity' } : null;

  return { source: 'url', topic, entity, all: [topic, entity].filter(Boolean) };
}
