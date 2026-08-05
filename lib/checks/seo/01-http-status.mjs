import { fail, pass } from '../../verdict.mjs';

export default {
  id: 'http-status',
  checklist: 'Код ответа сервера',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['response'],
  severity: 'P1',

  run(f) {
    if (f.http.error) {
      return fail({
        entity: 'ответ сервера',
        expected: '200 OK',
        actual: `запрос не выполнен: ${f.http.error}`,
        fix: 'Проверить, открывается ли адрес вручную; если страница переехала — поправить url в config/pages.json.',
      });
    }

    if (f.http.redirected) {
      const hop = f.http.chain.find((c) => c.status >= 300 && c.status < 400);
      return fail({
        entity: 'ответ сервера',
        expected: '200 OK без редиректов',
        actual: f.http.chain.map((c) => c.status).join(' → '),
        message: `URL из конфига отдаёт ${hop.status} и ведёт на ${f.http.final?.url}`,
        evidence: f.http.chain.map((c) => `${c.status} ${c.url}`).join(' → '),
        note: 'Чеклист требует 200 без 3xx. Проверки контента дальше идут по конечной странице.',
        // Без адреса в тексте: он есть в таблице, а с ним у каждой страницы получался
        // свой блок с одним и тем же советом.
        fix: 'Указать в config/pages.json адрес, на который ведёт редирект, или убрать редирект на стороне сайта.',
      });
    }

    const status = f.http.final?.status;
    if (status !== 200) {
      return fail({
        entity: 'ответ сервера',
        expected: '200 OK',
        actual: String(status),
        fix: 'Вернуть 200 по этому адресу или убрать страницу из config/pages.json.',
      });
    }
    return pass();
  },
};
