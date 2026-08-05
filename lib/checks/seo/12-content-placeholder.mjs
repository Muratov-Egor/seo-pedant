import { judge } from '../../verdict.mjs';
import { sentenceWith } from '../../text.mjs';

// Тексты-заглушки, которые не должны доезжать до продакшена.
const PLACEHOLDERS = [
  'lorem ipsum',
  'тестовый текст',
  'текст-заглушка',
  'заглушка',
  'placeholder',
  'dummy text',
  'todo',
  'fixme',
  'coming soon',
  'скоро здесь',
  'текст будет позже',
];

export default {
  id: 'content-placeholder',
  checklist: 'Контент уникален и релевантен странице',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html'],
  severity: 'P1',

  run(f, ctx) {
    const text = f.html.text;
    const findings = [];

    for (const needle of PLACEHOLDERS) {
      if (!text.toLowerCase().includes(needle)) continue;
      findings.push({
        entity: `заглушка «${needle}»`,
        expected: 'в тексте нет заглушек',
        actual: `найдено: «${needle}»`,
        evidence: sentenceWith(text, needle),
        fix: `Убрать со страницы текст-заглушку «${needle}» и дописать настоящий контент.`,
      });
    }

    const min = ctx.thresholds.min_text_chars;
    if (text.length < min) {
      findings.push({
        entity: 'объём текста',
        expected: `не меньше ${min} символов видимого текста`,
        actual: `${text.length}`,
        severity: 'P2',
        note: 'Слишком мало текста — либо контент не отрендерился, либо страница пустая.',
        fix: `Добавить осмысленный текст — не меньше ${min} символов; если текст есть, проверить, что он приходит в HTML.`,
      });
    }

    return judge(findings, this.severity);
  },
};
