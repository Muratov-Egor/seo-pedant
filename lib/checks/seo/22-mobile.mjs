import { judge, skip } from '../../verdict.mjs';

export default {
  id: 'mobile',
  checklist: 'Адаптивность для мобильных устройств',
  family: 'seo-checklist',
  scope: 'page',
  needs: ['mobile'],
  severity: 'P2',

  run(f) {
    const m = f.mobile;
    const findings = [];

    // Страница не открылась в мобильном контексте — измерять нечего. Считать это
    // отсутствием viewport нельзя: так проблема выдумывается из ошибки сбора.
    if (m.error) return skip(`страница не открылась в мобильном браузере: ${m.error}`);

    if (!m.hasViewportMeta) {
      findings.push({
        entity: 'meta viewport',
        expected: '<meta name="viewport" content="width=device-width, ...">',
        actual: 'тега нет',
        severity: 'P1',
        note: 'Без viewport мобильный браузер рисует страницу как десктопную.',
        fix: 'Добавить в <head> <meta name="viewport" content="width=device-width, initial-scale=1">.',
      });
    } else if (!/width\s*=\s*device-width/i.test(m.viewportMeta ?? '')) {
      findings.push({
        entity: 'meta viewport',
        expected: 'width=device-width',
        actual: m.viewportMeta,
        severity: 'P3',
        fix: 'Дописать width=device-width в content у meta viewport.',
      });
    }

    // Пара пикселей — это округление, а не проблема вёрстки.
    if (m.overflowPx > 2) {
      findings.push({
        entity: 'горизонтальный скролл',
        expected: `контент не шире экрана (${m.viewport.width} px)`,
        actual: `${m.scrollWidth} px, вылет ${m.overflowPx} px`,
        evidence: m.overflowingSelectors?.length ? m.overflowingSelectors.join('\n') : null,
        note: 'Скриншот: mobile.png в папке страницы этого прогона.',
        fix: 'Ограничить ширину блоков из подтверждения (max-width, overflow) — сейчас они вылезают за экран.',
      });
    }

    return judge(findings, this.severity);
  },
};
