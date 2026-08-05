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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORTS_DIR, configForType, delivery } from './config.mjs';
import { latestRunId, readRun } from './bundle.mjs';
import { ALL_CHECKS, checkById, checklistItems } from './checks/index.mjs';
import { clip, collapse } from './text.mjs';

const SYMBOL = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭', na: '—' };
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
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s/g, '-');
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
  return f.status === 'new' ? '🆕' : `↻${f.days_seen}д`;
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

  const columns = [
    { head: 'страница', value: (f) => slugLink(f.slug, urlBySlug) },
    { head: 'что', value: (f) => escapeCell(clip(entityOf(f), 120)) },
    { head: 'фактически', value: (f) => escapeCell(clip(f.actual ?? '', 100)) },
    { head: 'со страницы', value: (f) => escapeCell(evidenceOf(f)) },
    { head: 'видим', value: (f) => ageMark(f) },
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
    out.push('');
    for (const p of pages) {
      const note = p.verdicts.find((v) => v.check_id === 'links-internal')?.note;
      if (note) out.push(`- **${label(p)}** — ${note}`);
    }
  }

  // Считаем находки до таблицы: по ним она узнаёт, у какого пункта есть раздел ниже,
  // и ставит на название ссылку-переход именно к нему.
  const byCheck = groupFindings(run.findings);
  const sectionAnchor = new Map();
  for (const item of checklistItems()) {
    const count = item.checks.flatMap((id) => byCheck.get(id) ?? []).length;
    if (count) sectionAnchor.set(item.checklist, headingAnchor(`${item.checklist} — ${count}`));
  }

  // ── сводка по пунктам ──────────────────────────────────────────────────────
  //
  // Таблица считает страницы, а не перечисляет их колонками: колонка на страницу
  // читалась на восьми страницах и перестаёт читаться на сотне. Какие именно
  // страницы задеты — в разделах с находками ниже.
  out.push('');
  out.push('## Чеклист: сколько страниц по каждому пункту');
  out.push('');
  out.push(`${SYMBOL.pass} соответствует · ${SYMBOL.fail} нарушение · ${SYMBOL.warn} замечание · ${SYMBOL.skip} не проверено · ${SYMBOL.na} проверка невозможна`);
  out.push('');
  out.push(`| Пункт чеклиста | ${SYMBOL.pass} | ${SYMBOL.fail} | ${SYMBOL.warn} | ${SYMBOL.skip} | ${SYMBOL.na} | находок |`);
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
    out.push(`### ${item.checklist} — ${itemFindings.length}`);

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

        out.push('');
        out.push(
          `**${first.severity}** · ${group.length} ${group.length === 1 ? 'находка' : 'находок'} ` +
            `на ${affected} стр.${fresh && fresh < group.length ? `, из них новых ${fresh}` : ''}` +
            `${first.expected ? ` · ожидалось: ${first.expected}` : ''}`,
        );
        // Пояснение и решение — одна плашка на группу: у пяти страниц с одной и той же
        // причиной они общие, и читаются вместе — сначала почему это проблема, потом
        // что делать. Рамку и иконку рисует alert-блок GitHub: своей заливкой этого не
        // сделать, CSS из markdown он вырезает.
        if (first.fix) {
          out.push('');
          out.push('> [!WARNING]');
          if (first.note) {
            out.push(`> ℹ️ _${first.note}_`);
            out.push('>');
          }
          out.push(`> **Как исправить:** ${first.fix}`);
        } else if (first.note) {
          // Пояснение без решения — просто контекст, плашка ему ни к чему.
          out.push('');
          out.push(`_${first.note}_`);
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
        out.push(`**Страницы с проблемами ${first.severity} — ${group.length}**`);
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
  out.push(`🆕 новых ${totals.new} · ✅ устранено ${totals.resolved}${dynamics}`);

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
      `⏳ _На время разработки внутренние ссылки проверяются частично: первые ` +
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
      const mark = g.fresh === g.count ? '🆕' : g.fresh ? `🆕${g.fresh}` : '↻';
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
      out.push(`• ✅ ${r.slug}: ${clip(r.message, 120)}`);
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

  out.push('');
  out.push(`Полный отчёт: ${cfg.repo}/blob/${cfg.branch}/reports/${run.runId}.md`);

  let text = out.join('\n');
  const max = cfg.slack_max_chars ?? 3500;
  if (text.length > max) {
    const tail = `\n…\nПолный отчёт: ${cfg.repo}/blob/${cfg.branch}/reports/${run.runId}.md`;
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

function main() {
  const { values } = parseArgs({ options: { run: { type: 'string' } } });
  const runId = values.run ?? latestRunId();
  if (!runId) throw new Error('нет ни одного прогона');

  const run = readRun(runId);
  if (!run) throw new Error(`нет посчитанных вердиктов для ${runId} — сначала node lib/check.mjs --run ${runId}`);

  mkdirSync(REPORTS_DIR, { recursive: true });
  const mdPath = join(REPORTS_DIR, `${runId}.md`);
  const slackPath = join(REPORTS_DIR, `${runId}.slack.txt`);
  writeFileSync(mdPath, markdown(run));
  writeFileSync(slackPath, slackText(run));

  console.log(`Отчёты:\n  ${mdPath}\n  ${slackPath}`);
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
