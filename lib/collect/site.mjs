// Данные уровня сайта: robots.txt и sitemap.xml. Собираются один раз на хост за прогон,
// потому что для всех страниц они одни и те же.

import { gunzipSync } from 'node:zlib';
import { fetchText, USER_AGENT } from './http.mjs';

// ── robots.txt ──────────────────────────────────────────────────────────────

/** Разбирает robots.txt на группы правил по User-agent плюс список Sitemap. */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();

    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      // Подряд идущие User-agent относятся к одной группе правил.
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      if (!current) {
        current = { agents: ['*'], rules: [] };
        groups.push(current);
      }
      current.rules.push({ type: field, path: value });
    }
    // crawl-delay, clean-param, host — на индексацию конкретного пути не влияют
  }

  return { groups, sitemaps };
}

export function groupFor(parsed, agent = '*') {
  const wanted = agent.toLowerCase();
  return (
    parsed.groups.find((g) => g.agents.includes(wanted)) ??
    parsed.groups.find((g) => g.agents.includes('*')) ??
    null
  );
}

function patternToRegex(pattern) {
  let body = pattern;
  let anchorEnd = false;
  if (body.endsWith('$')) {
    anchorEnd = true;
    body = body.slice(0, -1);
  }
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchorEnd ? '$' : ''}`);
}

/**
 * Разрешён ли путь. Побеждает самое длинное совпавшее правило, при равной длине — Allow.
 * Пустое `Disallow:` означает «разрешено всё» и правилом не считается.
 */
export function robotsDecision(pathname, group) {
  if (!group) return { allowed: true, rule: null };
  let best = null;
  for (const rule of group.rules) {
    if (!rule.path) continue;
    if (!patternToRegex(rule.path).test(pathname)) continue;
    const better =
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.type === 'allow');
    if (better) best = rule;
  }
  return { allowed: !best || best.type === 'allow', rule: best };
}

export async function collectRobots(origin, { timeoutMs = 30_000 } = {}) {
  const res = await fetchText(`${origin}/robots.txt`, { timeoutMs });
  const parsed = res.text ? parseRobots(res.text) : { groups: [], sitemaps: [] };
  return {
    origin,
    url: res.url,
    status: res.status,
    error: res.error,
    text: res.text,
    sitemaps: parsed.sitemaps,
    parsed,
  };
}

// ── sitemap.xml ─────────────────────────────────────────────────────────────

/** Для сравнения URL: регистр хоста и завершающий слэш значения не имеют. */
export function normUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.host = u.host.toLowerCase();
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return String(raw).trim();
  }
}

async function fetchXml(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/xml,text/xml,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { status: res.status, text: null, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const gzipped = buf[0] === 0x1f && buf[1] === 0x8b;
    return { status: res.status, text: (gzipped ? gunzipSync(buf) : buf).toString('utf8'), error: null };
  } catch (err) {
    return { status: null, text: null, error: err.message };
  }
}

function locsOf(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

function isIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

/**
 * Ищет целевые URL в sitemap: индекс → под-сайтмапы, с ранним выходом, как только
 * найдены все цели. Под-сайтмапы по несколько мегабайт, поэтому текст не копится:
 * каждый скачанный файл сканируется и выбрасывается.
 *
 * @param {string[]} targets — искомые URL (обычно запрошенный и итоговый вариант каждой страницы)
 */
export async function collectSitemap(sitemapUrls, targets, { timeoutMs = 60_000, maxFiles = 40 } = {}) {
  const found = new Map(targets.map((t) => [normUrl(t), null]));
  const queue = [...sitemapUrls];
  const seen = new Set(queue);
  const errors = [];
  let filesChecked = 0;
  let filesTotal = queue.length;
  let truncated = false;

  while (queue.length) {
    if (filesChecked >= maxFiles) {
      truncated = true;
      break;
    }
    const url = queue.shift();
    const res = await fetchXml(url, timeoutMs);
    filesChecked++;
    if (!res.text) {
      errors.push(`${url}: ${res.error}`);
      continue;
    }

    if (isIndex(res.text)) {
      for (const loc of locsOf(res.text)) {
        if (seen.has(loc)) continue;
        seen.add(loc);
        queue.push(loc);
        filesTotal++;
      }
      continue;
    }

    for (const loc of locsOf(res.text)) {
      const key = normUrl(loc);
      if (found.has(key) && found.get(key) === null) found.set(key, url);
    }
    if ([...found.values()].every(Boolean)) break;
  }

  return {
    entryPoints: sitemapUrls,
    filesChecked,
    filesTotal,
    truncated,
    errors,
    // { нормализованный URL: под-сайтмап, где он найден, или null }
    found: Object.fromEntries(found),
  };
}
