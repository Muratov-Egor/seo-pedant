import { judge } from '../../verdict.mjs';
import { normUrl } from '../../collect/site.mjs';

export default {
  id: 'canonical',
  checklist: 'Canonical указывает на саму страницу, без параметров',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['html'],
  severity: 'P1',

  run(f) {
    const { canonical, canonicalAbs, canonicalCount } = f.html;

    if (!canonical) {
      return judge(
        [{ entity: 'canonical', expected: '<link rel="canonical"> на саму страницу', actual: 'тега нет' }],
        this.severity,
      );
    }

    const findings = [];

    if (canonicalCount > 1) {
      findings.push({ entity: 'количество', expected: 'один canonical', actual: `${canonicalCount}` });
    }
    if (!/^https?:\/\//i.test(canonical)) {
      findings.push({
        entity: 'абсолютность',
        expected: 'абсолютный URL',
        actual: canonical,
        severity: 'P2',
      });
    }

    let parsed = null;
    try {
      parsed = new URL(canonicalAbs ?? canonical);
    } catch {
      findings.push({ entity: 'формат', expected: 'разбираемый URL', actual: canonical });
    }

    if (parsed) {
      if (parsed.search) {
        findings.push({ entity: 'параметры', expected: 'canonical без query-параметров', actual: parsed.search });
      }
      const self = f.http.final?.url ?? f.page.url;
      if (normUrl(parsed.toString()) !== normUrl(self)) {
        findings.push({
          entity: 'адрес',
          expected: `canonical на саму страницу (${self})`,
          actual: parsed.toString(),
          note: 'Canonical на другой URL исключает эту страницу из индекса в пользу указанной.',
        });
      }
    }

    return judge(findings, this.severity);
  },
};
