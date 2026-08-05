// Чтение config/* и наследование настроек по типу страницы.
// Комментарии в JSON — это ключи с префиксом `_`, они вырезаются при чтении.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const CONFIG_DIR = join(ROOT, 'config');
export const DATA_DIR = join(ROOT, 'data');
export const RUNS_DIR = join(DATA_DIR, 'runs');
export const CACHE_DIR = join(DATA_DIR, 'cache');
export const REPORTS_DIR = join(ROOT, 'reports');
export const STATE_DIR = join(ROOT, 'state');
export const HISTORY_FILE = join(DATA_DIR, 'history.ndjson');

/** Убирает ключи с префиксом `_` (это комментарии) на всех уровнях. */
export function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_')) continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return value;
}

export function readJson(path) {
  try {
    return stripComments(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    throw new Error(`не читается ${path}: ${err.message}`);
  }
}

function configPath(...parts) {
  return join(CONFIG_DIR, ...parts);
}

/** Страницы из config/pages.json, кроме выключенных. */
export function pages() {
  const { pages: list = [] } = readJson(configPath('pages.json'));
  const enabled = list.filter((p) => p.enabled !== false);
  const slugs = new Set();
  for (const p of enabled) {
    if (!p.slug || !p.url) throw new Error(`страница без slug или url: ${JSON.stringify(p)}`);
    if (slugs.has(p.slug)) throw new Error(`дубликат slug в pages.json: ${p.slug}`);
    slugs.add(p.slug);
  }
  return enabled;
}

export function pageBySlug(slug) {
  return pages().find((p) => p.slug === slug);
}

export function listPageTypes() {
  return readdirSync(configPath('page-types'))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.replace(/\.json$/, ''));
}

/**
 * Настройки для типа страницы: _default.json → <type>.json.
 * thresholds и severity_overrides мержатся по ключам, disabled конкатенируется.
 * Неизвестный тип не роняет прогон: берётся _default и ставится флаг fallback.
 */
export function configForType(type) {
  const base = readJson(configPath('page-types', '_default.json'));
  const file = configPath('page-types', `${type}.json`);
  const known = Boolean(type) && existsSync(file);
  const own = known ? readJson(file) : {};

  const baseDisabled = base.checks?.disabled || [];
  const ownDisabled = own.checks?.disabled || [];
  // Откуда пришло отключение — чтобы отчёт называл настоящий файл: проверка, снятая
  // в _default.json, не должна выглядеть отключённой в country.json.
  const disabledSource = {};
  for (const id of baseDisabled) disabledSource[id] = 'config/page-types/_default.json';
  for (const id of ownDisabled) disabledSource[id] = `config/page-types/${type}.json`;

  return {
    type: type || 'unknown',
    fallback: !known,
    thresholds: { ...(base.thresholds || {}), ...(own.thresholds || {}) },
    checks: {
      disabled: [...new Set([...baseDisabled, ...ownDisabled])],
      disabledSource,
      severity_overrides: {
        ...(base.checks?.severity_overrides || {}),
        ...(own.checks?.severity_overrides || {}),
      },
    },
  };
}

export function delivery() {
  return readJson(configPath('delivery.json'));
}

/**
 * Лимиты проверки ссылок (в т.ч. временные, на время разработки).
 *
 * Списка «наших доменов» здесь нет намеренно: внутренняя ссылка — это ссылка на домен
 * самой страницы, и он известен из её URL. Наши страновые домены друг для друга внешние.
 */
export function scope() {
  const raw = readJson(configPath('scope.json'));
  return {
    development: {
      enabled: Boolean(raw.development?.enabled),
      internal_links_per_page: raw.development?.internal_links_per_page ?? null,
    },
  };
}

/** Действующий лимит на проверку внутренних ссылок или null, если лимита нет. */
export function internalLinkLimit(scopeConf = scope()) {
  return scopeConf.development.enabled ? scopeConf.development.internal_links_per_page : null;
}

/** Записи вида { check, slug, entity, reason }. entity — подстрока или '*'. */
export function ignores() {
  const { ignores: list = [] } = readJson(configPath('ignores.json'));
  return list.filter((i) => i.check && i.slug && i.entity);
}

/** Проверяет kill-switch. Возвращает null или причину, по которой прогон не идёт. */
export function pauseReason(now = new Date()) {
  const { paused_until: until } = readJson(configPath('pause.json'));
  if (!until) return null;
  const ts = new Date(until);
  if (Number.isNaN(ts.getTime())) return `в pause.json нестандартная дата: ${until}`;
  return ts > now ? `прогон на паузе до ${until}` : null;
}
