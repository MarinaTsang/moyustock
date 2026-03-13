(function (global) {
  function renderDebugPanel(options = {}) {
    const debugPanelEl = options.debugPanelEl;
    if (!debugPanelEl) return;

    if (!options.devModeEnabled || !options.debugPanelOpen) {
      debugPanelEl.style.display = 'none';
      return;
    }

    const now = options.nowTs || Date.now();
    const codes = options.codes || [];
    const anomalyMonitor = options.anomalyMonitor;
    const lastStockDataByCode = options.lastStockDataByCode || {};
    const formatChangePct = options.formatChangePct || ((value) => String(value ?? '—'));
    const escapeHtml = options.escapeHtml || ((value) => String(value ?? ''));

    const lines = [];
    const snapshot = anomalyMonitor.getSnapshot();
    lines.push(`<div class="lt-debug-head">state=${escapeHtml(snapshot.state || 'SILENT')} critical=${(snapshot.criticalCodes || []).length} new=${(snapshot.newlyAlertedCodes || []).length}</div>`);
    lines.push('<div class="lt-debug-grid"><div>code</div><div>pct</div><div>critical</div><div>read</div><div>row</div><div>cd(s)</div><div>sustain(s)</div></div>');

    codes.forEach((code) => {
      const debug = anomalyMonitor.getCodeDebug(code, now);
      const stock = lastStockDataByCode[code];
      const pct = stock && stock.ok ? formatChangePct(stock.changePct) : '—';
      lines.push(
        `<div class="lt-debug-grid lt-debug-row"><div>${escapeHtml(code)}</div><div>${escapeHtml(pct)}</div><div>${debug.isCritical ? 'Y' : 'N'}</div><div>${debug.isRead ? 'Y' : 'N'}</div><div>${escapeHtml(debug.rowLevel)}</div><div>${debug.cooldownLeftSec}</div><div>${debug.sustainSec}</div></div>`
      );
    });

    if (codes.length === 0) {
      lines.push('<div class="lt-debug-empty">no stocks</div>');
    }

    debugPanelEl.innerHTML = lines.join('');
    debugPanelEl.style.display = '';
  }

  global.LTPanelView = {
    renderDebugPanel
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
