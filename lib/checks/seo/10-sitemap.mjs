import { fail, pass, warn } from '../../verdict.mjs';
import { normUrl } from '../../collect/site.mjs';

export default {
  id: 'sitemap',
  checklist: 'Sitemap.xml содержит ссылку на страницу',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['site'],
  severity: 'P2',

  run(f) {
    const { sitemap } = f.site;
    const target = normUrl(f.http.final?.url ?? f.page.url);
    const where = sitemap.found[target];

    if (where) return pass(`найден в ${where}`);

    // Не найден — но, возможно, не всё просмотрено. Такое честнее показать как «не проверено
    // до конца», чем как отсутствие в sitemap.
    if (sitemap.truncated) {
      return warn({
        entity: 'sitemap',
        expected: `${target} есть в sitemap.xml`,
        actual: `не найден, просмотрено ${sitemap.filesChecked} из ${sitemap.filesTotal} файлов (лимит)`,
        severity: 'P3',
      });
    }

    if (sitemap.errors.length && sitemap.filesChecked === 0) {
      return warn({
        entity: 'sitemap',
        expected: 'sitemap.xml доступен',
        actual: sitemap.errors[0],
        severity: 'P3',
      });
    }

    return fail({
      entity: 'sitemap',
      expected: `${target} есть в sitemap.xml`,
      actual: `не найден среди ${sitemap.filesChecked} файлов sitemap`,
      note: 'Страницы нет в карте сайта — робот найдёт её только по ссылкам.',
    });
  },
};
