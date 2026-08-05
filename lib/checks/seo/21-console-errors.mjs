import { judge } from '../../verdict.mjs';
import { clip, collapse } from '../../text.mjs';

/** Адрес ресурса без query: иначе одна и та же ошибка каждый прогон выглядит новой. */
function resourceKey(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return clip(url, 80);
  }
}

export default {
  id: 'console-errors',
  checklist: 'Нет ошибок в консоли',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['console'],
  severity: 'P2',

  run(f) {
    const findings = [];
    const seen = new Set();
    const add = (finding) => {
      if (seen.has(finding.entity)) return;
      seen.add(finding.entity);
      findings.push(finding);
    };

    for (const err of f.console.pageErrors ?? []) {
      const first = collapse(String(err.message).split('\n')[0]);
      add({
        entity: clip(first, 90),
        expected: 'нет JS-ошибок',
        actual: 'исключение при загрузке страницы',
        evidence: clip(err.stack ?? err.message, 300),
        fix: 'Починить JS-ошибку: по стектрейсу из подтверждения найти место падения.',
      });
    }

    for (const err of f.console.consoleErrors ?? []) {
      const text = collapse(err.text);
      add({
        entity: clip(text, 90),
        expected: 'нет console.error',
        actual: 'console.error при загрузке',
        evidence: err.location ? `${err.location}` : null,
        severity: 'P3',
        fix: 'Разобрать причину console.error или убрать лишний вывод в консоль.',
      });
    }

    for (const req of f.console.failedRequests ?? []) {
      add({
        entity: resourceKey(req.url),
        expected: 'все запросы страницы успешны',
        actual: `HTTP ${req.status}${req.resourceType ? ` (${req.resourceType})` : ''}`,
        evidence: req.url,
        severity: 'P3',
        fix: 'Поправить адрес ресурса или убрать запрос со страницы — сейчас он отдаёт ошибку.',
      });
    }

    for (const req of f.console.requestFailures ?? []) {
      add({
        entity: resourceKey(req.url),
        expected: 'все запросы страницы выполняются',
        actual: `запрос не выполнен: ${req.error}`,
        evidence: req.url,
        severity: 'P3',
        fix: 'Проверить, не режется ли домен на машине прогона (блокировщик, DNS); если он доступен — починить запрос.',
      });
    }

    return judge(findings, this.severity);
  },
};
