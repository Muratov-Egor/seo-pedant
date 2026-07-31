// Браузерный слой: то, чего не видно в HTML от сервера.
//
// Собирает три артефакта на страницу:
//   dom.html.gz    — HTML после гидрации; проверка ssr сравнивает факты из него и из raw.html
//   console.json   — JS-ошибки и неудачные запросы за время загрузки
//   mobile.json    — метрики мобильного viewport + скриншот
// и, если не выключено, отчёт Lighthouse.
//
// Браузер один на весь прогон, контекст — на страницу. Один и тот же экземпляр отдаёт
// CDP-порт для Lighthouse, чтобы не поднимать второй Chrome.

import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';
import { ARTIFACTS, pageDir, writeArtifact } from '../bundle.mjs';
import { USER_AGENT } from './http.mjs';
import { runLighthouse } from './lighthouse.mjs';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE = devices['iPhone 13'];
const GOTO_TIMEOUT = 60_000;
const IDLE_TIMEOUT = 15_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Ждём тишины в сети, но не падаем, если её так и не наступило: страница живая. */
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT }).catch(() => {});
}

/**
 * Одна повторная попытка навигации. Страницы тяжёлые и под нагрузкой иногда не
 * укладываются в таймаут; без повтора это превращается в «проверка не выполнялась»
 * на случайных страницах случайных прогонов.
 */
async function goto(page, url) {
  try {
    return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT });
  } catch (first) {
    await page.waitForTimeout(2000);
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT });
    } catch {
      throw first;
    }
  }
}

async function collectRendered(browser, runId, meta, url) {
  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    locale: 'ru-RU',
    userAgent: USER_AGENT,
  });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const requestFailures = [];

  page.on('pageerror', (err) => pageErrors.push({ message: err.message, stack: err.stack ?? null }));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = msg.location();
    consoleErrors.push({
      text: msg.text(),
      location: loc?.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : null,
    });
  });
  page.on('response', (res) => {
    if (res.status() < 400) return;
    failedRequests.push({
      url: res.url(),
      status: res.status(),
      resourceType: res.request().resourceType(),
    });
  });
  page.on('requestfailed', (req) => {
    requestFailures.push({ url: req.url(), error: req.failure()?.errorText ?? 'неизвестно' });
  });

  let navigationError = null;
  try {
    await goto(page, url);
    await settle(page);
    writeArtifact(runId, meta.slug, ARTIFACTS.domHtml, await page.content());
  } catch (err) {
    navigationError = err.message;
  }

  writeArtifact(runId, meta.slug, ARTIFACTS.console, {
    url,
    collected_at: new Date().toISOString(),
    navigation_error: navigationError,
    pageErrors,
    consoleErrors,
    failedRequests,
    requestFailures,
  });

  await context.close();
  return { navigationError, errors: pageErrors.length, failed: failedRequests.length };
}

async function collectMobile(browser, runId, meta, url) {
  const context = await browser.newContext({ ...MOBILE, locale: 'ru-RU' });
  const page = await context.newPage();
  try {
    await goto(page, url);
    await settle(page);

    const measured = await page.evaluate(() => {
      const de = document.documentElement;
      const clientWidth = de.clientWidth;
      const scrollWidth = Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0);

      // Кто именно вылезает за экран — иначе находка «есть скролл» ничего не даёт.
      const offenders = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right <= clientWidth + 2) continue;
        const classes =
          typeof el.className === 'string' && el.className.trim()
            ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
            : '';
        offenders.push(
          `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classes} → правый край ${Math.round(r.right)}px`,
        );
        if (offenders.length >= 5) break;
      }

      const vp = document.querySelector('meta[name="viewport"]');
      return {
        clientWidth,
        scrollWidth,
        hasViewportMeta: Boolean(vp),
        viewportMeta: vp?.getAttribute('content') ?? null,
        offenders,
      };
    });

    await page.screenshot({
      path: join(pageDir(runId, meta.slug), ARTIFACTS.screenshot),
      fullPage: false,
    });

    writeArtifact(runId, meta.slug, ARTIFACTS.mobile, {
      viewport: { width: MOBILE.viewport.width, height: MOBILE.viewport.height },
      device: 'iPhone 13',
      hasViewportMeta: measured.hasViewportMeta,
      viewportMeta: measured.viewportMeta,
      clientWidth: measured.clientWidth,
      scrollWidth: measured.scrollWidth,
      overflowPx: Math.max(0, measured.scrollWidth - measured.clientWidth),
      overflowingSelectors: measured.offenders,
    });

    return { overflowPx: Math.max(0, measured.scrollWidth - measured.clientWidth) };
  } catch (err) {
    writeArtifact(runId, meta.slug, ARTIFACTS.mobile, {
      viewport: { width: MOBILE.viewport.width, height: MOBILE.viewport.height },
      device: 'iPhone 13',
      error: err.message,
      hasViewportMeta: null,
      viewportMeta: null,
      overflowPx: 0,
      overflowingSelectors: [],
    });
    return { error: err.message };
  } finally {
    await context.close();
  }
}

export async function collectBrowser(runId, collected, { log = () => {}, lighthouse = true } = {}) {
  const port = await freePort();
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  log(`  браузер запущен, CDP-порт ${port}`);

  try {
    for (const { meta } of collected) {
      const url = meta.http.final?.url ?? meta.url;
      if (!meta.http.final || meta.http.error) {
        log(`  ${meta.slug}: браузер пропущен — страница не открылась по HTTP`);
        continue;
      }

      const rendered = await collectRendered(browser, runId, meta, url);
      const mobile = await collectMobile(browser, runId, meta, url);
      log(
        `  ${meta.slug}: DOM ${rendered.navigationError ? `ошибка (${rendered.navigationError})` : 'снят'}, ` +
          `JS-ошибок ${rendered.errors}, неудачных запросов ${rendered.failed}, ` +
          `вылет по ширине ${mobile.error ? `ошибка (${mobile.error})` : `${mobile.overflowPx}px`}`,
      );

      if (lighthouse) {
        writeArtifact(runId, meta.slug, ARTIFACTS.lighthouse, await runLighthouse(url, port, log));
      }
    }
  } finally {
    await browser.close();
  }
}
