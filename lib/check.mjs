#!/usr/bin/env node
// Прогон проверок по собранным артефактам. В сеть не ходит.
//
//   node lib/check.mjs                       # по последнему прогону
//   node lib/check.mjs --run 2026-07-31      # по конкретному прогону
//   node lib/check.mjs --run 2026-07-30 --dry   # ничего не записывать (обкатка новой проверки)
//
// Прогон по сохранённому старому прогону — способ проверить новую проверку на истории:
// страницы те же, что были тогда, значит вердикт можно сравнить с тем, что видели глазами.

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATA_DIR,
  HISTORY_FILE,
  STATE_DIR,
  configForType,
  ignores as configuredIgnores,
} from './config.mjs';
import {
  ARTIFACTS,
  SITE_SLUG,
  compareRunIds,
  latestRunId,
  readArtifact,
  runSlugs,
  writeRun,
} from './bundle.mjs';
import { botWallReason, htmlFacts, urlFacts } from './facts.mjs';
import { keywordsFor } from './keywords.mjs';
import { clip } from './text.mjs';
import { ALL_CHECKS } from './checks/index.mjs';
import { NA, SKIP, effectiveSeverity, fail, fingerprint } from './verdict.mjs';

const NEED_LABEL = {
  response: 'ответ сервера',
  html: 'HTML страницы',
  dom: 'HTML после отрисовки (нужен браузер)',
  console: 'лог консоли (нужен браузер)',
  mobile: 'мобильные метрики (нужен браузер)',
  lighthouse: 'отчёт Lighthouse',
  site: 'robots.txt и sitemap',
  links: 'статусы ссылок',
};

function loadFacts(runId, slug, site, links) {
  const meta = readArtifact(runId, slug, ARTIFACTS.meta);
  if (!meta) return null;

  const rawHtml = readArtifact(runId, slug, ARTIFACTS.rawHtml);
  const domHtml = readArtifact(runId, slug, ARTIFACTS.domHtml);
  const base = meta.http.final?.url ?? meta.url;
  const parsedBase = urlFacts(base);

  return {
    // Если вместо страницы пришла заглушка защиты от ботов, судить её нельзя:
    // проверки нашли бы нарушения по всем пунктам, а diff объявил бы вчерашние
    // проблемы устранёнными. Такая страница целиком уходит в «не проверено».
    blocked: botWallReason(meta.http.final?.status ?? null, rawHtml),
    page: {
      slug,
      url: meta.url,
      label: meta.label,
      type: meta.type ?? 'unknown',
      adhoc: Boolean(meta.adhoc),
    },
    http: meta.http,
    url: urlFacts(meta.url),
    finalUrl: parsedBase,
    html: rawHtml ? htmlFacts(rawHtml, base) : null,
    dom: domHtml ? htmlFacts(domHtml, base) : null,
    console: readArtifact(runId, slug, ARTIFACTS.console),
    mobile: readArtifact(runId, slug, ARTIFACTS.mobile),
    lighthouse: readArtifact(runId, slug, ARTIFACTS.lighthouse),
    site: parsedBase.valid ? site?.[parsedBase.origin] ?? null : null,
    links,
  };
}

function availableArtifacts(f) {
  const set = new Set(['response']);
  if (f.html) set.add('html');
  if (f.dom) set.add('dom');
  if (f.console) set.add('console');
  if (f.mobile) set.add('mobile');
  if (f.lighthouse) set.add('lighthouse');
  if (f.site) set.add('site');
  if (f.links) set.add('links');
  return set;
}

/** Упавшая проверка не рушит прогон, а становится находкой: молчаливый сбой хуже. */
function safeRun(check, input, ctx) {
  try {
    const verdict = check.run(input, ctx);
    if (!verdict || typeof verdict !== 'object') throw new Error('проверка не вернула вердикт');
    return verdict;
  } catch (err) {
    return fail({
      entity: 'ошибка проверки',
      expected: 'проверка выполняется без исключений',
      actual: err.message,
      severity: 'P3',
      note: `Сломана сама проверка ${check.id}, а не страница.`,
    });
  }
}

/** Досыпает находкам важность, адрес в истории и связь с проверкой. */
function materialize(slug, check, verdict, overrides) {
  const perEntity = new Map();
  return (verdict.findings ?? []).map((f) => {
    const dupIndex = perEntity.get(f.entity) ?? 0;
    perEntity.set(f.entity, dupIndex + 1);
    return {
      ...f,
      severity: effectiveSeverity(f, check, overrides),
      slug,
      check_id: check.id,
      checklist: check.checklist,
      family: check.family,
      fingerprint: fingerprint(slug, check.id, f.entity, dupIndex),
    };
  });
}

function matchIgnore(finding, list) {
  return (
    list.find(
      (i) =>
        i.check === finding.check_id &&
        (i.slug === '*' || i.slug === finding.slug) &&
        (i.entity === '*' || String(finding.entity).includes(i.entity)),
    ) ?? null
  );
}

/**
 * История находок — единственный источник знания о прошлых прогонах.
 * Артефакты прогонов (включая run.json) в репозиторий не попадают, поэтому и «новое /
 * повторяется / устранено» считается по этому файлу, а не по прошлому run.json.
 *
 * Строки текущего прогона исключаются: повторный запуск check.mjs по тому же runId
 * не должен ни накручивать days_seen, ни превращать вчерашнюю проблему в новую.
 */
function readHistory(runId) {
  const rows = [];
  if (existsSync(HISTORY_FILE)) {
    for (const line of readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.fingerprint && row.run) rows.push(row);
      } catch {
        // битую строку молча пропускаем: одна порча не должна ронять прогон
      }
    }
  }

  const others = rows.filter((r) => r.run !== runId);
  const byFingerprint = new Map();
  for (const row of others) {
    const entry = byFingerprint.get(row.fingerprint) ?? { dates: new Set(), runs: new Set() };
    entry.dates.add(row.date);
    entry.runs.add(row.run);
    byFingerprint.set(row.fingerprint, entry);
  }

  const previousRunId =
    [...new Set(others.map((r) => r.run))]
      .filter((id) => compareRunIds(id, runId) < 0)
      .sort(compareRunIds)
      .at(-1) ?? null;

  return {
    rows,
    byFingerprint,
    previousRunId,
    previousFindings: previousRunId ? others.filter((r) => r.run === previousRunId) : [],
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      'from-run': { type: 'string' },
      dry: { type: 'boolean', default: false },
    },
  });

  const runId = values.run ?? values['from-run'] ?? latestRunId();
  if (!runId) throw new Error('нет ни одного прогона — сначала node lib/collect.mjs --all');
  const runDate = runId.slice(0, 10);

  const slugs = runSlugs(runId);
  if (!slugs.length) throw new Error(`в прогоне ${runId} нет страниц`);

  const site = readArtifact(runId, SITE_SLUG, 'site.json');
  const links = readArtifact(runId, SITE_SLUG, 'links.json');
  const ignoreList = configuredIgnores();
  const history = readHistory(runId);

  const facts = slugs.map((slug) => loadFacts(runId, slug, site, links)).filter(Boolean);
  const pageChecks = ALL_CHECKS.filter((c) => c.scope === 'page');
  const siteChecks = ALL_CHECKS.filter((c) => c.scope === 'site');
  const checkOrder = new Map(ALL_CHECKS.map((c, i) => [c.id, i]));

  const pages = [];
  const allFindings = [];
  const suppressed = [];

  // ── проверки уровня страницы ──────────────────────────────────────────────
  for (const f of facts) {
    const typeConf = configForType(f.page.type);
    const ctx = {
      thresholds: typeConf.thresholds,
      keywords: keywordsFor({ url: f.page.url, keywords: f.page.keywords }),
      config: typeConf,
    };
    const have = availableArtifacts(f);
    const disabled = new Set(typeConf.checks.disabled);
    const verdicts = [];

    if (f.blocked) {
      for (const check of ALL_CHECKS) {
        verdicts.push({ check_id: check.id, status: SKIP, reason: f.blocked });
      }
      pages.push({
        slug: f.page.slug,
        url: f.page.url,
        final_url: f.http.final?.url ?? null,
        http_status: f.http.final?.status ?? null,
        label: f.page.label,
        type: f.page.type,
        type_fallback: typeConf.fallback,
        keywords: ctx.keywords.all.map((k) => k.word),
        blocked: f.blocked,
        verdicts,
      });
      continue;
    }

    for (const check of pageChecks) {
      if (disabled.has(check.id)) {
        verdicts.push({
          check_id: check.id,
          status: SKIP,
          reason: `отключена в config/page-types/${typeConf.type}.json`,
        });
        continue;
      }
      const missing = (check.needs ?? []).filter((n) => !have.has(n));
      if (missing.length) {
        verdicts.push({
          check_id: check.id,
          status: SKIP,
          reason: `нет данных: ${missing.map((n) => NEED_LABEL[n] ?? n).join(', ')}`,
        });
        continue;
      }
      const verdict = safeRun(check, f, ctx);
      const findings = materialize(f.page.slug, check, verdict, typeConf.checks.severity_overrides);
      verdicts.push({
        check_id: check.id,
        status: verdict.status,
        reason: verdict.reason ?? null,
        note: verdict.note ?? null,
        findings: findings.map((x) => x.fingerprint),
      });
      allFindings.push(...findings);
    }

    pages.push({
      slug: f.page.slug,
      url: f.page.url,
      final_url: f.http.final?.url ?? null,
      http_status: f.http.final?.status ?? null,
      label: f.page.label,
      type: f.page.type,
      type_fallback: typeConf.fallback,
      keywords: ctx.keywords.all.map((k) => k.word),
      verdicts,
    });
  }

  // ── проверки уровня сайта: видят все страницы сразу ───────────────────────
  const siteThresholds = configForType('').thresholds;
  for (const check of siteChecks) {
    const usable = facts.filter(
      (f) => !f.blocked && (check.needs ?? []).every((n) => availableArtifacts(f).has(n)),
    );
    const byslug = usable.length
      ? safeRun(check, usable, { thresholds: siteThresholds, keywords: { all: [] }, config: null })
      : {};
    // safeRun вернёт вердикт, если проверка упала — раздаём его всем страницам.
    const isVerdict = typeof byslug.status === 'string';

    for (const page of pages) {
      if (page.blocked) continue; // вердикты для такой страницы уже проставлены
      const typeConf = configForType(page.type);
      if (typeConf.checks.disabled.includes(check.id)) {
        page.verdicts.push({
          check_id: check.id,
          status: SKIP,
          reason: `отключена в config/page-types/${typeConf.type}.json`,
        });
        continue;
      }
      const verdict = isVerdict ? byslug : byslug[page.slug];
      if (!verdict) {
        page.verdicts.push({
          check_id: check.id,
          status: SKIP,
          reason: `нет данных: ${(check.needs ?? []).map((n) => NEED_LABEL[n] ?? n).join(', ')}`,
        });
        continue;
      }
      const findings = materialize(page.slug, check, verdict, typeConf.checks.severity_overrides);
      page.verdicts.push({
        check_id: check.id,
        status: verdict.status,
        reason: verdict.reason ?? null,
        note: verdict.note ?? null,
        findings: findings.map((x) => x.fingerprint),
      });
      allFindings.push(...findings);
    }
  }

  // ── игноры ───────────────────────────────────────────────────────────────
  const kept = [];
  for (const finding of allFindings) {
    const ignore = matchIgnore(finding, ignoreList);
    if (ignore) {
      suppressed.push({ ...finding, ignored_because: ignore.reason ?? 'без причины' });
    } else {
      kept.push(finding);
    }
  }

  // ── статус находки относительно истории ──────────────────────────────────
  for (const finding of kept) {
    const seen = history.byFingerprint.get(finding.fingerprint);
    finding.status = seen ? 'repeat' : 'new';
    // Считаем дни, а не прогоны: два прогона за сутки — это один день жизни проблемы.
    finding.days_seen = seen ? (seen.dates.has(runDate) ? seen.dates.size : seen.dates.size + 1) : 1;
    finding.first_seen = seen ? [...seen.dates].sort()[0] : runDate;
  }

  kept.sort(
    (a, b) =>
      a.severity.localeCompare(b.severity) ||
      (checkOrder.get(a.check_id) ?? 0) - (checkOrder.get(b.check_id) ?? 0) ||
      a.slug.localeCompare(b.slug) ||
      String(a.entity).localeCompare(String(b.entity)),
  );

  // ── что изменилось с прошлого прогона ────────────────────────────────────
  const current = new Set(kept.map((f) => f.fingerprint));
  const verdictIndex = new Map();
  for (const page of pages) {
    for (const v of page.verdicts) verdictIndex.set(`${page.slug}::${v.check_id}`, v);
  }

  const resolved = [];
  const uncheckedNow = [];
  for (const old of history.previousFindings) {
    if (current.has(old.fingerprint)) continue;
    const verdict = verdictIndex.get(`${old.slug}::${old.check}`);
    const record = {
      fingerprint: old.fingerprint,
      slug: old.slug,
      check_id: old.check,
      checklist: old.checklist ?? null,
      severity: old.severity,
      entity: old.entity,
      message: old.message ?? old.entity,
      last_seen: history.previousRunId,
    };
    if (!verdict) {
      uncheckedNow.push({ ...record, reason: 'страница не проверялась в этом прогоне' });
    } else if (verdict.status === SKIP || verdict.status === NA) {
      uncheckedNow.push({ ...record, reason: verdict.reason ?? 'проверка не выполнялась' });
    } else {
      resolved.push(record);
    }
  }

  // ── итоги ────────────────────────────────────────────────────────────────
  const statusTotals = { pass: 0, fail: 0, warn: 0, skip: 0, na: 0 };
  for (const page of pages) {
    for (const v of page.verdicts) statusTotals[v.status] = (statusTotals[v.status] ?? 0) + 1;
  }

  const record = {
    runId,
    date: runDate,
    generated_at: new Date().toISOString(),
    previous_run: history.previousRunId,
    previous_findings_count: history.previousFindings.length,
    checks: ALL_CHECKS.map((c) => ({
      id: c.id,
      checklist: c.checklist,
      family: c.family,
      scope: c.scope,
      severity: c.severity,
    })),
    blocked: pages.filter((p) => p.blocked).map((p) => ({ slug: p.slug, url: p.url, reason: p.blocked })),
    totals: {
      pages: pages.length,
      blocked_pages: pages.filter((p) => p.blocked).length,
      verdicts: Object.values(statusTotals).reduce((a, b) => a + b, 0),
      ...statusTotals,
      findings: kept.length,
      P1: kept.filter((f) => f.severity === 'P1').length,
      P2: kept.filter((f) => f.severity === 'P2').length,
      P3: kept.filter((f) => f.severity === 'P3').length,
      new: kept.filter((f) => f.status === 'new').length,
      repeat: kept.filter((f) => f.status === 'repeat').length,
      resolved: resolved.length,
      unchecked_now: uncheckedNow.length,
      suppressed: suppressed.length,
    },
    pages,
    findings: kept,
    resolved,
    unchecked_now: uncheckedNow,
    suppressed,
    lighthouse: Object.fromEntries(
      facts.filter((f) => f.lighthouse).map((f) => [f.page.slug, f.lighthouse]),
    ),
  };

  if (values.dry) {
    console.log('--dry: ничего не записано');
  } else {
    writeRun(runId, record);
    mkdirSync(DATA_DIR, { recursive: true });
    const at = record.generated_at;
    const lines = kept.map((f) =>
      JSON.stringify({
        run: runId,
        date: runDate,
        at,
        fingerprint: f.fingerprint,
        slug: f.slug,
        check: f.check_id,
        checklist: f.checklist,
        severity: f.severity,
        // Текст сообщения не храним: он выводится из entity и пункта чеклиста, а история
        // растёт на каждый прогон и лежит в репозитории.
        entity: clip(f.entity, 200),
        status: f.status,
        days_seen: f.days_seen,
      }),
    );
    // Строки прошлых прогонов не трогаем, строки этого прогона заменяем: так повторный
    // запуск check.mjs по тому же runId не плодит дубликаты в истории.
    const preserved = history.rows.filter((r) => r.run !== runId).map((r) => JSON.stringify(r));
    writeFileSync(HISTORY_FILE, `${[...preserved, ...lines].join('\n')}\n`);
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      join(STATE_DIR, 'last-run.json'),
      `${JSON.stringify(
        {
          runId,
          checked_at: at,
          previous_run: record.previous_run,
          totals: record.totals,
        },
        null,
        2,
      )}\n`,
    );
  }

  // ── вывод ────────────────────────────────────────────────────────────────
  console.log(`Прогон ${runId}: ${pages.length} стр., ${ALL_CHECKS.length} проверок`);
  for (const page of pages) {
    if (page.blocked) {
      console.log(`  ${page.slug}: не проверялась — ${page.blocked}`);
      continue;
    }
    const counts = { fail: 0, warn: 0, skip: 0, na: 0, pass: 0 };
    for (const v of page.verdicts) counts[v.status]++;
    console.log(
      `  ${page.slug}: ✅ ${counts.pass}  ❌ ${counts.fail}  ⚠️ ${counts.warn}  ⏭ ${counts.skip}  – ${counts.na}`,
    );
  }
  const t = record.totals;
  if (t.blocked_pages) {
    console.log(
      `ВНИМАНИЕ: ${t.blocked_pages} из ${t.pages} стр. отдали заглушку защиты от ботов — прогон неполный, отчёт по ним ничего не утверждает.`,
    );
  }
  console.log(
    `Находок ${t.findings} (P1 ${t.P1}, P2 ${t.P2}, P3 ${t.P3}), новых ${t.new}, устранено ${t.resolved}, перестало проверяться ${t.unchecked_now}, заглушено ${t.suppressed}`,
  );
  if (!values.dry) console.log(`Дальше: node lib/report.mjs --run ${runId}`);
}

try {
  main();
} catch (err) {
  console.error(`check: ${err.message}`);
  process.exit(1);
}
