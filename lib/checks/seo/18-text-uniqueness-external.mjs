import { na } from '../../verdict.mjs';

export default {
  id: 'text-uniqueness-external',
  checklist: 'Контент уникален и релевантен странице',
  family: 'seo-checklist',
  scope: 'page',
  needs: [],
  severity: 'P2',

  // Пункт чеклиста «уникальность выше 90%» проверяется внешним сервисом (text.ru
  // antiplagiat) и требует платного API-ключа. Проверка объявлена явно, чтобы в отчёте
  // было видно: этот пункт не проверен, а не «пройден».
  run() {
    return na('нужен API-ключ text.ru; дубли между нашими страницами проверяет uniqueness');
  },
};
