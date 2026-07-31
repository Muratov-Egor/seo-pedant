import { judge } from '../../verdict.mjs';
import { clip } from '../../text.mjs';

/** Стабильный адрес картинки для истории находок: путь без query и хеша. */
function imageKey(img, index) {
  if (!img.srcAbs && !img.src) return `img #${index + 1}`;
  try {
    const u = new URL(img.srcAbs ?? img.src);
    return `${u.host}${u.pathname}`;
  } catch {
    return clip(img.src, 80);
  }
}

export default {
  id: 'alt-tags',
  checklist: 'Alt-теги у всех изображений',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html'],
  severity: 'P1',

  run(f, ctx) {
    const findings = [];
    const { alt_words_min: min, alt_words_max: max } = ctx.thresholds;

    f.html.images.forEach((img, index) => {
      const key = imageKey(img, index);

      if (!img.hasAlt) {
        findings.push({
          entity: key,
          expected: 'атрибут alt есть',
          actual: 'атрибута alt нет',
          note: 'Без alt робот не понимает, что на картинке, и теряется вхождение ключевых слов.',
        });
        return;
      }

      // Пустой alt — корректная разметка декоративной картинки, но на контентной
      // странице это чаще недосмотр, поэтому показываем как замечание.
      if (!img.alt) {
        findings.push({
          entity: key,
          expected: `описание в ${min}–${max} словах`,
          actual: 'alt пустой',
          severity: 'P3',
        });
        return;
      }

      if (img.altWords < min || img.altWords > max) {
        findings.push({
          entity: key,
          expected: `описание в ${min}–${max} словах`,
          actual: `${img.altWords} сл.: «${clip(img.alt, 60)}»`,
          severity: 'P3',
        });
      }
    });

    return judge(findings, this.severity);
  },
};
