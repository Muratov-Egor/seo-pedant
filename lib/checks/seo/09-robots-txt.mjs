import { judge, warn } from '../../verdict.mjs';
import { groupFor, robotsDecision } from '../../collect/site.mjs';

export default {
  id: 'robots-txt',
  checklist: 'robots.txt не запрещает путь или URL страницы',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['site'],
  severity: 'P1',

  run(f) {
    const { robots } = f.site;

    if (robots.status !== 200 || !robots.text) {
      return warn({
        entity: 'robots.txt',
        expected: 'robots.txt доступен',
        actual: robots.error ?? `HTTP ${robots.status}`,
        severity: 'P3',
        note: 'Без robots.txt индексация не запрещена, но и правил не видно — проверить нечего.',
      });
    }

    const findings = [];
    const pathname = f.finalUrl.valid ? f.finalUrl.pathname : f.url.pathname;
    const decision = robotsDecision(pathname, groupFor(robots.parsed, '*'));

    if (!decision.allowed) {
      findings.push({
        entity: 'запрет обхода',
        expected: `путь ${pathname} разрешён для User-agent: *`,
        actual: `Disallow: ${decision.rule.path}`,
        evidence: `Disallow: ${decision.rule.path}`,
        note: 'Страница закрыта от обхода в robots.txt — в индекс она не попадёт.',
      });
    }

    if (!robots.sitemaps.length) {
      findings.push({
        entity: 'директива Sitemap',
        expected: 'в robots.txt указан Sitemap',
        actual: 'директивы нет',
        severity: 'P3',
      });
    }

    return judge(findings, this.severity);
  },
};
