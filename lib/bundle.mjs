// Чтение и запись артефактов прогона.
//
// Артефакт прогона — сырые данные (HTML до гидрации, HTML после, лог консоли, отчёт
// Lighthouse), а не выжимка из них. Поэтому новую проверку можно прогнать по старым
// страницам: node lib/check.mjs --from-run <runId>.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { RUNS_DIR } from './config.mjs';

export const ARTIFACTS = {
  meta: 'meta.json', //        что вернул сервер: цепочка редиректов, статус, тайминги
  rawHtml: 'raw.html.gz', //   HTML как его отдал сервер (до JS)
  domHtml: 'dom.html.gz', //   HTML после гидрации, из браузера
  console: 'console.json', //  ошибки консоли и неудачные запросы
  mobile: 'mobile.json', //    метрики мобильного viewport
  screenshot: 'mobile.png',
  lighthouse: 'lighthouse.json',
};

function pad(n) {
  return String(n).padStart(2, '0');
}

export function todayId(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Ключ сортировки: 2026-07-31 идёт раньше 2026-07-31-2. */
function sortKey(runId) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/.exec(runId);
  return m ? [m[1], Number(m[2] ?? 1)] : [runId, 0];
}

/** Хронологический порядок прогонов, включая несколько прогонов за один день. */
export function compareRunIds(a, b) {
  const [da, na] = sortKey(a);
  const [db, nb] = sortKey(b);
  return da === db ? na - nb : da < db ? -1 : 1;
}

export function listRunIds() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}(-\d+)?$/.test(d.name))
    .map((d) => d.name)
    .sort(compareRunIds);
}

export function latestRunId() {
  return listRunIds().at(-1) ?? null;
}

/** Прогон, идущий перед указанным. Нужен для diff новых и устранённых проблем. */
export function previousRunId(runId) {
  const all = listRunIds();
  const at = all.indexOf(runId);
  return at > 0 ? all[at - 1] : null;
}

/** Новый id прогона: дата, а при повторе за тот же день — с суффиксом -2, -3. */
export function newRunId(date = new Date()) {
  const base = todayId(date);
  if (!existsSync(join(RUNS_DIR, base))) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(join(RUNS_DIR, candidate))) return candidate;
  }
  throw new Error(`слишком много прогонов за ${base}`);
}

export function runDir(runId) {
  return join(RUNS_DIR, runId);
}

export function pageDir(runId, slug) {
  return join(RUNS_DIR, runId, slug);
}

function ensure(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function hasArtifact(runId, slug, name) {
  return existsSync(join(pageDir(runId, slug), name));
}

export function writeArtifact(runId, slug, name, content) {
  const dir = ensure(pageDir(runId, slug));
  const path = join(dir, name);
  if (Buffer.isBuffer(content)) {
    writeFileSync(path, content);
  } else if (name.endsWith('.gz')) {
    writeFileSync(path, gzipSync(Buffer.from(String(content), 'utf8')));
  } else if (name.endsWith('.json')) {
    writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
  } else {
    writeFileSync(path, String(content));
  }
  return path;
}

export function readArtifact(runId, slug, name) {
  const path = join(pageDir(runId, slug), name);
  if (!existsSync(path)) return null;
  if (name.endsWith('.gz')) return gunzipSync(readFileSync(path)).toString('utf8');
  const text = readFileSync(path, 'utf8');
  return name.endsWith('.json') ? JSON.parse(text) : text;
}

// Артефакты уровня прогона (robots.txt, sitemap, статусы ссылок) лежат в папке
// с этим именем: она общая для всех страниц и не является слагом.
export const SITE_SLUG = '_site';

/** Слаги страниц, собранные в этом прогоне. */
export function runSlugs(runId) {
  const dir = runDir(runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
}

export function writeRun(runId, record) {
  ensure(runDir(runId));
  writeFileSync(join(runDir(runId), 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
}

export function readRun(runId) {
  const path = join(runDir(runId), 'run.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** Ближайший предыдущий прогон, у которого есть посчитанные вердикты. */
export function previousRun(runId) {
  let cursor = previousRunId(runId);
  while (cursor) {
    const record = readRun(cursor);
    if (record) return { runId: cursor, record };
    cursor = previousRunId(cursor);
  }
  return null;
}
