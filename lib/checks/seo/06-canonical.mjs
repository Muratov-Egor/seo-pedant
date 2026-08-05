import { judge } from '../../verdict.mjs';
import { normUrl } from '../../collect/site.mjs';

/**
 * Как починить canonical, указывающий не туда.
 *
 * Без адресов внутри: в них вся разница между страницами, и с ними у трёх страниц
 * получалось три одинаковых по смыслу блока вместо одного. Сами адреса читаются
 * в таблице — «страница» и «сейчас» стоят рядом. Совет при этом остаётся разным
 * для разных поломок: сменить домен и переписать адрес целиком — не одно и то же.
 */
function fixForAddress(parsed, self) {
  try {
    const own = new URL(self);
    if (parsed.host !== own.host && parsed.pathname === own.pathname) {
      return 'Заменить домен в canonical на домен самой страницы — путь уже верный.';
    }
  } catch {
    // адрес самой страницы не разобрался — остаётся общий совет
  }
  return 'Указать в canonical адрес самой страницы.';
}

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
        [
          {
            entity: 'canonical',
            expected: '<link rel="canonical"> на саму страницу',
            actual: 'тега нет',
            fix: 'Добавить в <head> <link rel="canonical"> с абсолютным адресом самой страницы.',
          },
        ],
        this.severity,
      );
    }

    const findings = [];

    if (canonicalCount > 1) {
      findings.push({
        entity: 'количество',
        expected: 'один canonical',
        actual: `${canonicalCount}`,
        fix: 'Оставить один <link rel="canonical">, лишние убрать.',
      });
    }
    if (!/^https?:\/\//i.test(canonical)) {
      findings.push({
        entity: 'абсолютность',
        expected: 'абсолютный URL',
        actual: canonical,
        severity: 'P2',
        fix: 'Указать в canonical абсолютный URL — со схемой и доменом.',
      });
    }

    let parsed = null;
    try {
      parsed = new URL(canonicalAbs ?? canonical);
    } catch {
      findings.push({
        entity: 'формат',
        expected: 'разбираемый URL',
        actual: canonical,
        fix: 'Поправить значение canonical: сейчас это не разбирается как URL.',
      });
    }

    if (parsed) {
      if (parsed.search) {
        findings.push({
          entity: 'параметры',
          expected: 'canonical без query-параметров',
          actual: parsed.search,
          fix: 'Убрать query-параметры из canonical.',
        });
      }
      const self = f.http.final?.url ?? f.page.url;
      if (normUrl(parsed.toString()) !== normUrl(self)) {
        findings.push({
          entity: 'адрес',
          expected: 'canonical на саму страницу',
          actual: parsed.toString(),
          note: 'Canonical на другой URL исключает эту страницу из индекса в пользу указанной.',
          fix: fixForAddress(parsed, self),
        });
      }
    }

    return judge(findings, this.severity);
  },
};
