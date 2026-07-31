import { judge } from '../../verdict.mjs';

export default {
  id: 'url-clean',
  checklist: 'URL человекочитаемый, без параметров',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['response'],
  severity: 'P2',

  run(f) {
    const u = f.url;
    const findings = [];

    if (!u.valid) {
      return judge([{ entity: 'URL', expected: 'валидный URL', actual: u.href }], this.severity);
    }

    if (u.protocol !== 'https') {
      findings.push({ entity: 'схема', expected: 'https', actual: u.protocol, severity: 'P1' });
    }
    if (u.params.length) {
      findings.push({
        entity: 'параметры',
        expected: 'URL без query-параметров',
        actual: u.params.map((p) => `?${p}`).join(', '),
      });
    }
    if (u.hash) {
      findings.push({ entity: 'якорь', expected: 'URL без #', actual: u.hash, severity: 'P3' });
    }
    if (/[A-Z]/.test(u.pathname)) {
      findings.push({
        entity: 'регистр',
        expected: 'путь в нижнем регистре',
        actual: u.pathname,
        severity: 'P3',
      });
    }
    if (u.pathname.includes('_')) {
      findings.push({
        entity: 'подчёркивания',
        expected: 'слова разделены дефисом',
        actual: u.pathname,
        severity: 'P3',
      });
    }
    if (u.pathname.includes('//')) {
      findings.push({ entity: 'двойной слэш', expected: 'один слэш между сегментами', actual: u.pathname });
    }
    if (/%[0-9a-f]{2}/i.test(u.pathname)) {
      findings.push({
        entity: 'экранирование',
        expected: 'путь без %-последовательностей',
        actual: u.pathname,
        severity: 'P3',
      });
    }

    return judge(findings, this.severity);
  },
};
