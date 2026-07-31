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
      });
    }

    if (f.http.redirected) {
      const hop = f.http.chain.find((c) => c.status >= 300 && c.status < 400);
      return fail({
        entity: 'ответ сервера',
        expected: '200 OK без редиректов',
        actual: f.http.chain.map((c) => c.status).join(' → '),
        message: `URL из конфига отдаёт ${hop.status} и ведёт на ${f.http.final?.url}`,
        evidence: f.http.chain.map((c) => `${c.status} ${c.url}`).join('\n→ '),
        note: 'Чеклист требует 200 без 3xx. Проверки контента дальше идут по конечной странице.',
      });
    }

    const status = f.http.final?.status;
    if (status !== 200) {
      return fail({ entity: 'ответ сервера', expected: '200 OK', actual: String(status) });
    }
    return pass();
  },
};
