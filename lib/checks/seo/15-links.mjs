import { judge } from '../../verdict.mjs';
import { clip } from '../../text.mjs';
import { REFUSED_STATUSES } from '../../collect/http.mjs';

export default {
  id: 'links',
  checklist: 'Внутренние ссылки',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html', 'links'],
  severity: 'P1',

  // Одна ссылка может нарушать сразу два требования (битая и без nofollow), поэтому
  // вид проблемы входит в entity. Иначе у находок совпадал бы адрес, их различал бы
  // только порядковый номер, и исчезновение одной перебивало бы отпечаток другой —
  // в отчёте это выглядело бы как «устранено» на ровном месте.
  run(f) {
    const findings = [];
    const statuses = f.links.statuses;
    let unchecked = 0;
    const unverifiable = [];

    // Одна и та же ссылка встречается на странице много раз — находка нужна одна.
    const seen = new Set();

    for (const link of f.html.links) {
      if (link.kind !== 'http' || !link.hrefAbs) continue;
      if (seen.has(link.hrefAbs)) continue;
      seen.add(link.hrefAbs);

      const status = statuses[link.hrefAbs];
      if (!status) {
        unchecked++;
      } else if (status.error) {
        findings.push({
          entity: `битая: ${link.hrefAbs}`,
          expected: 'ссылка открывается',
          actual: `запрос не выполнен: ${status.error}`,
          evidence: link.text ? `текст ссылки: «${clip(link.text, 60)}»` : null,
          severity: 'P2',
        });
      } else if (REFUSED_STATUSES.has(status.status)) {
        // Сервер отказался отвечать проверке (защита от ботов, запрет метода). Это не
        // битая ссылка: утверждать, что её нет, по такому ответу нельзя. Такие ссылки
        // собираются в одну находку — это один факт о прогоне, а не сотни проблем.
        unverifiable.push(`HTTP ${status.status} · ${link.hrefAbs}`);
      } else if (status.status >= 400) {
        findings.push({
          entity: `битая: ${link.hrefAbs}`,
          expected: 'ссылка отдаёт 2xx или 3xx',
          actual: `HTTP ${status.status}`,
          evidence: link.text ? `текст ссылки: «${clip(link.text, 60)}»` : null,
        });
      }

      if (link.internal && link.nofollow) {
        findings.push({
          entity: `nofollow внутри: ${link.hrefAbs}`,
          expected: 'внутренняя ссылка без rel="nofollow"',
          actual: `rel="${link.rel.join(' ')}"`,
          severity: 'P2',
          note: 'nofollow на внутренней ссылке не передаёт вес своей же странице.',
        });
      }

      if (link.external && !link.nofollow) {
        findings.push({
          entity: `нет nofollow: ${link.hrefAbs}`,
          expected: 'внешняя ссылка с rel="nofollow"',
          actual: link.rel.length ? `rel="${link.rel.join(' ')}"` : 'атрибута rel нет',
          severity: 'P2',
        });
      }
    }

    if (unverifiable.length) {
      findings.push({
        entity: 'ссылки без ответа на проверку',
        expected: 'сервер отвечает на проверку ссылок',
        actual: `${unverifiable.length} ссылок: сервер отдал защитную заглушку вместо ответа`,
        evidence: unverifiable.slice(0, 5).join('\n'),
        severity: 'P3',
        note: 'Про эти ссылки бот ничего не утверждает: они не признаны ни живыми, ни битыми.',
      });
    }

    if (unchecked > 0) {
      findings.push({
        entity: 'непроверенные ссылки',
        expected: 'проверены все ссылки страницы',
        actual: `${unchecked} не проверено: упёрлись в лимит link_check_limit`,
        severity: 'P3',
      });
    }

    return judge(findings, this.severity);
  },
};
