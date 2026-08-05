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
      return judge(
        [
          {
            entity: 'URL',
            expected: 'валидный URL',
            actual: u.href,
            fix: 'Поправить url страницы в config/pages.json.',
          },
        ],
        this.severity,
      );
    }

    if (u.protocol !== 'https') {
      findings.push({
        entity: 'схема',
        expected: 'https',
        actual: u.protocol,
        severity: 'P1',
        fix: 'Открывать страницу по https и настроить редирект с http.',
      });
    }
    if (u.params.length) {
      findings.push({
        entity: 'параметры',
        expected: 'URL без query-параметров',
        actual: u.params.map((p) => `?${p}`).join(', '),
        fix: 'Убрать query-параметры из адреса страницы.',
      });
    }
    if (u.hash) {
      findings.push({
        entity: 'якорь',
        expected: 'URL без #',
        actual: u.hash,
        severity: 'P3',
        fix: 'Убрать #-якорь из адреса.',
      });
    }
    if (/[A-Z]/.test(u.pathname)) {
      findings.push({
        entity: 'регистр',
        expected: 'путь в нижнем регистре',
        actual: u.pathname,
        severity: 'P3',
        fix: 'Перевести путь в нижний регистр, со старого адреса поставить редирект.',
      });
    }
    if (u.pathname.includes('_')) {
      findings.push({
        entity: 'подчёркивания',
        expected: 'слова разделены дефисом',
        actual: u.pathname,
        severity: 'P3',
        fix: 'Заменить подчёркивания на дефисы, со старого адреса поставить редирект.',
      });
    }
    if (u.pathname.includes('//')) {
      findings.push({
        entity: 'двойной слэш',
        expected: 'один слэш между сегментами',
        actual: u.pathname,
        fix: 'Убрать двойной слэш из пути.',
      });
    }
    if (/%[0-9a-f]{2}/i.test(u.pathname)) {
      findings.push({
        entity: 'экранирование',
        expected: 'путь без %-последовательностей',
        actual: u.pathname,
        severity: 'P3',
        fix: 'Переписать путь латиницей через дефисы, без %-последовательностей.',
      });
    }

    return judge(findings, this.severity);
  },
};
