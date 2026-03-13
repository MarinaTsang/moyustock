(function (global) {
  function createShell(options = {}) {
    const wrap = document.createElement('div');
    wrap.id = 'lt-stock-float';
    if (options.initiallyHidden) {
      wrap.style.setProperty('display', 'none', 'important');
    }

    wrap.innerHTML = `
      <div class="lt-header">
        <div class="lt-header-left">
          <div class="lt-market-index" id="lt-market-index"></div>
          <div class="lt-stealth-title" id="lt-stealth-title">Tasks</div>
          <span class="lt-mood-dot" id="lt-mood-dot"></span>
          <button type="button" class="lt-btn lt-btn-save" id="lt-btn-save" title="保存并返回" style="display:none">保存</button>
        </div>
        <div class="lt-header-right">
          <button type="button" class="lt-btn lt-btn-debug" id="lt-btn-debug" title="调试面板" style="display:none">DBG</button>
          <button type="button" class="lt-btn lt-btn-close" title="关闭">×</button>
        </div>
      </div>
      <div class="lt-body">
        <div class="lt-tip" id="lt-tip" style="display:none">在扩展图标弹窗中添加自选股票</div>
        <div class="lt-mode-toggle" id="lt-mode-toggle">
          <button type="button" class="lt-mode-option is-active" id="lt-mode-normal">Normal</button>
          <button type="button" class="lt-mode-option" id="lt-mode-stealth">Stealth</button>
        </div>
        <div class="lt-stock-panel" id="lt-stock-panel">
          <div class="lt-stock-list-viewport" id="lt-stock-list-viewport">
            <div class="lt-stock-list" id="lt-stock-list"></div>
          </div>
        </div>
        <div class="lt-ai-summary" id="lt-ai-summary" style="display:none"></div>
        <div class="lt-critical-hint" id="lt-critical-hint" style="display:none">有股票涨跌超 3%，建议抽空看一下</div>
        <div class="lt-debug-panel" id="lt-debug-panel" style="display:none"></div>
      </div>
    `;

    document.body.appendChild(wrap);
    return {
      wrap,
      refs: {
        viewportEl: wrap.querySelector('#lt-stock-list-viewport'),
        listEl: wrap.querySelector('#lt-stock-list'),
        stockPanel: wrap.querySelector('#lt-stock-panel'),
        modeNormalBtn: wrap.querySelector('#lt-mode-normal'),
        modeStealthBtn: wrap.querySelector('#lt-mode-stealth'),
        btnDebug: wrap.querySelector('#lt-btn-debug'),
        btnClose: wrap.querySelector('.lt-btn-close'),
        marketIndexEl: wrap.querySelector('#lt-market-index'),
        tipEl: wrap.querySelector('#lt-tip'),
        aiSummaryEl: wrap.querySelector('#lt-ai-summary'),
        criticalHintEl: wrap.querySelector('#lt-critical-hint'),
        debugPanelEl: wrap.querySelector('#lt-debug-panel')
      }
    };
  }

  function normalizeRowId(code, idx, blankCode) {
    if (code === blankCode) return 'blank-' + (idx ?? 0);
    return String(code || '').replace(/[^a-zA-Z0-9-_]/g, '_');
  }

  function createCodeRow(code, idx, blankCode) {
    const rowId = normalizeRowId(code, idx, blankCode);
    const row = document.createElement('div');
    row.className = code === blankCode ? 'lt-stock-row lt-row-blank' : 'lt-stock-row';
    row.id = 'lt-row-' + rowId;
    row.dataset.code = code;
    row.innerHTML = `
      <span class="lt-name" id="lt-name-${rowId}">${code === blankCode ? '—' : '加载中…'}</span>
      <span class="lt-stealth-task" id="lt-task-${rowId}">${code === blankCode ? '—' : 'research'}</span>
      <span class="lt-price" id="lt-price-${rowId}">—</span>
      <span class="lt-change" id="lt-change-${rowId}">—</span>
      <div class="lt-trend" id="lt-trend-${rowId}"></div>
    `;
    return row;
  }

  function createIndexedRow(index) {
    const row = document.createElement('div');
    row.className = 'lt-stock-row';
    row.id = 'lt-row-' + index;
    row.innerHTML = `
      <span class="lt-name" id="lt-name-${index}">加载中…</span>
      <span class="lt-stealth-task" id="lt-task-${index}">research</span>
      <span class="lt-price" id="lt-price-${index}">—</span>
      <span class="lt-change" id="lt-change-${index}">—</span>
      <div class="lt-trend" id="lt-trend-${index}"></div>
    `;
    return row;
  }

  function createPrefixedRow(prefix, index) {
    const row = document.createElement('div');
    row.className = 'lt-stock-row';
    row.id = prefix + '-' + index;
    row.innerHTML = `
      <span class="lt-name" id="lt-name-${prefix}-${index}">加载中…</span>
      <span class="lt-stealth-task" id="lt-task-${prefix}-${index}">research</span>
      <span class="lt-price" id="lt-price-${prefix}-${index}">—</span>
      <span class="lt-change" id="lt-change-${prefix}-${index}">—</span>
      <div class="lt-trend" id="lt-trend-${prefix}-${index}"></div>
    `;
    return row;
  }

  function getCodeRowRefs(code, blankCode) {
    if (code === blankCode) return null;
    const rowId = normalizeRowId(code, 0, blankCode);
    return {
      nameEl: document.getElementById('lt-name-' + rowId),
      taskEl: document.getElementById('lt-task-' + rowId),
      priceEl: document.getElementById('lt-price-' + rowId),
      changeEl: document.getElementById('lt-change-' + rowId),
      trendEl: document.getElementById('lt-trend-' + rowId),
      rowEl: document.getElementById('lt-row-' + rowId)
    };
  }

  function getIndexedRowRefs(index) {
    return {
      nameEl: document.getElementById('lt-name-' + index),
      taskEl: document.getElementById('lt-task-' + index),
      priceEl: document.getElementById('lt-price-' + index),
      changeEl: document.getElementById('lt-change-' + index),
      trendEl: document.getElementById('lt-trend-' + index),
      rowEl: document.getElementById('lt-row-' + index)
    };
  }

  function getPrefixedRowRefs(prefix, index) {
    return {
      nameEl: document.getElementById('lt-name-' + prefix + '-' + index) || document.getElementById('lt-name-' + index),
      taskEl: document.getElementById('lt-task-' + prefix + '-' + index) || document.getElementById('lt-task-' + index),
      priceEl: document.getElementById('lt-price-' + prefix + '-' + index) || document.getElementById('lt-price-' + index),
      changeEl: document.getElementById('lt-change-' + prefix + '-' + index) || document.getElementById('lt-change-' + index),
      trendEl: document.getElementById('lt-trend-' + prefix + '-' + index) || document.getElementById('lt-trend-' + index),
      rowEl: document.getElementById(prefix + '-' + index) || document.getElementById('lt-row-' + index)
    };
  }

  function renumberIndexedRows(listEl) {
    const kept = listEl.querySelectorAll('.lt-stock-row');
    kept.forEach((row, index) => {
      row.id = 'lt-row-' + index;
      row.querySelector('.lt-name').id = 'lt-name-' + index;
      row.querySelector('.lt-stealth-task').id = 'lt-task-' + index;
      row.querySelector('.lt-price').id = 'lt-price-' + index;
      row.querySelector('.lt-change').id = 'lt-change-' + index;
      const trendEl = row.querySelector('.lt-trend');
      if (trendEl) trendEl.id = 'lt-trend-' + index;
    });
  }

  function setPresenceState(wrap, state, options = {}) {
    wrap.classList.remove('lt-state-silent', 'lt-state-active', 'lt-state-critical', 'lt-critical-down');
    if (state === 'SILENT') {
      wrap.classList.add('lt-state-silent');
      return;
    }
    if (state === 'ACTIVE') {
      wrap.classList.add('lt-state-active');
      return;
    }
    if (state === 'CRITICAL') {
      wrap.classList.add('lt-state-critical');
      if (options.criticalDown) {
        wrap.classList.add('lt-critical-down');
      }
    }
  }

  function setDisplayMode(wrap, mode) {
    if (!wrap) return;
    wrap.classList.remove('lt-mode-normal', 'lt-mode-stealth');
    wrap.classList.add(mode === 'stealth' ? 'lt-mode-stealth' : 'lt-mode-normal');
  }

  function setModeToggleState(normalBtn, stealthBtn, mode) {
    if (normalBtn) normalBtn.classList.toggle('is-active', mode !== 'stealth');
    if (stealthBtn) stealthBtn.classList.toggle('is-active', mode === 'stealth');
  }

  function renderTip(tipEl, options = {}) {
    const stockList = options.stockList || [];
    const defaultStock = options.defaultStock;
    const rotateCount = options.rotateCount || 0;
    const tradingCount = options.tradingCount || 0;

    if (!tipEl) return;

    if (stockList.length === 1 && stockList[0] === defaultStock) {
      tipEl.textContent = '在扩展图标弹窗中添加自选股票';
      tipEl.style.display = '';
      return;
    }

    if (rotateCount > 0 && tradingCount === 0) {
      tipEl.textContent = '暂无交易中的股票';
      tipEl.style.display = '';
      return;
    }

    tipEl.style.display = 'none';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  global.LTWidgetView = {
    createShell,
    createCodeRow,
    createIndexedRow,
    createPrefixedRow,
    getCodeRowRefs,
    getIndexedRowRefs,
    getPrefixedRowRefs,
    renumberIndexedRows,
    setPresenceState,
    setDisplayMode,
    setModeToggleState,
    renderTip,
    escapeHtml
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
