#!/usr/bin/env node
// Сборка отчётов из run.json. В сеть не ходит, ничего не отправляет.
//
//   node lib/report.mjs [--run <runId>]
//
// Пишет два файла:
//   reports/<runId>.md         — полный отчёт: матрица по чеклисту и все находки
//   reports/<runId>.slack.txt  — короткий текст для Slack со ссылкой на полный
//
// Отправку делает агент (см. prompts/manual-run.md): ссылка на полный отчёт становится
// валидной только после git push, поэтому её нельзя отправлять раньше коммита.

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORTS_DIR, HISTORY_FILE, configForType, delivery } from './config.mjs';
import { latestRunId, readRun } from './bundle.mjs';
import { ALL_CHECKS, checkById, checklistItems } from './checks/index.mjs';
import { clip, collapse } from './text.mjs';

const SEVERITY_LABEL = { P1: 'P1 критично', P2: 'P2 важно', P3: 'P3 замечание' };

function worstStatus(statuses) {
  for (const wanted of ['fail', 'warn']) if (statuses.includes(wanted)) return wanted;
  if (statuses.includes('pass')) return 'pass';
  if (statuses.includes('skip')) return 'skip';
  return statuses[0] ?? 'na';
}

/**
 * Идентификатор заголовка так, как его строит GitHub: нижний регистр, пунктуация
 * выброшена, пробелы — в дефисы. Нужен, чтобы из таблицы можно было прыгнуть к разделу
 * с находками: свои `<a id>` GitHub переименовывает под себя, а ссылки на заголовки
 * работают всегда. Тире внутри названия выбрасывается вместе с пунктуацией, поэтому на
 * его месте остаётся двойной дефис — так же, как у самого GitHub.
 */
export function headingAnchor(text) {
  return (
    String(text)
      .toLowerCase()
      .trim()
      // Оставляем буквы, цифры, знаки, пробелы, дефис и подчёркивание — всё остальное
      // GitHub выбрасывает. Перечислять выбрасываемое по одному нельзя: так уже терялась
      // точка-разделитель «·», и ссылка вела в никуда.
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-')
  );
}

function escapeCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Один пункт чеклиста может проверяться несколькими проверками (например «контент
// уникален» — это и заглушки, и дубли между страницами, и внешний антиплагиат).
// В таких случаях к названию пункта добавляется id проверки, иначе строка
// «не проверялось: Контент уникален» врала бы про две другие проверки этого пункта.
const SHARED_CHECKS = new Set(
  checklistItems()
    .filter((i) => i.checks.length > 1)
    .flatMap((i) => i.checks),
);

function checkLabel(checkId) {
  const check = checkById(checkId);
  if (!check) return checkId;
  return SHARED_CHECKS.has(checkId) ? `${check.checklist} (${checkId})` : check.checklist;
}

/** Находки, сгруппированные по (пункт чеклиста → проверка → страница). */
function groupFindings(findings) {
  const byCheck = new Map();
  for (const f of findings) {
    if (!byCheck.has(f.check_id)) byCheck.set(f.check_id, []);
    byCheck.get(f.check_id).push(f);
  }
  return byCheck;
}

function ageMark(f) {
  return f.status === 'new' ? '🆕 новая' : `↻ ${f.days_seen} д.`;
}

/**
 * Цитата со страницы. Идёт в inline-коде или в блоке кода, а не в blockquote:
 * подтверждением обычно служит кусок разметки, и рендерер markdown съедал бы его
 * как HTML — в отчёте оставался бы пустой «подтверждение со страницы:».
 */
function evidenceLines(evidence, label = 'Подтверждение со страницы') {
  const raw = String(evidence).split('\n').filter((l) => l.trim());
  if (raw.length === 1) return [`**${label}:** \`${clip(raw[0], 300)}\``];
  return [`**${label}:**`, '', '```', ...raw.slice(0, 8).map((l) => clip(l, 300)), '```'];
}

/**
 * Общее начало адресов группы вида «нет nofollow: <url>». Вид проблемы уже назван
 * в заголовке группы, поэтому в строках он только мешает.
 */
export function commonEntityPrefix(group) {
  const match = /^([^:]{1,40}: )/.exec(String(group[0].entity ?? ''));
  if (!match) return '';
  return group.every((f) => String(f.entity).startsWith(match[1])) ? match[1] : '';
}

/**
 * Слаг ссылкой на саму страницу: из отчёта нужно уметь открыть то, что сломано,
 * а не искать адрес по слагу в конфиге. Ведём на итоговый URL — проверки смотрели его.
 */
function slugLink(slug, urlBySlug) {
  const url = urlBySlug?.get(slug);
  return url ? `[\`${slug}\`](${url})` : `\`${slug}\``;
}

/**
 * Находки группы таблицей: страница, что именно не так, фактическое значение,
 * цитата со страницы, давность. Список с подпунктами читался хуже — глаз не находил,
 * где кончается одна находка и начинается следующая.
 *
 * Пустые колонки не рисуются: у части проверок нет ни «что», ни цитаты, и колонка из
 * одних прочерков только мешает. Важность у группы одна и стоит в заголовке.
 */
function occurrenceTable(group, prefix = '', urlBySlug = null, { evidence = true } = {}) {
  const entityOf = (f) => String(f.entity ?? '').slice(prefix.length).trim();
  const evidenceOf = (f) => {
    if (!evidence || !f.evidence) return '';
    const lines = String(f.evidence).split('\n').filter((l) => l.trim());
    const more = lines.length > 1 ? ` … и ещё ${lines.length - 1}` : '';
    return `\`${clip(lines[0], 160)}\`${more}`;
  };

  // Заголовки называют то, что в клетке правда лежит: «что» и «фактически» вместе
  // читались как «длина 79» — а 79 чего, из такой пары не следует.
  const columns = [
    { head: 'страница', value: (f) => escapeCell(urlBySlug?.get(f.slug) ?? f.slug) },
    { head: 'что проверяли', value: (f) => escapeCell(clip(entityOf(f), 120)) },
    { head: 'сейчас', value: (f) => escapeCell(clip(f.actual ?? '', 100)) },
    { head: 'фрагмент со страницы', value: (f) => escapeCell(evidenceOf(f)) },
    { head: 'давность', value: (f) => ageMark(f) },
  ].filter((col) => group.some((f) => col.value(f) && col.value(f) !== '—'));

  return [
    `| ${columns.map((c) => c.head).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...group.map((f) => `| ${columns.map((c) => c.value(f) || '—').join(' | ')} |`),
  ];
}

/**
 * Находки одной проверки, сгруппированные по виду проблемы: одинаковые «ожидалось»
 * и пояснение печатаются один раз на группу, а сами находки — по строке на каждую.
 */
export function findingGroups(list) {
  const groups = new Map();
  for (const f of list) {
    // fix входит в ключ: если у находок разные способы исправления, это разные виды
    // проблемы, и «одно общее решение на группу» иначе было бы решением от первой находки.
    const key = `${f.severity}::${f.expected ?? ''}::${f.note ?? ''}::${f.fix ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return [...groups.values()];
}

function markdown(run) {
  const { totals } = run;
  const out = [];
  const pages = run.pages;
  const label = (p) => p.label ?? p.slug;
  const urlBySlug = new Map(pages.map((p) => [p.slug, p.final_url ?? p.url]).filter(([, u]) => u));
  const linked = (slug) => slugLink(slug, urlBySlug);

  out.push(`# SEO Pedant — прогон ${run.runId}`);
  out.push('');
  out.push(
    `Страниц: ${totals.pages} · проверок на страницу: ${ALL_CHECKS.length} · собрано ${run.generated_at}.`,
  );
  out.push('');
  out.push(
    `**Находки: ${totals.findings}** — P1 ${totals.P1}, P2 ${totals.P2}, P3 ${totals.P3}. ` +
      `Новых ${totals.new}, повторяются ${totals.repeat}, устранено ${totals.resolved}.`,
  );
  if (run.previous_run) {
    const delta = totals.findings - run.previous_findings_count;
    out.push('');
    out.push(
      `Прошлый прогон ${run.previous_run}: находок ${run.previous_findings_count} ` +
        `(${delta === 0 ? 'без изменений' : delta > 0 ? `+${delta}` : delta}).`,
    );
  }
  if (totals.suppressed) {
    out.push('');
    out.push(`Заглушено игнорами из \`config/ignores.json\`: ${totals.suppressed}.`);
  }

  // Предупреждение стоит выше всех находок: без него отчёт по заблокированному прогону
  // читается как «на страницах всё сломалось, зато вчерашние проблемы ушли».
  if (totals.blocked_pages) {
    out.push('');
    out.push(
      `> ⚠️ **Прогон неполный.** ${totals.blocked_pages} из ${totals.pages} страниц отдали заглушку ` +
        'защиты от ботов вместо содержимого. По этим страницам отчёт не утверждает ни нарушений, ' +
        'ни того, что прошлые проблемы устранены.',
    );
    out.push('>');
    for (const b of run.blocked ?? []) out.push(`> - ${linked(b.slug)} — ${b.reason}`);
  }

  // Пока лимит стоит, отчёт обязан о нём напоминать: иначе «внутренние ссылки: ✅»
  // читается как «все ссылки целы», хотя проверены были первые несколько.
  if (run.scope?.development?.enabled) {
    const limit = run.scope.development.internal_links_per_page;
    out.push('');
    out.push('## ⏳ Действует ограничение на время разработки');
    out.push('');
    out.push(
      `Внутренние ссылки проверяются не все, а первые **${limit} на страницу** — чтобы отчёты ` +
        'не спамили сотнями однотипных находок. Внешние ссылки проверяются полностью.',
    );
    out.push('');
    out.push('Снять ограничение: `development.enabled: false` в `config/scope.json`.');

    // Постранично — под раскрытием: это сноска к лимиту, а не то, с чего начинают
    // читать отчёт, и на сотне страниц она отодвинула бы находки на второй экран.
    const perPage = [];
    for (const p of pages) {
      const note = p.verdicts.find((v) => v.check_id === 'links-internal')?.note;
      if (note) perPage.push(`- **${label(p)}** — ${note}`);
    }
    if (perPage.length) {
      out.push('');
      out.push(`<details><summary>Сколько ссылок проверено на каждой странице (${perPage.length})</summary>`);
      out.push('');
      out.push(...perPage);
      out.push('');
      out.push('</details>');
    }
  }

  // Считаем находки до таблицы: по ним она узнаёт, у какого пункта есть раздел ниже,
  // и ставит на название ссылку-переход именно к нему.
  const byCheck = groupFindings(run.findings);
  const sectionAnchor = new Map();
  for (const item of checklistItems()) {
    const found = item.checks.flatMap((id) => byCheck.get(id) ?? []);
    if (!found.length) continue;
    const severities = [...new Set(found.map((f) => f.severity))].sort();
    sectionAnchor.set(
      item.checklist,
      headingAnchor(`${severities.join(', ')} · ${item.checklist} — ${found.length}`),
    );
  }

  // ── сводка по пунктам ──────────────────────────────────────────────────────
  //
  // Таблица считает страницы, а не перечисляет их колонками: колонка на страницу
  // читалась на восьми страницах и перестаёт читаться на сотне. Какие именно
  // страницы задеты — в разделах с находками ниже.
  out.push('');
  out.push('## Чеклист: сколько страниц по каждому пункту');
  out.push('');
  out.push('Числа — это страницы, кроме последней колонки: там находки.');
  out.push('');
  out.push(
    '| Пункт чеклиста | ✅ соответствует | ❌ нарушение | ⚠️ замечание | ' +
      '⏭ не проверено | — невозможно | находок |',
  );
  out.push('| --- | --- | --- | --- | --- | --- | --- |');

  let hasPartial = false;
  for (const item of checklistItems()) {
    const tally = { pass: 0, fail: 0, warn: 0, skip: 0, na: 0 };
    let findings = 0;
    let itemPartial = false;

    for (const page of pages) {
      const verdicts = item.checks.map((id) => page.verdicts.find((v) => v.check_id === id)).filter(Boolean);
      if (!verdicts.length) continue;
      const statuses = verdicts.map((v) => v.status);
      const status = worstStatus(statuses);
      if (status in tally) tally[status]++;
      findings += verdicts.reduce((n, v) => n + (v.findings?.length ?? 0), 0);

      // Пункт, у которого часть подпроверок невозможна или проверена не целиком,
      // не должен выглядеть полностью проверенным: иначе ✅ обещает больше, чем бот
      // действительно посмотрел.
      if ((statuses.length > 1 && statuses.includes('na')) || verdicts.some((v) => v.partial)) {
        itemPartial = true;
        hasPartial = true;
      }
    }

    const cell = (n) => (n ? String(n) : '—');
    const anchor = sectionAnchor.get(item.checklist);
    const name = escapeCell(item.checklist);
    // Ссылку ставим только там, где есть куда прыгать: у пункта без находок раздела нет.
    const title = anchor ? `[${name}](#${anchor})` : name;
    out.push(
      `| ${title}${itemPartial ? '*' : ''} | ${cell(tally.pass)} | ${cell(tally.fail)} | ` +
        `${cell(tally.warn)} | ${cell(tally.skip)} | ${cell(tally.na)} | ${cell(findings)} |`,
    );
  }

  if (hasPartial) {
    out.push('');
    out.push(
      '`*` пункт проверен частично хотя бы на одной странице: часть его проверок невозможна ' +
        'или действует лимит — см. разделы ниже и «Не проверено».',
    );
  }

  // Какие страницы тянут отчёт вниз — списком, а не колонками: на сотне страниц
  // нужен верх списка, а не вся простыня.
  const byFindings = pages
    .map((p) => ({
      page: p,
      count: p.verdicts.reduce((n, v) => n + (v.findings?.length ?? 0), 0),
    }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);

  if (byFindings.length) {
    out.push('');
    out.push('**Больше всего находок:**');
    out.push('');
    for (const { page, count } of byFindings.slice(0, 10)) {
      out.push(`- **${label(page)}** — ${count} · ${linked(page.slug)}`);
    }
    if (byFindings.length > 10) {
      out.push(`- …и ещё ${byFindings.length - 10} стр. с находками`);
    }
  }

  out.push('');
  out.push('<details><summary>Все страницы прогона</summary>');
  out.push('');
  for (const p of pages) {
    const redirect = p.final_url && p.final_url !== p.url ? ` → ${p.final_url}` : '';
    const blocked = p.blocked ? ', **не проверялась: заглушка защиты от ботов**' : '';
    out.push(
      `- **${label(p)}** — ${p.url}${redirect} (HTTP ${p.http_status ?? '—'}, тип \`${p.type}\`${p.type_fallback ? ', настроек типа нет' : ''}${blocked})`,
    );
  }
  out.push('');
  out.push('</details>');

  // ── изменения ──────────────────────────────────────────────────────────────
  const fresh = run.findings.filter((f) => f.status === 'new');
  out.push('');
  out.push(`## Новые проблемы — ${fresh.length}`);
  out.push('');
  if (!fresh.length) {
    out.push('Новых проблем нет.');
  } else {
    const byCheck = groupFindings(fresh);
    for (const [checkId, list] of byCheck) {
      const check = checkById(checkId);
      const where = [...new Set(list.map((f) => f.slug))].map(linked).join(', ');
      out.push(`- **${check?.checklist ?? checkId}** (\`${checkId}\`): ${list.length} — страницы: ${where}`);
    }
  }

  out.push('');
  out.push(`## Устранено с прошлого прогона — ${run.resolved.length}`);
  out.push('');
  if (!run.resolved.length) {
    out.push('Нет.');
  } else {
    for (const r of run.resolved) {
      out.push(`- ✅ ${linked(r.slug)} · ${r.checklist ?? r.check_id} — было: ${r.message} (\`${r.fingerprint}\`)`);
    }
  }

  if (run.unchecked_now.length) {
    out.push('');
    out.push(`## Перестало проверяться — ${run.unchecked_now.length}`);
    out.push('');
    out.push('Эти проблемы не устранены: в этом прогоне их просто некому было найти.');
    out.push('');
    for (const r of run.unchecked_now) {
      out.push(`- ⏭ ${linked(r.slug)} · ${r.checklist ?? r.check_id} — ${r.reason}. Было: ${r.message}`);
    }
  }

  // ── все находки ────────────────────────────────────────────────────────────
  out.push('');
  out.push('## Находки по пунктам чеклиста');

  const foldAbove = configForType('').thresholds.report_collapse_threshold ?? 12;

  // Линия перед каждым пунктом, кроме первого: блоки находок идут подряд и без неё
  // сливаются в одну простыню. Пустая строка перед `---` обязательна — иначе markdown
  // превратит её в подчёркивание предыдущей строки, а не в разделитель.
  let firstItem = true;
  for (const item of checklistItems()) {
    const itemFindings = item.checks.flatMap((id) => byCheck.get(id) ?? []);
    if (!itemFindings.length) continue;

    out.push('');
    if (!firstItem) {
      out.push('---');
      out.push('');
    }
    firstItem = false;
    // Важность — в заголовке: она одна на пункт в подавляющем большинстве случаев,
    // и повторять её в каждой строке ниже незачем. Если у пункта находки разной
    // важности, перечисляем все — иначе заголовок обещал бы не то, что внутри.
    const severities = [...new Set(itemFindings.map((f) => f.severity))].sort();
    out.push(`### ${severities.join(', ')} · ${item.checklist} — ${itemFindings.length}`);

    const checksWithFindings = item.checks.filter((id) => (byCheck.get(id) ?? []).length);
    for (const checkId of item.checks) {
      const list = byCheck.get(checkId) ?? [];
      if (!list.length) continue;

      if (checksWithFindings.length > 1) {
        out.push('');
        out.push(`#### ${checkLabel(checkId)}`);
      }

      // Один вид проблемы — один заголовок с «ожидалось» и пояснением, и дальше
      // по строке на находку. Раньше и то, и другое дублировалось на каждой из
      // десятков находок, и отчёт читался как копипаста.
      for (const group of findingGroups(list)) {
        const first = group[0];
        const affected = new Set(group.map((f) => f.slug)).size;
        const fresh = group.filter((f) => f.status === 'new').length;

        // Важность здесь не повторяем — она в заголовке пункта. Исключение: у пункта
        // находки разной важности, и тогда без неё непонятно, к чему относится группа.
        const mixed = severities.length > 1;
        out.push('');
        out.push(
          `**Кол-во проблем: ${group.length}**${mixed ? ` · ${first.severity}` : ''} — ` +
            `на ${affected} стр.${fresh && fresh < group.length ? `, из них новых ${fresh}` : ''}`,
        );

        // «Ожидалось», пояснение и решение — одна плашка на группу: у пяти страниц с
        // одной и той же причиной они общие и читаются вместе — что требуется, почему
        // это проблема, что делать. Рамку и иконку рисует alert-блок GitHub: своей
        // заливкой этого не сделать, CSS из markdown он вырезает.
        const context = [
          first.expected ? `Ожидалось: ${first.expected}.` : '',
          first.note ?? '',
        ]
          .filter(Boolean)
          .join(' ');

        if (first.fix) {
          out.push('');
          out.push('> [!WARNING]');
          if (context) {
            out.push(`> ℹ️ _${context}_`);
            out.push('>');
          }
          out.push(`> **Как исправить:** ${first.fix}`);
        } else if (context) {
          // Без решения плашке нечего предлагать — остаётся просто контекст.
          out.push('');
          out.push(`ℹ️ _${context}_`);
        }

        // Если подтверждения в группе повторяются, они уходят на уровень группы:
        // десять раз показать одну и ту же строку разметки — это шум, а не довод.
        // Если у каждой находки своё подтверждение, оно остаётся при ней.
        const evidences = group.map((f) => f.evidence).filter(Boolean);
        const distinct = [...new Set(evidences)];
        const evidenceAtGroupLevel = evidences.length > 0 && distinct.length < evidences.length;

        if (evidenceAtGroupLevel) {
          const label = distinct.length === 1 ? 'Подтверждение со страницы' : 'Со страниц';
          for (const value of distinct.slice(0, 3)) {
            out.push('');
            out.push(...evidenceLines(value, label));
          }
          if (distinct.length > 3) {
            out.push('');
            out.push(`_…и ещё ${distinct.length - 3} варианта — в data/runs/${run.runId}/run.json_`);
          }
        }

        const prefix = commonEntityPrefix(group);

        const rows = occurrenceTable(group, prefix, urlBySlug, { evidence: !evidenceAtGroupLevel });

        out.push('');
        // Большая группа складывается: сотню однотипных строк никто не читает, но и
        // терять их нельзя — они под раскрытием.
        if (group.length > foldAbove) {
          out.push('<details><summary>показать все</summary>');
          out.push('');
          out.push(...rows);
          out.push('');
          out.push('</details>');
        } else {
          out.push(...rows);
        }
      }
    }
  }

  // ── что не проверялось ─────────────────────────────────────────────────────
  const notChecked = [];
  for (const page of pages) {
    for (const v of page.verdicts) {
      if (v.status !== 'skip' && v.status !== 'na') continue;
      // Причина может приехать многострочной (лог Playwright) — в списке она обязана
      // остаться одной строкой, иначе ломается разметка.
      notChecked.push({ slug: page.slug, label: checkLabel(v.check_id), reason: clip(collapse(v.reason), 200) });
    }
  }
  if (notChecked.length) {
    out.push('');
    out.push('## Не проверено');
    out.push('');
    // Строка на проверку, а не на причину: одна и та же проверка, отключённая в четырёх
    // файлах типов, — это одна непроверенная проверка, а не четыре. Причины уходят
    // подпунктами, и только когда их правда несколько.
    const byCheck = new Map();
    for (const n of notChecked) {
      if (!byCheck.has(n.label)) byCheck.set(n.label, { pages: 0, reasons: new Map() });
      const entry = byCheck.get(n.label);
      entry.pages++;
      entry.reasons.set(n.reason, (entry.reasons.get(n.reason) ?? 0) + 1);
    }
    for (const [checkName, entry] of byCheck) {
      if (entry.reasons.size === 1) {
        const [reason] = entry.reasons.keys();
        out.push(`- ${checkName} — ${reason} (${entry.pages} стр.)`);
        continue;
      }
      out.push(`- ${checkName} — ${entry.pages} стр., причины разные:`);
      for (const [reason, n] of entry.reasons) out.push(`  - ${reason} (${n} стр.)`);
    }
  }

  if (run.suppressed?.length) {
    out.push('');
    out.push('## Заглушено игнорами');
    out.push('');
    for (const s of run.suppressed) {
      out.push(`- ${linked(s.slug)} · \`${s.check_id}\` · ${s.entity} — ${s.ignored_because}`);
    }
  }

  out.push('');
  return `${out.join('\n')}\n`;
}

function slackText(run) {
  const { totals } = run;
  const cfg = delivery();
  const out = [];

  out.push(`*SEO Pedant · прогон ${run.runId}*`);
  out.push(
    `${totals.pages} стр. · находок ${totals.findings} (P1 ${totals.P1} · P2 ${totals.P2} · P3 ${totals.P3})`,
  );
  const dynamics = run.previous_run
    ? ` · прошлый прогон ${run.previous_run}: ${run.previous_findings_count}`
    : ' · это первый прогон';
  out.push(
    `:new: новых ${totals.new} · :white_check_mark: устранено ${totals.resolved}${dynamics}`,
  );

  if (totals.blocked_pages) {
    out.push('');
    out.push(
      `⚠️ *Прогон неполный:* ${totals.blocked_pages} из ${totals.pages} стр. отдали заглушку защиты от ботов. ` +
        'По ним отчёт ничего не утверждает — ни нарушений, ни устранений.',
    );
  }

  if (run.scope?.development?.enabled) {
    out.push('');
    out.push(
      `:hourglass_flowing_sand: _На время разработки внутренние ссылки проверяются частично: первые ` +
        `${run.scope.development.internal_links_per_page} на страницу. Внешние — все. ` +
        'Снять: development.enabled в config/scope.json._',
    );
  }

  // Агрегация по проверке: 282 однотипных находки одной строкой, а не 282 строками.
  const groups = new Map();
  for (const f of run.findings) {
    const key = `${f.severity}::${f.check_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        severity: f.severity,
        check_id: f.check_id,
        checklist: f.checklist,
        count: 0,
        slugs: new Set(),
        fresh: 0,
      });
    }
    const g = groups.get(key);
    g.count++;
    g.slugs.add(f.slug);
    if (f.status === 'new') g.fresh++;
  }

  const sorted = [...groups.values()].sort(
    (a, b) => a.severity.localeCompare(b.severity) || b.count - a.count,
  );
  const important = sorted.filter((g) => g.severity !== 'P3');
  const minor = sorted.filter((g) => g.severity === 'P3');

  if (important.length) {
    out.push('');
    out.push('*Требует решения*');
    for (const g of important.slice(0, 12)) {
      // Слаги перечисляем, пока их мало: на сотне страниц список сам стал бы простынёй.
      const where =
        g.slugs.size === totals.pages
          ? 'все страницы'
          : g.slugs.size > 4
            ? `${g.slugs.size} стр.`
            : [...g.slugs].join(', ');
      // Шорткоды, а не символы: Slack рисует :repeat: и :new: значками, а сырые ↻ и 🆕
      // приезжают бледной закорючкой рядом с текстом.
      const mark = g.fresh === g.count ? ':new:' : g.fresh ? `:new:${g.fresh}` : ':repeat:';
      // Только счёт и страницы: примеры и советы «как исправить» живут в полном отчёте,
      // короткое сообщение отвечает на «сколько и где», а не «что именно делать».
      out.push(`• ${mark} ${g.severity} ${g.checklist}: ${g.count} — ${where}`);
    }
    if (important.length > 12) out.push(`• …и ещё ${important.length - 12} групп(ы) в полном отчёте`);
  }

  if (minor.length) {
    out.push('');
    out.push('*Не требует решения сейчас*');
    for (const g of minor) {
      out.push(`• P3 ${g.checklist}: ${g.count} (${g.slugs.size} стр.)`);
    }
  }

  if (run.resolved.length) {
    out.push('');
    out.push('*Устранено*');
    for (const r of run.resolved.slice(0, 8)) {
      out.push(`• :white_check_mark: ${r.slug}: ${clip(r.message, 120)}`);
    }
  }

  const notChecked = new Set();
  for (const page of run.pages) {
    for (const v of page.verdicts) {
      if (v.status === 'skip' || v.status === 'na') notChecked.add(checkLabel(v.check_id));
    }
  }
  if (notChecked.size) {
    out.push('');
    out.push(`_Не проверялось: ${[...notChecked].join('; ')}_`);
  }

  // Ссылка на интерактивный HTML-отчёт на GitHub Pages, если задан pages_url;
  // иначе — на markdown в репозитории (валиден только после git push).
  const reportUrl = cfg.pages_url
    ? `${cfg.pages_url}/reports/${run.runId}.html`
    : `${cfg.repo}/blob/${cfg.branch}/reports/${run.runId}.md`;

  out.push('');
  out.push(`Отчёт: ${reportUrl}`);

  let text = out.join('\n');
  const max = cfg.slack_max_chars ?? 3500;
  if (text.length > max) {
    const tail = `\n…\nОтчёт: ${reportUrl}`;
    text = text.slice(0, max - tail.length) + tail;
  }
  return `${text}\n`;
}

/**
 * Сводка для модели: всё, что нужно для интерпретации прогона и сообщения в Slack,
 * без чтения полного отчёта.
 *
 * Растёт по числу пунктов чеклиста, а не по числу страниц: на сотне страниц она такого
 * же размера, как на десяти. Полный `.md` — для людей, и открывать его модели не нужно:
 * 400 КБ отчёта на сотне страниц — это больше сотни тысяч токенов за прогон.
 */
export function briefText(run) {
  const t = run.totals;
  const out = [];
  const prev = run.previous_run
    ? `прошлый ${run.previous_run} (было ${run.previous_findings_count})`
    : 'это первый прогон';

  out.push(`Прогон ${run.runId} · ${t.pages} стр. · ${prev}`);
  out.push(
    `Находок ${t.findings}: P1 ${t.P1} · P2 ${t.P2} · P3 ${t.P3} | новых ${t.new} · ` +
      `устранено ${t.resolved} · перестало проверяться ${t.unchecked_now} · заглушено ${t.suppressed}`,
  );

  if (t.blocked_pages) {
    out.push(
      `ВНИМАНИЕ: ${t.blocked_pages} из ${t.pages} стр. отдали заглушку защиты от ботов — ` +
        'прогон неполный, про эти страницы утверждать нельзя ничего.',
    );
  }
  if (run.scope?.development?.enabled) {
    out.push(
      `ВНИМАНИЕ: режим разработки — внутренние ссылки проверены не все, ` +
        `а первые ${run.scope.development.internal_links_per_page} на страницу.`,
    );
  }

  // Группировка по виду проблемы, а не по странице: одна причина на сорока страницах —
  // это одна проблема с одним решением, и в сводке она обязана быть одной записью.
  const groups = new Map();
  for (const f of run.findings) {
    const key = `${f.severity}::${f.check_id}::${f.fix ?? ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        severity: f.severity,
        checklist: f.checklist,
        fix: f.fix ?? null,
        count: 0,
        fresh: 0,
        slugs: new Set(),
        example: f,
      });
    }
    const g = groups.get(key);
    g.count++;
    g.slugs.add(f.slug);
    if (f.status === 'new') g.fresh++;
  }

  if (groups.size) {
    out.push('');
    out.push('По видам проблемы (важность · пункт · находок · страниц):');
    const sorted = [...groups.values()].sort(
      (a, b) => a.severity.localeCompare(b.severity) || b.count - a.count,
    );
    for (const g of sorted) {
      const where =
        g.slugs.size === t.pages
          ? 'все страницы'
          : g.slugs.size > 4
            ? `${g.slugs.size} стр.`
            : [...g.slugs].join(', ');
      out.push(
        `- ${g.severity} ${g.checklist}: ${g.count}${g.fresh ? ` (новых ${g.fresh})` : ''} — ${where}`,
      );
      if (g.example?.message) out.push(`    пример: ${clip(collapse(g.example.message), 160)}`);
      if (g.fix) out.push(`    решение: ${clip(collapse(g.fix), 160)}`);
    }
  }

  if (run.resolved?.length) {
    out.push('');
    out.push(`Устранено с прошлого прогона (${run.resolved.length}):`);
    for (const r of run.resolved.slice(0, 10)) {
      out.push(`- ${r.slug}: ${clip(collapse(r.message), 140)}`);
    }
    if (run.resolved.length > 10) out.push(`- …и ещё ${run.resolved.length - 10}`);
  }

  // Раздел «перестало проверяться» — не устранённые проблемы: проверка просто не шла.
  // Путать их в Slack нельзя, поэтому в сводке они идут отдельной строкой.
  if (run.unchecked_now?.length) {
    out.push('');
    out.push(`Перестало проверяться (${run.unchecked_now.length}) — это НЕ устранено:`);
    for (const u of run.unchecked_now.slice(0, 10)) {
      out.push(`- ${u.slug}: ${clip(collapse(u.message ?? u.checklist ?? ''), 140)}`);
    }
    if (run.unchecked_now.length > 10) out.push(`- …и ещё ${run.unchecked_now.length - 10}`);
  }

  const byReason = new Map();
  for (const page of run.pages) {
    for (const v of page.verdicts) {
      if (v.status !== 'skip' && v.status !== 'na') continue;
      const key = `${checkLabel(v.check_id)} — ${clip(collapse(v.reason), 120)}`;
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
  }
  if (byReason.size) {
    out.push('');
    out.push('Не проверялось:');
    for (const [key, n] of byReason) out.push(`- ${key} (${n} стр.)`);
  }

  out.push('');
  out.push(
    `Полный отчёт для людей: reports/${run.runId}.md — модели читать его не нужно, ` +
      'всё существенное перечислено выше.',
  );
  return `${out.join('\n')}\n`;
}

// ── интерактивный HTML-отчёт ─────────────────────────────────────────────────
//
// Самодостаточный файл: весь CSS/JS инлайн, данные прогона встроены как JSON.
// Открывается двойным кликом и через GitHub Pages, в сеть не ходит. Данные строятся
// напрямую из объекта `run` теми же хелперами, что и markdown() — без парсинга .md.

/** Экранирование для текста внутри HTML (значения приезжают со страниц сайта). */
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Находки группы в виде {head, rows} — тот же набор колонок, что у occurrenceTable(),
 * но массивами для встраивания в JSON, а не markdown-строкой. Значения уже экранированы.
 */
function occurrenceData(group, prefix = '', urlBySlug = null, { evidence = true } = {}) {
  const entityOf = (f) => String(f.entity ?? '').slice(prefix.length).trim();
  const evidenceOf = (f) => {
    if (!evidence || !f.evidence) return '';
    const lines = String(f.evidence).split('\n').filter((l) => l.trim());
    const more = lines.length > 1 ? ` … и ещё ${lines.length - 1}` : '';
    return `${clip(lines[0], 160)}${more}`;
  };

  const columns = [
    { head: 'страница', value: (f) => urlBySlug?.get(f.slug) ?? f.slug },
    { head: 'что проверяли', value: (f) => clip(entityOf(f), 120) },
    { head: 'сейчас', value: (f) => clip(f.actual ?? '', 100) },
    { head: 'фрагмент со страницы', value: (f) => evidenceOf(f) },
    { head: 'давность', value: (f) => ageMark(f) },
  ].filter((col) => group.some((f) => col.value(f)));

  return {
    head: columns.map((c) => c.head),
    rows: group.map((f) => columns.map((c) => escHtml(c.value(f) || ''))),
  };
}

/** Тренд по числу находок за последние прогоны — из data/history.ndjson, если он есть. */
function trendData(run) {
  const points = [];
  try {
    if (existsSync(HISTORY_FILE)) {
      // Map хранит порядок первого появления — история дописывается по прогонам,
      // поэтому это хронология. Считаем строки-находки на каждый прогон.
      const counts = new Map();
      for (const line of readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        counts.set(rec.run, (counts.get(rec.run) ?? 0) + 1);
      }
      for (const [runId, count] of counts) points.push({ runId, count });
    }
  } catch {
    // История — украшение тренда, а не источник истины: без неё отчёт всё равно валиден.
  }

  // Текущий прогон обязан быть последним и с числом из totals: в истории его может
  // ещё не быть (dry-режим) или число могло разойтись с пересчётом.
  const cur = points.find((p) => p.runId === run.runId);
  if (cur) cur.count = run.totals.findings;
  else points.push({ runId: run.runId, count: run.totals.findings });

  return points.slice(-4);
}

/** Полный интерактивный HTML-отчёт по одному прогону. */
export function html(run) {
  const { totals } = run;
  const pages = run.pages;
  const label = (p) => p.label ?? p.slug;
  const urlBySlug = new Map(pages.map((p) => [p.slug, p.final_url ?? p.url]).filter(([, u]) => u));

  // ── группы находок (срез «по важности») ──
  const byCheck = groupFindings(run.findings);
  const findGroups = [];
  for (const item of checklistItems()) {
    for (const checkId of item.checks) {
      const list = byCheck.get(checkId) ?? [];
      if (!list.length) continue;
      for (const group of findingGroups(list)) {
        const first = group[0];
        const prefix = commonEntityPrefix(group);
        findGroups.push({
          severity: first.severity,
          name: escHtml(checkLabel(checkId)),
          count: group.length,
          expected: first.expected ? escHtml(first.expected) : '',
          fix: first.fix ? escHtml(first.fix) : '',
          table: occurrenceData(group, prefix, urlBySlug),
        });
      }
    }
  }

  // ── срез «по страницам» ──
  const findingsBySlug = new Map();
  for (const f of run.findings) {
    if (!findingsBySlug.has(f.slug)) findingsBySlug.set(f.slug, []);
    findingsBySlug.get(f.slug).push(f);
  }
  const findingCells = (f) => {
    const cols = [
      ['страница', urlBySlug.get(f.slug) ?? f.slug],
      ['что проверяли', clip(String(f.entity ?? ''), 120)],
      ['сейчас', clip(String(f.actual ?? ''), 100)],
      [
        'фрагмент со страницы',
        f.evidence ? clip(String(f.evidence).split('\n').filter((l) => l.trim())[0] ?? '', 160) : '',
      ],
      ['давность', ageMark(f)],
    ];
    return cols.filter(([, v]) => v).map(([h, v]) => [h, escHtml(v)]);
  };
  const pageSlice = pages
    .map((p) => ({
      name: escHtml(label(p)),
      url: escHtml(p.final_url ?? p.url ?? ''),
      http: p.http_status ?? null,
      type: escHtml(p.type ?? ''),
      findings: (findingsBySlug.get(p.slug) ?? []).map((f) => ({
        severity: f.severity,
        name: escHtml(checkLabel(f.check_id)),
        cells: findingCells(f),
      })),
    }))
    .filter((p) => p.findings.length)
    .sort((a, b) => b.findings.length - a.findings.length);

  // ── матрица (пункт чеклиста × статусы по страницам) ──
  const matrix = [];
  for (const item of checklistItems()) {
    const tally = { pass: 0, fail: 0, warn: 0, skip: 0, na: 0 };
    let found = 0;
    let touched = false;
    for (const page of pages) {
      const verdicts = item.checks.map((id) => page.verdicts.find((v) => v.check_id === id)).filter(Boolean);
      if (!verdicts.length) continue;
      touched = true;
      const status = worstStatus(verdicts.map((v) => v.status));
      if (status in tally) tally[status]++;
      found += verdicts.reduce((n, v) => n + (v.findings?.length ?? 0), 0);
    }
    if (!touched) continue;
    const cell = (n) => (n ? String(n) : '—');
    matrix.push({
      name: escHtml(item.checklist),
      pass: cell(tally.pass),
      fail: cell(tally.fail),
      warn: cell(tally.warn),
      findings: cell(found),
    });
  }

  const trend = trendData(run);
  const checksPerPage = run.checks?.length ?? ALL_CHECKS.length;

  const D = {
    stats: {
      runId: run.runId,
      pages: totals.pages,
      checksPerPage,
      collected: run.generated_at,
      total: totals.findings,
      p1: totals.P1,
      p2: totals.P2,
      p3: totals.P3,
      fresh: totals.new,
      repeat: totals.repeat,
      resolved: totals.resolved,
      prevRun: run.previous_run,
      prevTotal: run.previous_findings_count,
      delta: run.previous_run ? totals.findings - run.previous_findings_count : null,
    },
    findGroups,
    pageSlice,
    matrix,
    trend: trend.map((p) => ({ label: String(p.runId).replace(/^\d{4}-/, ''), count: p.count })),
    resolved: run.resolved.map((r) => ({
      slug: escHtml(r.slug),
      checklist: escHtml(r.checklist ?? r.check_id ?? ''),
      was: escHtml(clip(collapse(r.message ?? ''), 160)),
    })),
  };

  // `<` внутри JSON закрыл бы </script> раньше времени — экранируем.
  const dataJson = JSON.stringify(D).replace(/</g, '\\u003c');

  const s = D.stats;
  const pct = (n) => (s.total ? (n / s.total) * 100 : 0);
  const p2Groups = findGroups.filter((g) => g.severity === 'P2').length;

  // Дельта к прошлому прогону: рост находок — плохо (красным), падение — хорошо.
  const deltaHtml =
    s.prevRun != null
      ? `vs ${escHtml(s.prevRun)}: <span class="${s.delta > 0 ? 'delta-up' : 'delta-down'}">${
          s.delta > 0 ? '+' : ''
        }${s.delta}</span>, устранено ${s.resolved}`
      : 'первый прогон';

  const maxTrend = Math.max(1, ...D.trend.map((p) => p.count));
  const trendHtml = D.trend
    .map((p, i) => {
      const h = Math.max(6, Math.round((p.count / maxTrend) * 100));
      const cur = i === D.trend.length - 1 ? ' cur' : '';
      return (
        `<div style="flex:1;text-align:center"><div class="bar${cur}" style="height:${h}%" ` +
        `title="${p.count}"></div><div class="cap">${escHtml(p.label)}<br>${p.count}</div></div>`
      );
    })
    .join('');

  // Предупреждение о неполном прогоне — выше находок: без него «стало лучше» врёт.
  let banner = '';
  if (totals.blocked_pages) {
    banner =
      `<div class="banner">⚠️ <b>Прогон неполный:</b> ${totals.blocked_pages} из ${totals.pages} ` +
      `стр. отдали заглушку защиты от ботов — по ним отчёт ничего не утверждает.</div>`;
  } else if (run.scope?.development?.enabled) {
    banner =
      `<div class="banner">⏳ <b>Режим разработки:</b> внутренние ссылки проверены не все, ` +
      `а первые ${run.scope.development.internal_links_per_page} на страницу.</div>`;
  }

  const css = `:root{
  --bg:#f5f6fa; --panel:#ffffff; --panel-2:#fbfcfe; --ink:#1a1d27; --ink-soft:#565b6b;
  --line:#e4e7ef; --line-strong:#d2d7e3;
  --accent:#3b5bdb; --accent-soft:#e7ecfd;
  --p1:#d6336c; --p1-bg:#fce4ec; --p2:#e8890c; --p2-bg:#fdf0dc; --p3:#5b73d6; --p3-bg:#e9edfb;
  --ok:#2f9e44; --ok-bg:#e6f4ea;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0e1016; --panel:#171a23; --panel-2:#1c1f2b; --ink:#e8eaf1; --ink-soft:#9aa0b2;
  --line:#262a38; --line-strong:#333849; --accent:#7089f7; --accent-soft:#20263c;
  --p1:#ff85a8; --p1-bg:#2c1721; --p2:#ffb454; --p2-bg:#2c2213; --p3:#8ea0f0; --p3-bg:#1a1f34;
  --ok:#69db7c; --ok-bg:#15251a;
}}
:root[data-theme="light"]{
  --bg:#f5f6fa; --panel:#fff; --panel-2:#fbfcfe; --ink:#1a1d27; --ink-soft:#565b6b;
  --line:#e4e7ef; --line-strong:#d2d7e3; --accent:#3b5bdb; --accent-soft:#e7ecfd;
  --p1:#d6336c; --p1-bg:#fce4ec; --p2:#e8890c; --p2-bg:#fdf0dc; --p3:#5b73d6; --p3-bg:#e9edfb; --ok:#2f9e44; --ok-bg:#e6f4ea;
}
:root[data-theme="dark"]{
  --bg:#0e1016; --panel:#171a23; --panel-2:#1c1f2b; --ink:#e8eaf1; --ink-soft:#9aa0b2;
  --line:#262a38; --line-strong:#333849; --accent:#7089f7; --accent-soft:#20263c;
  --p1:#ff85a8; --p1-bg:#2c1721; --p2:#ffb454; --p2-bg:#2c2213; --p3:#8ea0f0; --p3-bg:#1a1f34; --ok:#69db7c; --ok-bg:#15251a;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:28px 20px 80px}
.num{font-variant-numeric:tabular-nums}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:.86em}
.masthead{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 14px;margin-bottom:6px}
.masthead h1{font-size:22px;font-weight:680;letter-spacing:-.01em;margin:0}
.masthead .run{font-family:var(--mono);color:var(--accent);font-size:15px}
.sub{color:var(--ink-soft);font-size:13px;margin-bottom:22px}
.banner{background:var(--p1-bg);color:var(--ink);border:1px solid var(--line);border-left:3px solid var(--p1);border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:18px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;position:relative;overflow:hidden}
.kpi .stripe{position:absolute;left:0;top:0;bottom:0;width:3px}
.kpi .lab{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-soft);font-weight:600}
.kpi .val{font-size:30px;font-weight:700;letter-spacing:-.02em;margin-top:2px}
.kpi .hint{font-size:12px;color:var(--ink-soft);margin-top:2px}
.delta-down{color:var(--ok);font-weight:650}
.delta-up{color:var(--p1);font-weight:650}
.panels{display:grid;grid-template-columns:1.15fr .85fr;gap:14px;margin-bottom:26px}
@media(max-width:760px){.panels{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-soft);margin:0 0 12px;font-weight:650}
.sevbar{display:flex;height:14px;border-radius:7px;overflow:hidden;margin-bottom:14px}
.sevbar i{display:block}
.seglist{display:flex;flex-direction:column;gap:9px}
.segrow{display:flex;align-items:center;gap:10px;font-size:13px}
.dot{width:10px;height:10px;border-radius:3px;flex:none}
.segrow b{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:650}
.trend{display:flex;align-items:flex-end;gap:6px;height:70px;margin-top:4px}
.trend .bar{flex:1;background:var(--accent-soft);border-radius:4px 4px 0 0;position:relative;min-height:4px}
.trend .bar.cur{background:var(--accent)}
.trend .cap{font-size:10px;color:var(--ink-soft);text-align:center;margin-top:5px;font-variant-numeric:tabular-nums}
.tabs{display:inline-flex;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:3px;gap:2px;margin-bottom:16px}
.tabs button{border:0;background:transparent;color:var(--ink-soft);font:inherit;font-weight:600;font-size:13px;padding:7px 15px;border-radius:7px;cursor:pointer}
.tabs button.on{background:var(--accent);color:#fff}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px}
.toolbar input{flex:1;min-width:180px;background:var(--panel);border:1px solid var(--line-strong);border-radius:8px;padding:8px 11px;color:var(--ink);font:inherit}
.chip{border:1px solid var(--line-strong);background:var(--panel);color:var(--ink-soft);border-radius:20px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer}
.chip.on{border-color:transparent;color:#fff}
.chip[data-sev="P1"].on{background:var(--p1)} .chip[data-sev="P2"].on{background:var(--p2)}
.chip[data-sev="P3"].on{background:var(--p3)} .chip[data-sev="new"].on{background:var(--accent)}
.grp{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:12px;overflow:hidden}
.grp>summary{list-style:none;cursor:pointer;padding:14px 16px;display:flex;align-items:center;gap:12px}
.grp>summary::-webkit-details-marker{display:none}
.grp>summary::after{content:"›";margin-left:auto;font-size:20px;color:var(--ink-soft);transform:rotate(90deg);transition:transform .15s}
.grp[open]>summary::after{transform:rotate(-90deg)}
.badge{font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;letter-spacing:.02em;flex:none}
.b-P1{color:var(--p1);background:var(--p1-bg)} .b-P2{color:var(--p2);background:var(--p2-bg)} .b-P3{color:var(--p3);background:var(--p3-bg)}
.grp .title{font-weight:640}
.grp .cnt{margin-left:auto;font-size:12px;color:var(--ink-soft);font-variant-numeric:tabular-nums;flex:none}
.grp .new{color:var(--accent);font-weight:650}
.grp .body{padding:0 16px 14px}
.fix{background:var(--panel-2);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:10px 12px;font-size:13px;margin:2px 0 12px}
.fix .exp{color:var(--ink-soft)}
.tblwrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-soft);font-weight:650;padding:8px 10px;background:var(--panel-2);border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
td code{background:var(--panel-2);padding:1px 4px;border-radius:4px}
.age-new{color:var(--accent);font-weight:600;white-space:nowrap}
.age-rep{color:var(--ink-soft);white-space:nowrap}
.mrow{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}
.cells{display:flex;gap:5px}
.cell{width:30px;height:26px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--ink-soft);background:var(--panel-2)}
.cell.pass{background:var(--ok-bg);color:var(--ok)} .cell.fail{background:var(--p1-bg);color:var(--p1)}
.cell.warn{background:var(--p2-bg);color:var(--p2)} .cell.dash{opacity:.35}
.mname{font-size:13px}
.mfind{font-size:12px;color:var(--ink-soft);font-variant-numeric:tabular-nums;text-align:right;min-width:38px}
.pcard{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}
.pcard>summary{list-style:none;cursor:pointer;padding:13px 16px;display:flex;align-items:center;gap:10px}
.pcard>summary::-webkit-details-marker{display:none}
.pcard .pn{font-weight:640}
.pcard .pu{font-family:var(--mono);font-size:11.5px;color:var(--ink-soft)}
.pcard .pill{margin-left:auto;font-size:12px;font-weight:650;padding:3px 10px;border-radius:20px;background:var(--panel-2);color:var(--ink-soft);flex:none}
.pcard .pill.hot{background:var(--p1-bg);color:var(--p1)}
.mini{display:flex;gap:4px;margin-left:6px}
.mini i{font-size:11px;font-weight:700;padding:1px 6px;border-radius:5px}
.hidden{display:none!important}
.foot{color:var(--ink-soft);font-size:12px;margin-top:30px;border-top:1px solid var(--line);padding-top:14px}
.themebtn{position:fixed;top:14px;right:16px;background:var(--panel);border:1px solid var(--line-strong);color:var(--ink-soft);border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer;z-index:5}`;

  const js = `
const D = JSON.parse(document.getElementById('data').textContent);
const sevRank = {P1:0,P2:1,P3:2};
function ageCell(v){
  if(!v) return '';
  if(/новая/.test(v)) return '<span class="age-new">'+v+'</span>';
  return '<span class="age-rep">'+v+'</span>';
}
function renderGroups(){
  const q = document.getElementById('q').value.toLowerCase().trim();
  const active = new Set([...document.querySelectorAll('.chip[data-sev].on')].map(c=>c.dataset.sev));
  const onlyNew = active.has('new');
  const box = document.getElementById('groups'); box.innerHTML='';
  const groups = D.findGroups.slice().sort((a,b)=>sevRank[a.severity]-sevRank[b.severity]||b.count-a.count);
  let shown=0;
  for(const g of groups){
    if(!active.has(g.severity)) continue;
    let rows = g.table.rows;
    const head = g.table.head;
    if(onlyNew){ const ai=head.findIndex(h=>/давност/i.test(h)); if(ai>=0) rows=rows.filter(r=>/новая/.test(r[ai]||'')); }
    if(q){ rows = rows.filter(r=>r.join(' ').toLowerCase().includes(q) || g.name.toLowerCase().includes(q)); }
    if(!rows.length && (q||onlyNew)) continue;
    shown++;
    const newN = (()=>{const ai=head.findIndex(h=>/давност/i.test(h));return ai<0?0:g.table.rows.filter(r=>/новая/.test(r[ai]||'')).length;})();
    const d=document.createElement('details'); d.className='grp'; if(g.severity==='P1'||q||onlyNew) d.open=true;
    const th = head.map(h=>'<th>'+h+'</th>').join('');
    const trs = rows.map(r=>'<tr>'+r.map((c,i)=>{
      const h=head[i]||'';
      let cell=c||'';
      if(/давност/i.test(h)) return '<td>'+ageCell(c)+'</td>';
      if(/^https?:/.test(c)) cell='<a href="'+c+'" target="_blank" rel="noopener">'+c.replace(/^https?:\\/\\//,'')+'</a>';
      else if(/фрагмент|сейчас|проверяли/i.test(h)&&c.length>60) cell='<code>'+c+'</code>';
      return '<td>'+cell+'</td>';
    }).join('')+'</tr>').join('');
    d.innerHTML =
      '<summary><span class="badge b-'+g.severity+'">'+g.severity+'</span>'+
      '<span class="title">'+g.name+'</span>'+
      '<span class="cnt">'+rows.length+' наход.'+(newN?' · <span class="new">'+newN+' нов.</span>':'')+'</span></summary>'+
      '<div class="body">'+
      (g.fix?'<div class="fix">'+(g.expected?'<span class="exp">Ожидалось: '+g.expected+'. </span>':'')+'<b>Как исправить:</b> '+g.fix+'</div>':'')+
      '<div class="tblwrap"><table><thead><tr>'+th+'</tr></thead><tbody>'+trs+'</tbody></table></div></div>';
    box.appendChild(d);
  }
  if(!shown) box.innerHTML='<div class="card" style="text-align:center;color:var(--ink-soft)">Ничего не найдено по фильтру.</div>';
}
function renderPages(){
  const box=document.getElementById('view-pages'); box.innerHTML='';
  if(!D.pageSlice.length){ box.innerHTML='<div class="card" style="text-align:center;color:var(--ink-soft)">Находок нет.</div>'; return; }
  for(const p of D.pageSlice){
    const cnt={P1:0,P2:0,P3:0}; p.findings.forEach(f=>cnt[f.severity]++);
    const d=document.createElement('details'); d.className='pcard';
    const mini=['P1','P2','P3'].filter(k=>cnt[k]).map(k=>'<i class="b-'+k+'">'+k+' '+cnt[k]+'</i>').join('');
    const rows=p.findings.slice().sort((a,b)=>sevRank[a.severity]-sevRank[b.severity]).map(f=>{
      const detail=f.cells.filter(([h])=>!/страниц/i.test(h)).map(([h,v])=>{
        if(/давност/i.test(h)) return ageCell(v);
        return v;
      }).filter(Boolean).join(' · ');
      return '<tr><td><span class="badge b-'+f.severity+'">'+f.severity+'</span></td><td>'+f.name+'</td><td>'+detail+'</td></tr>';
    }).join('');
    d.innerHTML='<summary><span class="pn">'+p.name+'</span> <span class="pu">'+p.url.replace(/^https?:\\/\\//,'')+'</span>'+
      '<span class="mini">'+mini+'</span>'+
      '<span class="pill '+(cnt.P1?'hot':'')+'">'+p.findings.length+' наход.</span></summary>'+
      '<div class="body" style="padding:0 16px 14px"><div class="tblwrap"><table><tbody>'+rows+'</tbody></table></div></div>';
    box.appendChild(d);
  }
}
function renderMatrix(){
  const box=document.getElementById('matrix'); box.innerHTML='';
  for(const m of D.matrix){
    const c=(v,cls)=>{const dash=(!v||v==='—');return '<div class="cell '+(dash?'dash':cls)+'">'+(dash?'·':v)+'</div>';};
    const row=document.createElement('div'); row.className='mrow';
    row.innerHTML='<div><div class="mname">'+m.name+'</div><div class="cells">'+
      c(m.pass,'pass')+c(m.fail,'fail')+c(m.warn,'warn')+'</div></div>'+
      '<div class="mfind">'+(m.findings&&m.findings!=='—'?'<b style="color:var(--ink)">'+m.findings+'</b> наход.':'—')+'</div>';
    box.appendChild(row);
  }
}
document.getElementById('tabs').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  [...e.currentTarget.children].forEach(x=>x.classList.toggle('on',x===b));
  const v=b.dataset.view;
  document.getElementById('view-sev').classList.toggle('hidden',v!=='sev');
  document.getElementById('view-pages').classList.toggle('hidden',v!=='pages');
  document.getElementById('view-matrix').classList.toggle('hidden',v!=='matrix');
});
document.getElementById('q').addEventListener('input',renderGroups);
document.querySelectorAll('.chip[data-sev]').forEach(c=>c.addEventListener('click',()=>{c.classList.toggle('on');renderGroups();}));
document.getElementById('themebtn').addEventListener('click',()=>{
  const r=document.documentElement; const cur=r.getAttribute('data-theme');
  const isDark = cur? cur==='dark' : matchMedia('(prefers-color-scheme:dark)').matches;
  r.setAttribute('data-theme', isDark?'light':'dark');
});
renderGroups(); renderPages(); renderMatrix();
`;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEO Pedant — ${escHtml(s.runId)}</title>
<style>
${css}
</style>
</head>
<body>
<button class="themebtn" id="themebtn">◐ тема</button>
<div class="wrap">
  <div class="masthead">
    <h1>SEO Pedant</h1><span class="run">${escHtml(s.runId)}</span>
  </div>
  <div class="sub">${s.pages} страниц · ${s.checksPerPage} проверок на страницу · собрано ${escHtml(s.collected)}</div>
  ${banner}
  <div class="kpis">
    <div class="kpi"><span class="stripe" style="background:var(--p1)"></span>
      <div class="lab">Критично · P1</div><div class="val num" style="color:var(--p1)">${s.p1}</div>
      <div class="hint">требует решения сейчас</div></div>
    <div class="kpi"><span class="stripe" style="background:var(--p2)"></span>
      <div class="lab">Важно · P2</div><div class="val num" style="color:var(--p2)">${s.p2}</div>
      <div class="hint">${p2Groups} групп</div></div>
    <div class="kpi"><span class="stripe" style="background:var(--accent)"></span>
      <div class="lab">Новых</div><div class="val num" style="color:var(--accent)">${s.fresh}</div>
      <div class="hint">повторяются ${s.repeat}</div></div>
    <div class="kpi"><span class="stripe" style="background:var(--ok)"></span>
      <div class="lab">Всего находок</div><div class="val num">${s.total}</div>
      <div class="hint">${deltaHtml}</div></div>
  </div>

  <div class="panels">
    <div class="card">
      <h2>Находки по важности</h2>
      <div class="sevbar">
        <i style="background:var(--p1);width:${pct(s.p1)}%"></i>
        <i style="background:var(--p2);width:${pct(s.p2)}%"></i>
        <i style="background:var(--p3);width:${pct(s.p3)}%"></i>
      </div>
      <div class="seglist">
        <div class="segrow"><span class="dot" style="background:var(--p1)"></span>P1 · критично <b class="num">${s.p1}</b></div>
        <div class="segrow"><span class="dot" style="background:var(--p2)"></span>P2 · важно <b class="num">${s.p2}</b></div>
        <div class="segrow"><span class="dot" style="background:var(--p3)"></span>P3 · замечание <b class="num">${s.p3}</b></div>
      </div>
    </div>
    <div class="card">
      <h2>Динамика находок</h2>
      <div class="trend">${trendHtml}</div>
    </div>
  </div>

  <div class="tabs" id="tabs">
    <button data-view="sev" class="on">По важности</button>
    <button data-view="pages">По страницам</button>
    <button data-view="matrix">Матрица</button>
  </div>

  <div id="view-sev">
    <div class="toolbar">
      <input id="q" placeholder="Поиск по находкам, страницам, URL…">
      <span class="chip on" data-sev="P1">P1</span>
      <span class="chip on" data-sev="P2">P2</span>
      <span class="chip on" data-sev="P3">P3</span>
      <span class="chip" data-sev="new">только новые</span>
    </div>
    <div id="groups"></div>
  </div>

  <div id="view-pages" class="hidden"></div>

  <div id="view-matrix" class="hidden">
    <div class="card">
      <h2>Пункт чеклиста · ✅ соответствует / ❌ нарушение / ⚠️ замечание</h2>
      <div id="matrix"></div>
    </div>
  </div>

  <div class="foot">
    SEO Pedant · отчёт по прогону <code>${escHtml(s.runId)}</code>. Собран из <code>run.json</code>,
    рядом с markdown и slack. Самодостаточный файл, публикуется через GitHub Pages.
  </div>
</div>
<script id="data" type="application/json">${dataJson}</script>
<script>${js}</script>
</body>
</html>
`;
}

function main() {
  const { values } = parseArgs({ options: { run: { type: 'string' } } });
  const runId = values.run ?? latestRunId();
  if (!runId) throw new Error('нет ни одного прогона');

  const run = readRun(runId);
  if (!run) throw new Error(`нет посчитанных вердиктов для ${runId} — сначала node lib/check.mjs --run ${runId}`);

  mkdirSync(REPORTS_DIR, { recursive: true });
  const mdPath = join(REPORTS_DIR, `${runId}.md`);
  const slackPath = join(REPORTS_DIR, `${runId}.slack.txt`);
  const htmlPath = join(REPORTS_DIR, `${runId}.html`);
  writeFileSync(mdPath, markdown(run));
  writeFileSync(slackPath, slackText(run));
  writeFileSync(htmlPath, html(run));

  console.log(`Отчёты:\n  ${mdPath}\n  ${slackPath}\n  ${htmlPath}`);
  console.log('');
  console.log('— сводка для агента ——————————————');
  console.log(briefText(run));
  console.log('— короткий отчёт для Slack ——————————————');
  console.log(slackText(run));
}

// Запускаемся только как CLI: иначе импорт из тестов сгенерировал бы отчёт.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`report: ${err.message}`);
    process.exit(1);
  }
}
