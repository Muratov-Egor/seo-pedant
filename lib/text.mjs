// Работа с текстом: нормализация, слова, шинглы, поиск по стему.
// Чистые функции без зависимостей — на них опираются и facts, и проверки.

/** Схлопывает любые пробелы и неразрывные пробелы в один обычный. */
export function collapse(s) {
  return String(s ?? '')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Нижний регистр + ё→е + только буквы, цифры и пробелы. Для сравнения текстов. */
export function normalize(s) {
  return collapse(s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function words(s) {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

export function wordCount(s) {
  return words(s).length;
}

/**
 * Есть ли в тексте слово, начинающееся со стема.
 * Стем — усечённая основа без падежного окончания: «турци» находит «Турцию» и «Турции».
 */
export function hasStem(text, stem) {
  if (!stem) return false;
  const target = normalize(stem);
  if (!target) return false;
  return words(text).some((w) => w.startsWith(target));
}

/**
 * Есть ли в тексте хоть одна из форм ключевого слова.
 *
 * Формы нужны, потому что страницы бывают не только на русском: на aviasales.ge
 * то же самое слово — «Batumi» и «flights», а не «Батуми» и «авиабилеты». Совпало
 * что-то одно — слово на странице есть.
 */
export function hasAnyStem(text, stems) {
  const list = Array.isArray(stems) ? stems : [stems];
  return list.some((one) => hasStem(text, one));
}

/** Множество шинглов (n подряд идущих слов) — для сравнения текстов на дубли. */
export function shingles(s, n = 5) {
  const ws = words(s);
  const out = new Set();
  if (ws.length < n) {
    if (ws.length) out.add(ws.join(' '));
    return out;
  }
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(' '));
  return out;
}

/** Доля общих шинглов, 0..100. Мера «насколько два текста один и тот же текст». */
export function similarityPct(a, b, n = 5) {
  const A = shingles(a, n);
  const B = shingles(b, n);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const sh of A) if (B.has(sh)) common++;
  return Math.round((common / Math.min(A.size, B.size)) * 100);
}

/** Обрезает длинную строку для отчёта, не разрывая слово посередине без нужды. */
export function clip(s, max = 160) {
  const t = collapse(s);
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Предложение из текста, содержащее подстроку, — для цитаты-доказательства. */
export function sentenceWith(text, needle, max = 220) {
  const t = collapse(text);
  const at = t.toLowerCase().indexOf(String(needle).toLowerCase());
  if (at < 0) return null;
  const from = Math.max(0, t.lastIndexOf('.', at) + 1);
  const dot = t.indexOf('.', at);
  const to = dot < 0 ? t.length : dot + 1;
  return clip(t.slice(from, to).trim(), max);
}
