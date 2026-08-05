import { judge } from '../../verdict.mjs';

export default {
  id: 'description',
  checklist: 'Meta description',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html'],
  severity: 'P2',

  run(f, ctx) {
    const { description } = f.html;
    const max = ctx.thresholds.description_max_len;

    if (description == null) {
      return judge(
        [
          {
            entity: 'description',
            expected: '<meta name="description">',
            actual: 'тега нет',
            fix: 'Добавить в <head> тег <meta name="description"> с описанием страницы.',
          },
        ],
        this.severity,
      );
    }
    if (!description) {
      return judge(
        [
          {
            entity: 'description',
            expected: 'непустое описание',
            actual: 'пустой content',
            fix: 'Заполнить content у <meta name="description">.',
          },
        ],
        this.severity,
      );
    }
    if (description.length > max) {
      return judge(
        [
          {
            entity: 'длина',
            expected: `не больше ${max} символов`,
            actual: `${description.length}`,
            evidence: description,
            fix: `Сократить description до ${max} символов.`,
          },
        ],
        this.severity,
      );
    }
    return judge([], this.severity);
  },
};
