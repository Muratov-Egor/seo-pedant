import { judge } from '../../verdict.mjs';
import { clip } from '../../text.mjs';
import { REFUSED_STATUSES } from '../../collect/http.mjs';

export default {
  id: 'links-internal',
  checklist: 'Внутренние ссылки',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html', 'links'],
  // Битая ссылка на наш же домен — наш баг, поэтому P1. Внешние ссылки проверяет
  // links-external с меньшей важностью: там сломано на чужой стороне.
  severity: 'P1',

  // Вид проблемы входит в entity: одна ссылка может быть и битой, и с nofollow.
  // Если бы адресом находки был просто URL, исчезновение одной проблемы перебивало бы
  // отпечаток другой, и в отчёте это выглядело бы как «устранено» на ровном месте.
  run(f) {
    const statuses = f.links.statuses;
    const development = f.links.scope?.development;
    const limit = development?.enabled ? development.internal_links_per_page : null;

    const findings = [];
    const unverifiable = [];
    const seen = new Set();
    let total = 0;
    let probed = 0;
    let unprobed = 0;

    for (const link of f.html.links) {
      if (link.kind !== 'http' || !link.hrefAbs || !link.internal) continue;
      if (seen.has(link.hrefAbs)) continue;
      seen.add(link.hrefAbs);
      total++;

      // rel виден прямо в разметке — сеть для этой находки не нужна, поэтому лимит
      // на проверку доступности её не касается: nofollow проверяется у всех ссылок.
      if (link.nofollow) {
        findings.push({
          entity: `nofollow внутри: ${link.hrefAbs}`,
          block: link.block,
          expected: 'внутренняя ссылка без rel="nofollow"',
          actual: `rel="${link.rel.join(' ')}"`,
          severity: 'P2',
          note: 'nofollow на внутренней ссылке не передаёт вес своей же странице.',
          fix: 'Убрать rel="nofollow" у внутренних ссылок.',
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
          block: link.block,
          expected: 'ссылка открывается',
          actual: `запрос не выполнен: ${status.error}`,
          evidence: link.text ? `текст ссылки: «${clip(link.text, 60)}»` : null,
          severity: 'P2',
          fix: 'Проверить адрес ссылки: запрос до него не доходит.',
        });
      } else if (REFUSED_STATUSES.has(status.status)) {
        unverifiable.push(`HTTP ${status.status} · ${link.hrefAbs}`);
      } else if (status.status >= 400) {
        findings.push({
          entity: `битая: ${link.hrefAbs}`,
          block: link.block,
          expected: 'ссылка отдаёт 2xx или 3xx',
          actual: `HTTP ${status.status}`,
          evidence: link.text ? `текст ссылки: «${clip(link.text, 60)}»` : null,
          fix: 'Поправить адрес ссылки или вернуть страницу по нему; если ссылки много раз одна и та же — искать общий шаблон блока.',
        });
      }
    }

    if (unverifiable.length) {
      findings.push({
        entity: 'внутренние ссылки без ответа на проверку',
        expected: 'сервер отвечает на проверку ссылок',
        actual: `${unverifiable.length} ссылок: сервер отдал защитную заглушку вместо ответа`,
        evidence: unverifiable.slice(0, 5).join('\n'),
        severity: 'P3',
        note: 'Про эти ссылки бот ничего не утверждает: они не признаны ни живыми, ни битыми.',
        fix: 'Открыть эти ссылки руками в браузере; если они живые — это шум, и его место в config/ignores.json.',
      });
    }

    // Пока стоит лимит разработки, непроверенные ссылки ожидаемы и находкой быть не
    // должны — об этом один раз напоминает отчёт. А вот упереться в жёсткий
    // link_check_limit это уже неожиданность, и о ней надо сказать явно.
    if (unprobed > 0 && limit == null) {
      findings.push({
        entity: 'непроверенные внутренние ссылки',
        expected: 'проверены все внутренние ссылки страницы',
        actual: `${unprobed} не проверено: упёрлись в лимит link_check_limit`,
        severity: 'P3',
        fix: 'Поднять link_check_limit в config/page-types или сократить число ссылок на странице.',
      });
    }

    const verdict = judge(findings, this.severity);
    // Проверенных может оказаться больше лимита: ссылки, общие для нескольких страниц,
    // проверяются один раз на весь прогон и достаются каждой странице бесплатно.
    // Без этой оговорки строка «проверено 11 при лимите 10» читается как ошибка.
    const shared = limit != null && probed > limit ? ', общие для страниц ссылки проверяются один раз на прогон' : '';
    verdict.note =
      limit == null
        ? `внутренних ссылок на странице ${total}, проверено ${probed}`
        : `внутренних ссылок на странице ${total}, проверено ${probed} — лимит ${limit} на страницу на время разработки${shared}`;
    // Пока лимит стоит, «пройдено» значит «пройдено на проверенной части». Без этой
    // отметки матрица показала бы ✅ при сотнях непроверенных ссылок.
    verdict.partial = limit != null && probed < total;
    return verdict;
  },
};
