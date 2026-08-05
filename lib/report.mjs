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

/** Одна находка одной строкой: важность, страница, адрес, фактическое значение, история. */
function occurrenceLine(f, prefix = '') {
  const entity = String(f.entity ?? '').slice(prefix.length);
  const where = entity && entity !== '—' ? ` · ${entity}` : '';
  const actual = f.actual ? ` — ${f.actual}` : '';
  return `- **${f.severity}** \`${f.slug}\`${where}${actual} · ${ageMark(f)} \`${f.fingerprint}\``;
}

function occurrenceRow(f, prefix = '') {
  const entity = String(f.entity ?? '').slice(prefix.length);
  return `| ${f.severity} | \`${f.slug}\` | ${escapeCell(clip(entity, 120))} | ${escapeCell(clip(f.actual ?? '', 100))} | ${ageMark(f)} |`;
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
    for (const b of run.blocked ?? []) out.push(`> - \`${b.slug}\` — ${b.reason}`);
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

  // ── матрица ────────────────────────────────────────────────────────────────
  out.push('');
  out.push('## Чеклист по страницам');
  out.push('');
  out.push(`${SYMBOL.pass} соответствует · ${SYMBOL.fail} нарушение · ${SYMBOL.warn} замечание · ${SYMBOL.skip} не проверено · ${SYMBOL.na} проверка невозможна`);
  out.push('');
  out.push(`| Пункт чеклиста | ${pages.map((p) => escapeCell(label(p))).join(' | ')} |`);
  out.push(`| --- | ${pages.map(() => '---').join(' | ')} |`);

  let hasPartial = false;
  for (const item of checklistItems()) {
    const cells = pages.map((page) => {
      const verdicts = item.checks.map((id) => page.verdicts.find((v) => v.check_id === id)).filter(Boolean);
      const statuses = verdicts.map((v) => v.status);
      const status = worstStatus(statuses);
      const count = verdicts.reduce((n, v) => n + (v.findings?.length ?? 0), 0);

      // Пункт, у которого часть подпроверок невозможна или проверена не целиком,
      // не должен выглядеть полностью проверенным: иначе ✅ обещает больше, чем бот
      // действительно посмотрел.
      const partial =
        (statuses.length > 1 && statuses.includes('na')) || verdicts.some((v) => v.partial);
      if (partial) hasPartial = true;

      if (status === 'fail' || status === 'warn') return `${SYMBOL[status]} ${count}${partial ? '*' : ''}`;
      return `${SYMBOL[status] ?? '?'}${partial ? '*' : ''}`;
    });
    out.push(`| ${escapeCell(item.checklist)} | ${cells.join(' | ')} |`);
  }

  if (hasPartial) {
    out.push('');
    out.push(
      '`*` пункт проверен частично: часть его проверок невозможна или действует лимит — ' +
        'см. разделы выше и «Не проверено».',
    );
  }

  out.push('');
  out.push('Страницы в таблице:');
  for (const p of pages) {
    const redirect = p.final_url && p.final_url !== p.url ? ` → ${p.final_url}` : '';
    const blocked = p.blocked ? ', **не проверялась: заглушка защиты от ботов**' : '';
    out.push(
      `- **${label(p)}** — ${p.url}${redirect} (HTTP ${p.http_status ?? '—'}, тип \`${p.type}\`${p.type_fallback ? ', настроек типа нет' : ''}${blocked})`,
    );
  }

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
      out.push(`- **${check?.checklist ?? checkId}** (\`${checkId}\`): ${list.length} — страницы: ${[...new Set(list.map((f) => f.slug))].join(', ')}`);
    }
  }

  out.push('');
  out.push(`## Устранено с прошлого прогона — ${run.resolved.length}`);
  out.push('');
  if (!run.resolved.length) {
    out.push('Нет.');
  } else {
    for (const r of run.resolved) {
      out.push(`- ✅ \`${r.slug}\` · ${r.checklist ?? r.check_id} — было: ${r.message} (\`${r.fingerprint}\`)`);
    }
  }

  if (run.unchecked_now.length) {
    out.push('');
    out.push(`## Перестало проверяться — ${run.unchecked_now.length}`);
    out.push('');
    out.push('Эти проблемы не устранены: в этом прогоне их просто некому было найти.');
    out.push('');
    for (const r of run.unchecked_now) {
      out.push(`- ⏭ \`${r.slug}\` · ${r.checklist ?? r.check_id} — ${r.reason}. Было: ${r.message}`);
    }
  }

  // ── все находки ────────────────────────────────────────────────────────────
  out.push('');
  out.push('## Находки по пунктам чеклиста');

  const byCheck = groupFindings(run.findings);
  const foldAbove = configForType('').thresholds.report_collapse_threshold ?? 12;

  for (const item of checklistItems()) {
    const itemFindings = item.checks.flatMap((id) => byCheck.get(id) ?? []);
    if (!itemFindings.length) continue;

    out.push('');
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
        if (first.note) {
          out.push('');
          out.push(`_${first.note}_`);
        }
        // Решение одно на группу: у пяти страниц с одной и той же причиной оно общее.
        if (first.fix) {
          out.push('');
          out.push(`**Как исправить:** ${first.fix}`);
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

        out.push('');
        if (group.length > foldAbove) {
          out.push('<details><summary>показать все</summary>');
          out.push('');
          out.push('| | страница | что | фактически | |');
          out.push('| --- | --- | --- | --- | --- |');
          for (const f of group) out.push(occurrenceRow(f, prefix));
          out.push('');
          out.push('</details>');
        } else {
          for (const f of group) {
            out.push(occurrenceLine(f, prefix));
            if (evidenceAtGroupLevel || !f.evidence) continue;
            const lines = String(f.evidence).split('\n').filter((l) => l.trim());
            const more = lines.length > 1 ? ` … и ещё ${lines.length - 1}` : '';
            out.push(`  - со страницы: \`${clip(lines[0], 200)}\`${more}`);
          }
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
    const byReason = new Map();
    for (const n of notChecked) {
      const key = `${n.label} — ${n.reason}`;
      if (!byReason.has(key)) byReason.set(key, []);
      byReason.get(key).push(n.slug);
    }
    for (const [key, slugs] of byReason) {
      out.push(`- ${key} (${slugs.length} стр.)`);
    }
  }

  if (run.suppressed?.length) {
    out.push('');
    out.push('## Заглушено игнорами');
    out.push('');
    for (const s of run.suppressed) {
      out.push(`- \`${s.slug}\` · \`${s.check_id}\` · ${s.entity} — ${s.ignored_because}`);
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
      const where = g.slugs.size === totals.pages ? 'все страницы' : [...g.slugs].join(', ');
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
