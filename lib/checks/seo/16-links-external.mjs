import { judge } from '../../verdict.mjs';
import { clip } from '../../text.mjs';
import { REFUSED_STATUSES } from '../../collect/http.mjs';

export default {
  id: 'links-external',
  checklist: 'Внешние ссылки',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html', 'links'],
  // Сломанное здесь живёт на чужой стороне: это стоит починить, но это не наш баг,
  // поэтому важность ниже, чем у внутренних ссылок.
  severity: 'P2',

  run(f) {
    const statuses = f.links.statuses;
    const findings = [];
    const unverifiable = [];
    const seen = new Set();
    let total = 0;
    let probed = 0;
    let unprobed = 0;

    for (const link of f.html.links) {
      if (link.kind !== 'http' || !link.hrefAbs || !link.external) continue;
      if (seen.has(link.hrefAbs)) continue;
      seen.add(link.hrefAbs);
      total++;

      if (!link.nofollow) {
        findings.push({
          entity: `нет nofollow: ${link.hrefAbs}`,
          expected: 'внешняя ссылка с rel="nofollow"',
          actual: link.rel.length ? `rel="${link.rel.join(' ')}"` : 'атрибута rel нет',
          note: 'Ссылка без nofollow отдаёт вес нашей страницы чужому сайту.',
          fix: 'Добавить rel="nofollow" внешним ссылкам; почти все они живут в общем футере — правится в одном шаблоне.',
        });
      }

      const status = statuses[link.hrefAbs];
      if (!status) {
        unprobed++;
        continue;
      }
      probed++;

      if (status.error) {
        findings.push({
          entity: `битая: ${link.hrefAbs}`,
          expected: 'ссылка открывается',
          actual: `запрос не выполнен: ${status.error}`,
          evidence: link.text ? `текст ссылки: «${clip(link.text, 60)}»` : null,
          fix: 'Проверить ссылку в браузере: адреса может уже не существовать — тогда убрать или заменить её.',
        });
      } else if (REFUSED_STATUSES.has(status.status)) {
        unverifiable.push(`HTTP ${status.status} · ${link.hrefAbs}`);
      } else if (status.status >= 400) {
        findings.push({
          entity: `битая: ${link.hrefAbs}`,
          expected: 'ссылка отдаёт 2xx или 3xx',
          actual: `HTTP ${status.status}`,
          evidence: link.text ? `текст ссылки: «${clip(link.text, 60)}»` : null,
          fix: 'Заменить ссылку на рабочий адрес или убрать её — на чужой стороне страница отвечает ошибкой.',
        });
      }
    }

    if (unverifiable.length) {
      findings.push({
        entity: 'внешние ссылки без ответа на проверку',
        expected: 'сервер отвечает на проверку ссылок',
        actual: `${unverifiable.length} ссылок: сайт отказался отвечать проверке`,
        evidence: unverifiable.slice(0, 5).join('\n'),
        severity: 'P3',
        note: 'Обычно это защита от ботов на чужой стороне: проверить руками в браузере.',
        fix: 'Открыть ссылки в браузере; если они живые — это шум, и его место в config/ignores.json.',
      });
    }

    if (unprobed > 0) {
      findings.push({
        entity: 'непроверенные внешние ссылки',
        expected: 'проверены все внешние ссылки страницы',
        actual: `${unprobed} не проверено: упёрлись в лимит link_check_limit`,
        severity: 'P3',
        fix: 'Поднять link_check_limit в config/page-types или сократить число внешних ссылок.',
      });
    }

    const verdict = judge(findings, this.severity);
    verdict.note = `внешних ссылок на странице ${total}, проверено ${probed}`;
    return verdict;
  },
};
