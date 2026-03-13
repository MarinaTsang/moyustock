/**
 * Content Script：注入到每个网页中，负责右下角股票浮窗的完整逻辑。
 *
 * 运行环境：在用户打开的网页里执行，可操作当前页的 DOM（document），也可调 chrome.storage / chrome.runtime。
 * 与页面自己的 JS 隔离（不能直接访问页面变量），类似在页面里嵌了一个“小应用”。
 *
 * 结构：IIFE 立即执行函数，避免全局变量污染页面。
 * 入口：页面加载完成后 maybeCreateWidget()；或收到 SHOW_FLOAT 消息时 createWidget()。
 */
(function () {
  const BOOTSTRAP_KEY = '__LT_STOCK_FLOAT_BOOTSTRAPPED__';
  if (globalThis[BOOTSTRAP_KEY]) return;

  const shared = globalThis.LTShared;
  const market = globalThis.LTMarket;
  const trend = globalThis.LTTrend;
  const widgetView = globalThis.LTWidgetView;
  const panelView = globalThis.LTPanelView;
  const carouselView = globalThis.LTCarouselView;
  if (!shared) {
    console.error('[lt] LTShared 未加载，跳过浮窗初始化');
    return;
  }
  if (!market || !trend || !widgetView || !panelView || !carouselView) {
    console.error('[lt] 市场、趋势、视图或控制模块未加载，跳过浮窗初始化');
    return;
  }
  globalThis[BOOTSTRAP_KEY] = true;

  // ========== 一、常量 ==========
  const REFRESH_SEC = 2;                         // 定时刷新间隔（秒）
  const ROTATE_INTERVAL = 5000;                  // 轮播间隔（毫秒），每 5 秒切换一屏
  const MAX_DISPLAY = 3;                         // 最多显示 3 行；>3 只时定高 3 行 + 循环轮播
  const BLANK_CODE = '__BLANK__';                // 空白占位（轮播补位用）
  const STORAGE_KEY = 'lt-stock-float-pos';     // localStorage key：浮窗位置
  const BOSS_KEY_STORAGE = 'userHidden';        // chrome.storage key：老板键/关闭键隐藏状态，跨标签同步
  const USER_HIDE_DATE_KEY = 'ltUserHideDate';  // chrome.storage key：用户最近一次主动关闭的日期（YYYY-MM-DD）
  const USER_SHOWED_KEY = 'ltUserShowed';       // chrome.storage key：非交易时段用户主动显示的日期
  const DISPLAY_MODE_STORAGE = 'displayMode';   // chrome.storage key：normal / stealth
  const DEFAULT_STOCK = 'sh600519';
  const MARKET_INDEX_CODE = 'sh000001';         // 上证指数，标题栏常驻，不参与列表轮播
  const ROW_STEP_PX = 40;                       // 单行高度（px）：grid-row1=22 + grid-row2=14 + gap=4 = 40
  const DEV_MODE_KEY = 'lt-dev-mode';           // 本地开发模式开关（1=启用）
  const DEV_DEBUG_OPEN_KEY = 'lt-dev-debug-open'; // 调试面板开关（1=展开）
  // 存在感三态（见 doc/PRESENCE_STATES_DESIGN.md）
  const PRESENCE_CRITICAL_THRESHOLD = 3.0;      // 关键态阈值：涨跌幅 ±3%
  const PRESENCE_CRITICAL_DURATION_SEC = 10;    // 关键态持续秒数
  const CRITICAL_DECAY_SEC = 20;                // 关键态降级：超过此秒数视为“已读”，恢复普通轮播
  const CRITICAL_COOLDOWN_SEC = 300;            // 同一股票提醒冷却：5 分钟
  const WORKDAY_START_MIN = 9 * 60;             // 工作时间 09:00
  const WORKDAY_END_MIN = 18 * 60;              // 工作时间 18:00
  const PRICE_HISTORY_KEY = 'lt-price-history-v1'; // chrome.storage.local 分时价格历史持久化键
  const AI_SUMMARY_READ_KEY = 'lt-read-ai-summary-v1'; // 当日已读 AI 摘要
  const AI_SUMMARY_TRIGGER_PCT = 5.0;           // 触发 AI 摘要阈值：涨跌幅绝对值 > 5%
  const AI_SUMMARY_COOLDOWN_MS = 30 * 60 * 1000; // AI 摘要冷却：30 分钟
  const CAROUSEL_OFFSET_KEY = 'lt-carousel-offset'; // chrome.storage key：轮播偏移量持久化，跨页面刷新恢复位置

  // ========== 二、模块级状态（整个 content 脚本内共享） ==========
  let stockList = [];              // 当前自选股 code 列表，与 chrome.storage.local 同步
  let cycleOffset = 0;             // 轮播起始下标：(cycleOffset + i) % list.length
  let currentDisplayCodes = [];    // 当前 DOM 里显示的 code 列表，用于判断是否需要重建行
  let currentIsOverMax = null;     // 当前 DOM 结构模式：null=未初始化, true=索引行模式, false=代码行模式
  let refreshTimer = null;         // 定时刷新定时器（每 REFRESH_SEC 秒调 updateDisplay）
  let rotateTimer = null;         // 轮播定时器（每 ROTATE_INTERVAL 调 rotateAndUpdate）
  let widgetCreated = false;      // 是否已创建过浮窗（防止重复创建）
  let rotationPaused = false;     // 鼠标悬停时暂停轮播翻页（定时器不停，仅跳过翻页）
  let widgetCleanup = null;       // 当前浮窗实例绑定的全局监听器清理器
  let triggerShow = null;         // 由 createWidget 内部设置，供外部直接唤起浮窗显示

  // 比较两个数组是否逐项相等（用于判断“当前显示的股票”是否变化，决定是否重建 DOM）
  function arraysEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** 将用户输入规范为带交易所前缀的 code，如 600519 -> sh600519，TSLA -> usTSLA */
  function normalizeStockCode(input) {
    return shared.normalizeStockCode(input);
  }

  /** 返回当前是否有任意一只自选股在交易时间内（列表为空时兜底用上证指数判断） */
  function isAnyInTradingNow() {
    const now = new Date();
    const codes = stockList.length > 0 ? stockList : [MARKET_INDEX_CODE];
    return codes.some((code) => market.isInTradingTime(code, now));
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  // ========== 三、浮窗创建与 DOM ==========
  /**
   * 创建浮窗：只执行一次。先读 storage 中的老板键状态，再创建根节点并挂到 document.body。
   * 后续所有“列表、大盘、设置、拖拽、定时器”都在这个根节点内完成。
   */
  function createWidget() {
    if (widgetCreated || document.getElementById('lt-stock-float')) {
      return;
    }
    if (widgetCleanup) {
      widgetCleanup();
      widgetCleanup = null;
    }
    widgetCreated = true;
    // 重置 DOM 状态跟踪，确保新浮窗实例始终重建 DOM
    currentDisplayCodes = [];
    currentIsOverMax = null;

    // 先读状态，再创建 DOM，这样刷新页面后能恢复正确的显示/隐藏状态
    chrome.storage.local.get([BOSS_KEY_STORAGE, USER_HIDE_DATE_KEY, USER_SHOWED_KEY, DISPLAY_MODE_STORAGE, PRICE_HISTORY_KEY, AI_SUMMARY_READ_KEY, CAROUSEL_OFFSET_KEY], (result) => {
      // 交易时间：默认显示，除非用户今天主动关闭过
      // 非交易时间：默认隐藏，除非用户今天主动显示过
      const today = todayStr();
      const hiddenToday = !!result[BOSS_KEY_STORAGE] && result[USER_HIDE_DATE_KEY] === today;
      const showedToday = result[USER_SHOWED_KEY] === today;
      const inTrading = isAnyInTradingNow();
      const initiallyHidden = inTrading ? hiddenToday : !showedToday;

      let displayMode = result[DISPLAY_MODE_STORAGE] === 'stealth' ? 'stealth' : 'normal';
      // 恢复上次的轮播位置，刷新页面后继续从同一页开始
      if (typeof result[CAROUSEL_OFFSET_KEY] === 'number') {
        cycleOffset = result[CAROUSEL_OFFSET_KEY];
      }
      let isAppHidden = initiallyHidden;

      // 交易状态跟踪（用于检测交易/非交易时段切换，自动显示/隐藏）
      let lastTradingState = null; // 在 loadStockListFromStorage 回调中初始化

      const shell = widgetView.createShell({ initiallyHidden });
      const wrap = shell.wrap;

      // 供外部（SHOW_FLOAT 消息处理器）直接唤起显示
      triggerShow = () => {
        if (!isAppHidden) return;
        isAppHidden = false;
        wrap.style.removeProperty('display');
        rotationPaused = false;
        updateDisplay(true).then(() => { setupRotation(); setTimeout(setupRotation, 150); });
      };
      const {
        viewportEl,
        listEl,
        stockPanel,
        modeNormalBtn,
        modeStealthBtn,
        btnDebug,
        btnClose,
        marketIndexEl,
        tipEl,
        aiSummaryEl,
        criticalHintEl,
        debugPanelEl
      } = shell.refs;
      const cleanupFns = [];
      const addCleanup = (fn) => {
        cleanupFns.push(fn);
        return fn;
      };
      const cleanupCurrentWidget = () => {
        while (cleanupFns.length > 0) {
          const fn = cleanupFns.pop();
          try { fn(); } catch (_) { }
        }
        if (trendPersistTimer) {
          clearTimeout(trendPersistTimer);
          trendPersistTimer = null;
        }
        if (criticalHintTimer) {
          clearTimeout(criticalHintTimer);
          criticalHintTimer = null;
        }
      };
      widgetCleanup = cleanupCurrentWidget;
      // 三态状态机相关（仅在该浮窗作用域内生效）
      let presenceState = 'SILENT';                // 当前存在感状态：SILENT / ACTIVE / CRITICAL
      let presenceCriticalStocks = {};             // 当前关键态股票：{ code: { changePct } }
      let anomalySnapshot = { state: 'SILENT', criticalCodes: [], newlyAlertedCodes: [] };
      let lastStockDataByCode = {};                // 最近一次成功的股票数据快照：{ code: { ok, changePct, ... } }
      let aiSummaryByCode = {};                    // AI 摘要缓存：{ code: { lines, fetchedAt, status } }
      let currentAiSummaryCode = '';
      let aiSummaryReadDay = '';
      let aiSummaryReadByCode = {};                // 当日已读 AI 摘要：{ code: true }
      let criticalHintTimer = null;                // 关键态软提醒定时器
      let rotationInProgress = false;              // 轮播动画进行中，避免刷新与动画抢占 DOM
      let trendPersistTimer = null;                // 分时历史持久化防抖
      let devModeEnabled = false;
      let debugPanelOpen = false;

      function applyDisplayMode(mode) {
        displayMode = mode === 'stealth' ? 'stealth' : 'normal';
        widgetView.setDisplayMode(wrap, displayMode);
        widgetView.setModeToggleState(modeNormalBtn, modeStealthBtn, displayMode);
        if (displayMode === 'stealth' && criticalHintEl) {
          criticalHintEl.style.display = 'none';
        }
        renderAiSummary(currentDisplayCodes);
      }

      applyDisplayMode(displayMode);

      /** 获取今日交易日 key（格式 YYYY-MM-DD） */
      function getTradingDayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      function loadAiSummaryReadState(storageValue) {
        aiSummaryReadDay = getTradingDayKey();
        const stored = storageValue && typeof storageValue === 'object' ? storageValue : {};
        if (stored.day === aiSummaryReadDay && stored.codes && typeof stored.codes === 'object') {
          aiSummaryReadByCode = stored.codes;
        } else {
          aiSummaryReadByCode = {};
        }
      }

      function ensureAiSummaryReadDay() {
        const day = getTradingDayKey();
        if (aiSummaryReadDay === day) return;
        aiSummaryReadDay = day;
        aiSummaryReadByCode = {};
      }

      function persistAiSummaryReadState() {
        ensureAiSummaryReadDay();
        chrome.storage.local.set({
          [AI_SUMMARY_READ_KEY]: {
            day: aiSummaryReadDay,
            codes: aiSummaryReadByCode
          }
        });
      }

      function markAiSummaryRead(code) {
        ensureAiSummaryReadDay();
        if (!code || aiSummaryReadByCode[code]) return false;
        aiSummaryReadByCode[code] = true;
        persistAiSummaryReadState();
        return true;
      }

      function hideAiSummary() {
        currentAiSummaryCode = '';
        if (!aiSummaryEl) return;
        aiSummaryEl.style.display = 'none';
        aiSummaryEl.innerHTML = '';
        delete aiSummaryEl.dataset.code;
      }

      function dismissAiSummary(code) {
        if (!code) return false;
        const changed = markAiSummaryRead(code);
        if (currentAiSummaryCode === code) {
          hideAiSummary();
        }
        return changed;
      }

      loadAiSummaryReadState(result[AI_SUMMARY_READ_KEY]);

      function readDevModeFlag() {
        try { return localStorage.getItem(DEV_MODE_KEY) === '1'; } catch (_) { return false; }
      }

      function readDebugPanelOpenFlag() {
        try { return localStorage.getItem(DEV_DEBUG_OPEN_KEY) === '1'; } catch (_) { return false; }
      }

      function saveDebugPanelOpenFlag(open) {
        try { localStorage.setItem(DEV_DEBUG_OPEN_KEY, open ? '1' : '0'); } catch (_) { }
      }

      function setDevModeFlag(enabled) {
        try { localStorage.setItem(DEV_MODE_KEY, enabled ? '1' : '0'); } catch (_) { }
      }

      const anomalyMonitor = window.LTAnomalyMonitor && window.LTAnomalyMonitor.create({
        threshold: PRESENCE_CRITICAL_THRESHOLD,
        sustainSec: PRESENCE_CRITICAL_DURATION_SEC,
        cooldownSec: CRITICAL_COOLDOWN_SEC,
        decaySec: CRITICAL_DECAY_SEC,
        getDayKey: getTradingDayKey,
        storageKey: 'lt-read-criticals-v2'
      });
      if (!anomalyMonitor) {
        console.error('[lt] anomalyMonitor 未加载，跳过浮窗初始化');
        cleanupCurrentWidget();
        widgetCleanup = null;
        wrap.remove();
        widgetCreated = false;
        return;
      }
      devModeEnabled = readDevModeFlag();
      debugPanelOpen = devModeEnabled && readDebugPanelOpenFlag();
      updateDevDebugUI();

      /**
       * 请求单只股票行情：通过 chrome.runtime.sendMessage 发给 background，由 background 请求 qt.gtimg.cn 后返回。
       * 返回 Promise，resolve 得到 { ok, name, price, changePct, suspended, error? }。
       */
      function fetchStock(code) {
        return shared.fetchStockViaRuntime(code);
      }

      function shouldRequestAiSummary(code, data, nowTs = Date.now()) {
        ensureAiSummaryReadDay();
        const pct = parseFloat(data && data.changePct);
        if (!data || !data.ok || data.suspended || isNaN(pct) || Math.abs(pct) <= AI_SUMMARY_TRIGGER_PCT) {
          return false;
        }
        if (aiSummaryReadByCode[code]) return false;
        const cached = aiSummaryByCode[code];
        if (!cached) return true;
        if (cached.status === 'pending') return false;
        if (cached.fetchedAt && (nowTs - cached.fetchedAt) < AI_SUMMARY_COOLDOWN_MS) return false;
        return true;
      }

      function renderAiSummary(displayCodes) {
        ensureAiSummaryReadDay();
        if (!aiSummaryEl) return;
        if (displayMode === 'stealth') {
          hideAiSummary();
          return;
        }

        const code = (displayCodes || []).find((item) => {
          const summary = aiSummaryByCode[item];
          return !aiSummaryReadByCode[item] && summary && summary.status === 'ready' && Array.isArray(summary.lines) && summary.lines.length > 0;
        });

        if (!code) {
          hideAiSummary();
          return;
        }

        const stock = lastStockDataByCode[code] || {};
        const summary = aiSummaryByCode[code];
        const stockLabel = widgetView.escapeHtml(stock.name || code);
        const bullets = summary.lines.map((line) => `<li class="lt-ai-summary-item">${widgetView.escapeHtml(line)}</li>`).join('');
        aiSummaryEl.innerHTML = `
          <div class="lt-ai-summary-title">Possible reasons:</div>
          <div class="lt-ai-summary-stock">${stockLabel}</div>
          <ul class="lt-ai-summary-list">${bullets}</ul>
        `;
        currentAiSummaryCode = code;
        aiSummaryEl.dataset.code = code;
        aiSummaryEl.style.display = '';
      }

      function maybeRequestAiSummaries(displayCodes) {
        const nowTs = Date.now();
        (displayCodes || []).forEach((code) => {
          const data = lastStockDataByCode[code];
          if (!shouldRequestAiSummary(code, data, nowTs)) return;
          aiSummaryByCode[code] = { status: 'pending', fetchedAt: nowTs, lines: [] };
          fetchAiSummary(code, data).then((res) => {
            if (res && res.ok && Array.isArray(res.lines) && res.lines.length > 0) {
              aiSummaryByCode[code] = { status: 'ready', fetchedAt: Date.now(), lines: res.lines, headlines: res.headlines || [] };
            } else {
              aiSummaryByCode[code] = { status: 'error', fetchedAt: Date.now(), lines: [], error: res && res.error ? res.error : 'summary-failed' };
            }
            renderAiSummary(currentDisplayCodes);
          }).catch((err) => {
            aiSummaryByCode[code] = { status: 'error', fetchedAt: Date.now(), lines: [], error: err && err.message ? err.message : 'summary-failed' };
            renderAiSummary(currentDisplayCodes);
          });
        });
      }

      function fetchAiSummary(code, data) {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'GET_AI_STOCK_SUMMARY',
            code,
            name: data && data.name ? data.name : code,
            changePct: data && data.changePct ? data.changePct : '0'
          }, (res) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(res || { ok: false, error: 'unknown-summary-error' });
          });
        });
      }

      // ========== 2.5 分时走势逻辑（自维护价格历史） ==========
      const trendTracker = trend.createTracker({ market, maxPoints: 900, sampleBucketMin: 5 });

      function persistTrendHistorySoon() {
        if (trendPersistTimer) clearTimeout(trendPersistTimer);
        trendPersistTimer = setTimeout(() => {
          trendPersistTimer = null;
          chrome.storage.local.set({ [PRICE_HISTORY_KEY]: trendTracker.exportState() });
        }, 120);
      }

      if (result[PRICE_HISTORY_KEY]) {
        trendTracker.importState(result[PRICE_HISTORY_KEY]);
      }

      /** 格式化涨跌幅文本，保证 0 也能正确显示 */
      function formatChangePct(changePct) {
        const n = parseFloat(changePct);
        if (isNaN(n)) return '—';
        const sign = n > 0 ? '+' : (n < 0 ? '-' : '');
        const abs = Math.abs(n).toFixed(2);
        return sign + abs + '%';
      }

      /** setRowContent 核心 —— 将数据写入 DOM 元素 */
      function getStealthTaskLabel(code, data) {
        const normalizedCode = String(code || '').replace(/^(sh|sz|bj|hk|us)/i, '');
        const label = normalizedCode || (data && data.name) || 'Task';
        return `${label.toUpperCase()} research`;
      }

      function setRowContent(rowEl, nameEl, taskEl, priceEl, changeEl, trendEl, code, data) {
        rowEl.dataset.code = code; // 保证 hover 时能读取 code
        if (!data || !data.ok) {
          nameEl.textContent = (code && code.length > 5) ? code.slice(0, 5) + '…' : (code || '—');
          if (taskEl) taskEl.textContent = getStealthTaskLabel(code, data);
          priceEl.textContent = '';
          changeEl.textContent = (data && data.error) || '网络重连中…';
          rowEl.className = 'lt-stock-row lt-error';
          priceEl.className = 'lt-price';
          changeEl.className = 'lt-change';
          trendEl.innerHTML = '';
          return;
        }
        const name = (data.name || '—').trim();
        if (taskEl) taskEl.textContent = getStealthTaskLabel(code, data);
        const n = parseFloat(data.changePct);
        const criticalLevel = anomalyMonitor.getRowLevel(code, Date.now());
        const isCritical = criticalLevel !== 'none';
        const isNewCritical = criticalLevel === 'new';
        const dirCls = isNaN(n) ? '' : (n >= 0 ? 'lt-up' : 'lt-down');
        let rowCls = 'lt-stock-row';
        if (isCritical) {
          rowCls += ' lt-row-critical ' + (isNewCritical ? 'lt-row-critical-new ' : 'lt-row-critical-old ') + dirCls;
        }
        rowEl.className = rowCls;
        const displayName = (name.length > 5 ? name.slice(0, 5) + '…' : name);
        nameEl.textContent = isCritical ? '🔥' + displayName : displayName;
        priceEl.textContent = data.price || '—';
        if (data.suspended) {
          changeEl.textContent = '停牌';
          changeEl.className = 'lt-change lt-suspended';
          priceEl.className = 'lt-price';
          trendEl.innerHTML = '';
          return;
        }
        const now = new Date();
        const inTradingNow = market.isInTradingTime(code, now);
        const cls = isNaN(n) ? '' : (n >= 0 ? 'up' : 'down');
        priceEl.className = 'lt-price ' + cls;

        // 涨跌停检测（A股主板±10%，科创板/创业板±20%；近似判断）
        const prefix = String(code || '').slice(0, 2).toLowerCase();
        const isAShare = (prefix === 'sh' || prefix === 'sz' || prefix === 'bj');
        const limitUpThreshold = isAShare ? 9.8 : Infinity;
        const limitDownThreshold = isAShare ? -9.8 : -Infinity;
        if (!isNaN(n) && n >= limitUpThreshold) {
          changeEl.textContent = '涨停';
          changeEl.className = 'lt-change up lt-limit-up';
        } else if (!isNaN(n) && n <= limitDownThreshold) {
          changeEl.textContent = '跌停';
          changeEl.className = 'lt-change down lt-limit-down';
        } else {
          changeEl.textContent = formatChangePct(data.changePct);
          changeEl.className = 'lt-change ' + cls;
        }

        const price = parseFloat(data.price);
        const preClose = parseFloat(data.preClose) || 0;
        if (inTradingNow) {
          trendTracker.recordPrice(code, price, preClose, now);
          persistTrendHistorySoon();
        }
        // 非交易时段不再追加点，但可展示当日已收集到的分时曲线
        trendTracker.drawTrend(trendEl, code, data.changePct, now);
      }
      /** 按 code 更新一行（≤3 只时用；BLANK_CODE 不更新） */
      function updateStockRow(code, data) {
        const { nameEl, taskEl, priceEl, changeEl, rowEl, trendEl } = widgetView.getCodeRowRefs(code, BLANK_CODE) || {};
        if (!nameEl || !priceEl || !changeEl || !rowEl || !trendEl) return;
        setRowContent(rowEl, nameEl, taskEl, priceEl, changeEl, trendEl, code, data);
      }

      /** 按行下标更新一行（>3 只时循环用） */
      function updateStockRowByIndex(i, code, data) {
        const { nameEl, taskEl, priceEl, changeEl, trendEl, rowEl } = widgetView.getIndexedRowRefs(i);
        if (!nameEl || !priceEl || !changeEl || !rowEl || !trendEl) return;
        setRowContent(rowEl, nameEl, taskEl, priceEl, changeEl, trendEl, code, data);
      }


      function updateTipVisibility() {
        widgetView.renderTip(tipEl, {
          stockList,
          defaultStock: DEFAULT_STOCK,
          rotateCount: getRotateList().length,
          tradingCount: getTradingRotateList().length
        });
      }

      /** 从 chrome.storage.local 读取 stockList，读完后执行回调（用于浮窗首次刷新） */
      function loadStockListFromStorage(cb) {
        chrome.storage.local.get(['stockList'], (result) => {
          if (result.stockList && Array.isArray(result.stockList) && result.stockList.length > 0) {
            stockList = result.stockList;
          } else {
            stockList = [DEFAULT_STOCK];
            chrome.storage.local.set({ stockList });
          }
          updateTipVisibility();
          if (cb) cb();
        });
      }

      /** 轮播用股票列表：自选里去掉上证指数（指数在标题栏单独显示） */
      function getRotateList() {
        return stockList.filter(code => code !== MARKET_INDEX_CODE);
      }

      /** 仅在“当前处于交易时段”的股票参与轮播（按 A 股/港股/美股各自时区判断） */
      function getTradingRotateList() {
        const now = new Date();
        return getRotateList().filter(code => market.isInTradingTime(code, now));
      }

      /** 涨跌幅绝对值 >= 阈值的股票（用于关键态霸屏） */
      function getCriticalStocks() {
        return anomalySnapshot.criticalCodes || [];
      }

      /** Smart Sorting：关键股在前，其余在后，供展示与轮播使用 */
      function getSortedRotateList() {
        // 静默态（非交易时间/午休）显示全部股票（静态展示），活跃态仅显示交易中股票
        const base = (presenceState === 'SILENT') ? getRotateList() : getTradingRotateList();
        const critical = getCriticalStocks();
        const normal = base.filter(code => !critical.includes(code));
        return [...critical, ...normal];
      }

      /**
       * 轮播用列表与步长（一屏显示 step 只，即 MAX_DISPLAY）。
       * 逻辑：始终使用 Smart Sort 后的列表，确保关键股在前但不断供。
       */
      function getCarouselListAndStep() {
        return { list: getSortedRotateList(), step: MAX_DISPLAY };
      }

      /** 兼容旧调用：仅返回轮播列表（无 step） */
      function getCarouselList() {
        const { list } = getCarouselListAndStep();
        return list;
      }

      /**
       * 判断是否处于“工作时间段”内
       * 只用于存在感策略，不影响纯粹的行情刷新逻辑
       */
      function isInWorkTime(now = new Date()) {
        const day = now.getDay(); // 0=周日,6=周六
        if (day === 0 || day === 6) return false;
        const h = now.getHours();
        const m = now.getMinutes();
        const t = h * 60 + m;
        return t >= WORKDAY_START_MIN && t <= WORKDAY_END_MIN;
      }

      /**
       * 计算“当前这一屏”要显示哪几只股票的 code 列表（最多 MAX_DISPLAY 个）。
       * 始终按 Smart Sort（关键在前）做轮播，不再进入“关键股霸屏”模式，避免轮播卡死。
       */
      function getDisplayCodes() {
        const list = getSortedRotateList();
        const total = list.length;
        if (total === 0) return [];
        if (total <= MAX_DISPLAY) {
          cycleOffset = 0;
          return [...list];
        }
        cycleOffset = cycleOffset % total;
        const codes = [];
        for (let i = 0; i < MAX_DISPLAY; i++) codes.push(list[(cycleOffset + i) % total]);
        return codes;
      }

      /**
       * 将存在感状态映射到UI（仅通过class控制，不打断用户）
       */
      function updateUIForPresenceState(state) {
        if (!wrap) return;
        const codes = Object.keys(presenceCriticalStocks);
        let up = false;
        let down = false;
        codes.forEach(code => {
          const d = lastStockDataByCode[code];
          if (!d || !d.ok) return;
          const v = parseFloat(d.changePct);
          if (isNaN(v)) return;
          if (v > 0) up = true;
          if (v < 0) down = true;
        });
        widgetView.setPresenceState(wrap, state, { criticalDown: down && !up });
      }

      /**
       * 状态变化时的统一处理：更新UI + 一次性软提醒
       */
      function handlePresenceStateChanged(oldState, newState, shouldSoftHint) {
        updateUIForPresenceState(newState);

        if (!criticalHintEl) return;
        if (displayMode === 'stealth') {
          criticalHintEl.style.display = 'none';
          return;
        }

        if (newState === 'CRITICAL' && shouldSoftHint) {
          // 根据关键股涨跌方向给出不同的情绪辅助提示
          const criticalCodes = Object.keys(presenceCriticalStocks);
          let upCount = 0, downCount = 0;
          criticalCodes.forEach(code => {
            const pct = presenceCriticalStocks[code] && presenceCriticalStocks[code].changePct;
            if (typeof pct === 'number') {
              if (pct > 0) upCount++;
              else if (pct < 0) downCount++;
            }
          });
          if (upCount > 0 && downCount === 0) {
            criticalHintEl.textContent = '涨幅较大，高位追涨需谨慎';
          } else if (downCount > 0 && upCount === 0) {
            criticalHintEl.textContent = '跌幅较大，冷静评估，避免恐慌';
          } else {
            criticalHintEl.textContent = '波动异常，建议抽空确认一下';
          }
          criticalHintEl.style.display = '';
          if (criticalHintTimer) clearTimeout(criticalHintTimer);
          criticalHintTimer = setTimeout(() => {
            if (criticalHintEl) criticalHintEl.style.display = 'none';
          }, 6000);
        } else if (newState !== 'CRITICAL') {
          // 离开关键态时，隐藏提示
          criticalHintEl.style.display = 'none';
        }
      }

      /**
       * 根据 anomalyMonitor 快照更新存在感状态
       */
      function syncPresenceStateFromSnapshot(snapshot) {
        if (!widgetCreated || !snapshot) return;
        const newState = snapshot.state || 'SILENT';
        if (newState !== presenceState) {
          const oldState = presenceState;
          presenceState = newState;
          handlePresenceStateChanged(oldState, newState, (snapshot.newlyAlertedCodes || []).length > 0);
        } else {
          // 状态未变时也要确保 UI 已应用（含初始加载时的透明度）
          updateUIForPresenceState(newState);
          if (newState === 'CRITICAL' && (snapshot.newlyAlertedCodes || []).length > 0) {
            handlePresenceStateChanged(newState, newState, true);
          }
        }
      }

      function escapeHtml(v) {
        return widgetView.escapeHtml(v);
      }

      function updateDevDebugUI() {
        if (!wrap) return;
        wrap.classList.toggle('lt-dev-mode', !!devModeEnabled);
        if (btnDebug) btnDebug.style.display = devModeEnabled ? '' : 'none';
        if (!devModeEnabled) {
          debugPanelOpen = false;
          if (debugPanelEl) debugPanelEl.style.display = 'none';
          return;
        }
        if (!debugPanelOpen && debugPanelEl) debugPanelEl.style.display = 'none';
      }

      function renderDebugPanel() {
        panelView.renderDebugPanel({
          debugPanelEl,
          devModeEnabled,
          debugPanelOpen,
          codes: getRotateList(),
          anomalyMonitor,
          lastStockDataByCode,
          formatChangePct,
          escapeHtml,
          nowTs: Date.now()
        });
      }

      /** 更新标题栏大盘指数（sh000001），不显示名称，仅点数+涨跌幅 */
      function updateMarketIndex() {
        if (!marketIndexEl) return;
        fetchStock(MARKET_INDEX_CODE).then((data) => {
          if (!marketIndexEl) return;
          if (!data || !data.ok) {
            marketIndexEl.innerHTML = '<span class="lt-idx-value lt-idx-neutral">—</span>';
            return;
          }
          const price = data.price || '—';
          const n = parseFloat(data.changePct);
          const cls = isNaN(n) ? 'lt-idx-neutral' : (n >= 0 ? 'lt-idx-up' : 'lt-idx-down');
          const sign = isNaN(n) ? '' : (n >= 0 ? '+' : '');
          const pct = isNaN(n) ? '—' : (sign + (data.changePct || '') + '%');
          marketIndexEl.innerHTML = `<span class="lt-idx-value ${cls}">${price}</span><span class="lt-idx-pct ${cls}">${pct}</span>`;
        }).catch((err) => {
          // 捕获可能的错误（如 context invalidated）
          if (marketIndexEl) {
            marketIndexEl.innerHTML = '<span class="lt-idx-value lt-idx-neutral">—</span>';
          }
        });
      }

      /**
       * 核心刷新函数：决定当前显示哪几只、是否定高 3 行、拉取行情并更新 DOM，最后决定是否启动轮播定时器。
       * forceRebuild：为 true 时强制按 displayStocks 重建行（如从设置返回、老板键显示后）。
       */
      async function updateDisplay(forceRebuild = false) {
        if (!stockList || stockList.length === 0) stockList = [DEFAULT_STOCK];
        if (rotationInProgress) {
          if (forceRebuild) {
            setTimeout(() => updateDisplay(true), 320);
          }
          return;
        }
        updateMarketIndex();
        const { list: carouselList, step } = getCarouselListAndStep();
        const isOverMax = step > 0 && carouselList.length > step;  // 是否“多于一屏”，需要固定 3 行+轮播
        let displayStocks = getDisplayCodes();
        // 休眠/断网恢复后 getDisplayCodes 可能暂时返回 []，避免清空 DOM 导致一闪一闪
        if (displayStocks.length === 0 && currentDisplayCodes.length > 0) {
          displayStocks = [...currentDisplayCodes];
        }
        // 仅当显示的股票列表或 DOM 结构模式发生变化时才重建，避免每次 forceRebuild 都清空 DOM 导致闪屏
        const needsRebuild = !arraysEqual(displayStocks, currentDisplayCodes) || (isOverMax !== currentIsOverMax);

        carouselView.syncViewportMode(viewportEl, isOverMax);
        if (needsRebuild && displayStocks.length > 0) {
          carouselView.rebuildDisplayRows({
            listEl,
            isOverMax,
            maxDisplay: MAX_DISPLAY,
            displayStocks,
            blankCode: BLANK_CODE,
            createIndexedRow: widgetView.createIndexedRow,
            createCodeRow: widgetView.createCodeRow
          });
          currentDisplayCodes = [...displayStocks];
          currentIsOverMax = isOverMax;
          // 先用缓存数据预填，避免重建瞬间出现空白占位
          if (isOverMax) {
            displayStocks.forEach((code, i) => {
              const cached = lastStockDataByCode[code];
              if (cached) updateStockRowByIndex(i, code, cached);
            });
          } else {
            displayStocks.forEach((code) => {
              const cached = lastStockDataByCode[code];
              if (cached) updateStockRow(code, cached);
            });
          }
        }

        const toFetch = displayStocks.filter(c => c && c !== BLANK_CODE);
        const results = await Promise.all(
          toFetch.map(code => fetchStock(code).then(data => ({ code, data })).catch(err => {
            // 捕获可能的 Promise rejection
            return { code, data: { ok: false, error: err.message || '请求失败' } };
          }))
        );

        // 缓存最近一次成功的数据，用于存在感状态判断
        results.forEach(({ code, data }) => {
          if (data && data.ok) {
            lastStockDataByCode[code] = data;
          }
        });

        // 后台预取所有未缓存的非当前页股票，避免轮播时出现"加载中..."
        const allRotateCodes = getRotateList();
        const notCached = allRotateCodes.filter(c => c !== BLANK_CODE && !displayStocks.includes(c) && !lastStockDataByCode[c]);
        notCached.forEach(code => {
          fetchStock(code).then(data => {
            if (data && data.ok) lastStockDataByCode[code] = data;
          }).catch(() => {});
        });

        const now = new Date();
        anomalySnapshot = anomalyMonitor.tick({
          nowTs: now.getTime(),
          rotateCodes: getRotateList(),
          lastStockDataByCode,
          isTradingFn: (code) => market.isInTradingTime(code, now),
          isInWorkTimeFn: () => isInWorkTime(now)
        });
        presenceCriticalStocks = {};
        (anomalySnapshot.criticalCodes || []).forEach(code => {
          const d = lastStockDataByCode[code];
          const pct = d ? parseFloat(d.changePct) : NaN;
          presenceCriticalStocks[code] = { changePct: isNaN(pct) ? 0 : pct };
        });
        syncPresenceStateFromSnapshot(anomalySnapshot);

        if (isOverMax) {
          results.forEach(({ code, data }, i) => updateStockRowByIndex(i, code, data));
        } else {
          results.forEach(({ code, data }) => updateStockRow(code, data));
        }
        renderAiSummary(displayStocks);
        maybeRequestAiSummaries(displayStocks);
        renderDebugPanel();

        updateTipVisibility();
        // 每次渲染后重新判断是否需要轮播（含场景 2 已读暴雷时普通股轮播）
        setupRotation();
        // 防御：处于轮播视图（关键态 decay 后回到 3 行）时若定时器仍为空则强制启动，并延迟再试几次
        if (isOverMax && !rotateTimer) {
          rotateTimer = setInterval(rotateAndUpdate, ROTATE_INTERVAL);
          setTimeout(setupRotation, 0);
          setTimeout(setupRotation, 200);
          setTimeout(setupRotation, 600);
        }
      }

      /**
       * 轮播一帧：把 cycleOffset 前进 step，算出下一屏的 code，在列表底部追加 3 行、请求数据，
       * 然后做向上平移动画，动画结束后删掉最上面 3 行并更新 currentDisplayCodes。
       */
      function rotateAndUpdate() {
        // 修复：对于 position: fixed 元素，offsetParent 恒为 null，不能用来判断可见性
        if (wrap.style.display === 'none') return;
        if (displayMode === 'stealth') return;
        if (rotationPaused) return;
        if (rotationInProgress) return;
        carouselView.resetAnimatedList(listEl, MAX_DISPLAY);

        const { list, step } = getCarouselListAndStep();
        if (step <= 0 || list.length <= step) return;  // 不足一屏不轮播
        const total = list.length;
        cycleOffset = (cycleOffset + step) % total;
        chrome.storage.local.set({ [CAROUSEL_OFFSET_KEY]: cycleOffset });
        const newCodes = getDisplayCodes();
        const prefix = 'new';
        rotationInProgress = true;
        carouselView.appendPrefixedRows({
          listEl,
          maxDisplay: MAX_DISPLAY,
          prefix,
          createPrefixedRow: widgetView.createPrefixedRow
        });
        // 先用缓存数据填充新行，避免等待网络时出现空白帧
        newCodes.forEach((code, idx) => {
          const cached = lastStockDataByCode[code];
          if (!cached) return;
          const { nameEl, taskEl, priceEl, changeEl, trendEl, rowEl } = widgetView.getPrefixedRowRefs(prefix, idx);
          if (nameEl && priceEl && changeEl && rowEl && trendEl) {
            setRowContent(rowEl, nameEl, taskEl, priceEl, changeEl, trendEl, code, cached);
          }
        });
        const toFetch = newCodes.filter(c => c !== BLANK_CODE);
        Promise.all(
          toFetch.map(code =>
            fetchStock(code)
              .then(data => ({ code, data }))
              .catch(err => ({ code, data: { ok: false, error: err.message || '请求失败' } }))
          )
        ).then(results => {
          // 更新缓存与新行内容
          results.forEach(({ code, data }, idx) => {
            if (data && data.ok) {
              lastStockDataByCode[code] = data;
            }
          });

          const now = new Date();
          anomalySnapshot = anomalyMonitor.tick({
            nowTs: now.getTime(),
            rotateCodes: getRotateList(),
            lastStockDataByCode,
            isTradingFn: (code) => market.isInTradingTime(code, now),
            isInWorkTimeFn: () => isInWorkTime(now)
          });
          presenceCriticalStocks = {};
          (anomalySnapshot.criticalCodes || []).forEach(code => {
            const d = lastStockDataByCode[code];
            const pct = d ? parseFloat(d.changePct) : NaN;
            presenceCriticalStocks[code] = { changePct: isNaN(pct) ? 0 : pct };
          });
          syncPresenceStateFromSnapshot(anomalySnapshot);

          results.forEach(({ code, data }, idx) => {
            const { nameEl, taskEl, priceEl, changeEl, trendEl, rowEl } = widgetView.getPrefixedRowRefs(prefix, idx);
            if (nameEl && priceEl && changeEl && rowEl && trendEl) {
              setRowContent(rowEl, nameEl, taskEl, priceEl, changeEl, trendEl, code, data);
            }
          });
          renderAiSummary(newCodes);
          maybeRequestAiSummaries(newCodes);
          renderDebugPanel();
        });

        carouselView.startTranslateAnimation(listEl, MAX_DISPLAY * ROW_STEP_PX);

        let cleaned = false;
        const onEnd = () => {
          if (cleaned) return;
          cleaned = true;
          try {
            listEl.removeEventListener('transitionend', onEnd);
            carouselView.finalizeRotationFrame({
              listEl,
              maxDisplay: MAX_DISPLAY,
              renumberIndexedRows: widgetView.renumberIndexedRows
            });
            currentDisplayCodes = newCodes;
          } finally {
            rotationInProgress = false;
          }
        };

        listEl.addEventListener('transitionend', onEnd);
        // 300ms 兜底 (动画是 280ms)，防止 transitionend 不触发导致卡死
        setTimeout(onEnd, 300);
      }

      /**
       * 根据当前“轮播列表长度”和“自选数量”决定是否启动/保留轮播定时器。
       * 隐藏时不启动；自选 > 3 只则保留定时器，实际是否翻页由 rotateAndUpdate 内 list 决定。
       */
      function setupRotation() {
        if (isAppHidden) return;
        const { list, step } = getCarouselListAndStep();
        const hasEnoughStocks = (getRotateList().length > MAX_DISPLAY);
        const needRotation = (step > 0 && list.length > step) || hasEnoughStocks;
        rotateTimer = carouselView.reconcileRotationTimer({
          needRotation,
          rotateTimer,
          rotateInterval: ROTATE_INTERVAL,
          rotateAndUpdate
        });
      }

      if (modeNormalBtn) {
        modeNormalBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          applyDisplayMode('normal');
          chrome.storage.local.set({ [DISPLAY_MODE_STORAGE]: 'normal' });
        });
      }

      if (modeStealthBtn) {
        modeStealthBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          applyDisplayMode('stealth');
          chrome.storage.local.set({ [DISPLAY_MODE_STORAGE]: 'stealth' });
        });
      }

      if (btnDebug) {
        btnDebug.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!devModeEnabled) return;
          debugPanelOpen = !debugPanelOpen;
          saveDebugPanelOpenFlag(debugPanelOpen);
          renderDebugPanel();
        });
      }

      // 关闭浮窗：仅隐藏（保留 DOM 以便老板键唤回），并记录”今日主动关闭”
      btnClose.addEventListener('click', (e) => {
        e.stopPropagation();
        isAppHidden = true;
        wrap.style.setProperty('display', 'none', 'important');
        if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
        const td = todayStr();
        chrome.storage.local.set({ [BOSS_KEY_STORAGE]: true, [USER_HIDE_DATE_KEY]: td });
        chrome.storage.local.remove(USER_SHOWED_KEY);
      });

      // 监听 storage 变化，实现跨标签页同步：其他标签或 popup 改了 storage，这里会收到
      const onStorageChanged = (changes, areaName) => {
        if (areaName !== 'local') return;
        if (changes[BOSS_KEY_STORAGE]) {
          const newVal = changes[BOSS_KEY_STORAGE].newValue;
          isAppHidden = !!newVal;
          if (isAppHidden) {
            wrap.style.setProperty('display', 'none', 'important');
            if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
          } else {
            // 只有在交易时间，或用户今日曾主动显示的情况下，才跟随其他标签页恢复显示
            const inTrading = isAnyInTradingNow();
            chrome.storage.local.get([USER_SHOWED_KEY], (r) => {
              if (inTrading || r[USER_SHOWED_KEY] === todayStr()) {
                wrap.style.removeProperty('display');
                rotationPaused = false;
                updateDisplay(true).then(() => { setupRotation(); setTimeout(setupRotation, 150); });
              }
              // 否则（非交易时间且未主动显示），保持隐藏，isAppHidden 已设为 false，但 display 不恢复
            });
          }
        }
        if (changes[DISPLAY_MODE_STORAGE]) {
          applyDisplayMode(changes[DISPLAY_MODE_STORAGE].newValue);
        }
        if (changes[AI_SUMMARY_READ_KEY]) {
          loadAiSummaryReadState(changes[AI_SUMMARY_READ_KEY].newValue);
          if (currentAiSummaryCode && aiSummaryReadByCode[currentAiSummaryCode]) {
            hideAiSummary();
          } else {
            renderAiSummary(currentDisplayCodes);
          }
        }
        // 股票列表被其他标签或 popup 修改时，同步到本地并刷新浮窗
        if (!changes.stockList) return;
        const newList = changes.stockList.newValue;
        stockList = (newList && Array.isArray(newList) && newList.length > 0) ? newList : [DEFAULT_STOCK];
        cycleOffset = 0;
        currentDisplayCodes = [];
        currentIsOverMax = null;
        chrome.storage.local.set({ [CAROUSEL_OFFSET_KEY]: 0 });
        updateDisplay(true).then(setupRotation);
        updateTipVisibility();
      };
      chrome.storage.onChanged.addListener(onStorageChanged);
      addCleanup(() => chrome.storage.onChanged.removeListener(onStorageChanged));

      /** 老板键：Option+Q（Mac） / Alt+Q 切换浮窗显示/隐藏，并写入 storage 以同步其他标签 */
      const onBossKey = (e) => {
        if (e.altKey && e.shiftKey && e.code === 'KeyD') {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
          e.preventDefault();
          devModeEnabled = !devModeEnabled;
          setDevModeFlag(devModeEnabled);
          if (devModeEnabled) {
            debugPanelOpen = true;
            saveDebugPanelOpenFlag(true);
          } else {
            debugPanelOpen = false;
            saveDebugPanelOpenFlag(false);
          }
          updateDevDebugUI();
          renderDebugPanel();
          return;
        }
        if (e.altKey && e.code === 'KeyQ') {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
          e.preventDefault();
          isAppHidden = !isAppHidden;
          const td = todayStr();
          if (isAppHidden) {
            wrap.style.setProperty('display', 'none', 'important');
            if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
            chrome.storage.local.set({ [BOSS_KEY_STORAGE]: true, [USER_HIDE_DATE_KEY]: td });
            chrome.storage.local.remove(USER_SHOWED_KEY);
          } else {
            wrap.style.removeProperty('display');
            rotationPaused = false;
            updateDisplay(true).then(() => { setupRotation(); setTimeout(setupRotation, 150); });
            chrome.storage.local.set({ [BOSS_KEY_STORAGE]: false });
            chrome.storage.local.remove(USER_HIDE_DATE_KEY);
            // 非交易时段主动显示：记录今日标记，防止被自动隐藏
            if (!isAnyInTradingNow()) {
              chrome.storage.local.set({ [USER_SHOWED_KEY]: td });
            }
          }
        }
      };
      document.addEventListener('keydown', onBossKey);
      addCleanup(() => document.removeEventListener('keydown', onBossKey));

      const onWrapMouseEnter = () => { rotationPaused = true; };
      const onWrapMouseLeave = () => { rotationPaused = false; setupRotation(); };
      wrap.addEventListener('mouseenter', onWrapMouseEnter);
      wrap.addEventListener('mouseleave', onWrapMouseLeave);

      // 修复：休眠唤醒或切换标签页时，强制重置悬停状态，防止 mouseleave 丢失导致轮播卡死
      const onVisibilityChange = () => {
        if (!document.hidden) {
          rotationPaused = false;
          // 唤醒时立即刷新一次
          updateDisplay(true).then(() => {
            setupRotation();
            setTimeout(setupRotation, 150);
          });
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      addCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));

      // 修复：监听网络状态，断网重连后立即恢复
      const onWindowOnline = () => {
        updateDisplay(true).then(setupRotation);
      };
      window.addEventListener('online', onWindowOnline);
      addCleanup(() => window.removeEventListener('online', onWindowOnline));

      // 初始化异常监控状态，然后从 storage 拉取股票列表后执行首次刷新并尝试启动轮播
      anomalyMonitor.init(() => {
        loadStockListFromStorage(() => {
          lastTradingState = isAnyInTradingNow(); // 股票列表加载完成后初始化交易状态基准
          updateDisplay(true).then(() => {
            setupRotation();
            setTimeout(setupRotation, 150);
          });
        });
      });

      // 鼠标悬浮在股票行上时，将关键态股票标记为已读
      if (listEl) {
        const onListMouseEnter = (e) => {
          const row = e.target.closest('.lt-stock-row');
          if (!row) return;
          const code = row.dataset.code;
          if (code && aiSummaryByCode[code] && aiSummaryByCode[code].status === 'ready') {
            dismissAiSummary(code);
          }
          if (code && anomalyMonitor.isCritical(code)) {
            const changed = anomalyMonitor.markRead(code);
            if (changed) {
              anomalySnapshot = anomalyMonitor.getSnapshot();
              updateDisplay(false);
            }
          }
        };
        listEl.addEventListener('mouseenter', onListMouseEnter, true);
        addCleanup(() => listEl.removeEventListener('mouseenter', onListMouseEnter, true));
      }

      if (aiSummaryEl) {
        const onAiSummaryMouseEnter = () => {
          const code = aiSummaryEl.dataset.code || currentAiSummaryCode;
          if (code) dismissAiSummary(code);
        };
        aiSummaryEl.addEventListener('mouseenter', onAiSummaryMouseEnter);
        addCleanup(() => aiSummaryEl.removeEventListener('mouseenter', onAiSummaryMouseEnter));
      }

      // 定时刷新：每 REFRESH_SEC 秒调一次 updateDisplay（静默态下降低频率）
      if (refreshTimer) clearInterval(refreshTimer);
      let silentSkipCounter = 0;
      refreshTimer = setInterval(() => {
        // ---- 交易时段切换检测：自动显示 / 自动隐藏 ----
        if (lastTradingState !== null) {
          const nowTrading = isAnyInTradingNow();
          if (nowTrading !== lastTradingState) {
            const td = todayStr();
            lastTradingState = nowTrading;
            if (nowTrading) {
              // 非交易 → 交易：自动显示，除非用户今天主动关闭过
              chrome.storage.local.get([BOSS_KEY_STORAGE, USER_HIDE_DATE_KEY], (r) => {
                const hiddenToday = !!r[BOSS_KEY_STORAGE] && r[USER_HIDE_DATE_KEY] === td;
                chrome.storage.local.remove(USER_SHOWED_KEY); // 非交易段"主动显示"标记清空
                if (!hiddenToday && isAppHidden) {
                  isAppHidden = false;
                  chrome.storage.local.set({ [BOSS_KEY_STORAGE]: false });
                  chrome.storage.local.remove(USER_HIDE_DATE_KEY);
                  wrap.style.removeProperty('display');
                  rotationPaused = false;
                  updateDisplay(true).then(() => { setupRotation(); setTimeout(setupRotation, 150); });
                }
              });
            } else {
              // 交易 → 非交易：自动隐藏，除非用户今天主动显示过（非交易时段）
              chrome.storage.local.get([USER_SHOWED_KEY], (r) => {
                if (r[USER_SHOWED_KEY] !== td && !isAppHidden) {
                  isAppHidden = true;
                  wrap.style.setProperty('display', 'none', 'important');
                  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
                }
              });
            }
          }
        }

        // ---- 正常刷新行情 ----
        if (stockList.length > 0 && !isAppHidden) {
          if (rotationInProgress) return;
          // 在静默态下降低刷新频率（例如约 3 倍），减少对用户的视觉打扰
          if (presenceState === 'SILENT') {
            silentSkipCounter = (silentSkipCounter + 1) % 3; // 3*2s ≈ 6s 刷新一次
            if (silentSkipCounter !== 0) return;
          }
          updateDisplay(false).catch((err) => {
            // 如果 context invalidated，停止定时器
            if (err && err.message && err.message.includes('Extension context invalidated')) {
              if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
              if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
            }
          });
        }
      }, REFRESH_SEC * 1000);

      // 拖拽：只在 header 上按下时移动浮窗，松开后把位置写入 localStorage
      let dx = 0, dy = 0;
      wrap.querySelector('.lt-header').addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        wrap.classList.add('lt-dragging');
        const rect = wrap.getBoundingClientRect();
        dx = e.clientX - rect.left;
        dy = e.clientY - rect.top;
        function move(ev) {
          wrap.style.left = (ev.clientX - dx) + 'px';
          wrap.style.top = (ev.clientY - dy) + 'px';
          wrap.style.right = 'auto';
          wrap.style.bottom = 'auto';
        }
        function up() {
          wrap.classList.remove('lt-dragging');
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          try {
            const r = wrap.getBoundingClientRect();
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: r.left, y: r.top }));
          } catch (_) { }
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });

      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const { x, y } = JSON.parse(saved);
          if (typeof x === 'number' && typeof y === 'number') {
            wrap.style.left = x + 'px';
            wrap.style.top = y + 'px';
            wrap.style.right = 'auto';
            wrap.style.bottom = 'auto';
          }
        }
      } catch (_) { }
    }); // end chrome.storage.local.get(BOSS_KEY_STORAGE)
  }

  // ========== 四、消息与页面入口 ==========
  // 收到 background 发来的 SHOW_FLOAT（popup 唤醒按钮）时，创建或唤醒浮窗
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SHOW_FLOAT') {
      const td = todayStr();
      if (widgetCreated || document.getElementById('lt-stock-float')) {
        // 浮窗已存在（可能被自动或手动隐藏），直接唤起
        chrome.storage.local.set({ [BOSS_KEY_STORAGE]: false });
        chrome.storage.local.remove(USER_HIDE_DATE_KEY);
        if (!isAnyInTradingNow()) {
          chrome.storage.local.set({ [USER_SHOWED_KEY]: td }); // 非交易时段主动显示
        }
        if (triggerShow) triggerShow();
      } else {
        createWidget();
      }
    }
  });

  /** 页面加载完成后自动创建浮窗；初始可见性由 createWidget 内部根据交易时间和用户偏好决定 */
  function maybeCreateWidget() {
    createWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeCreateWidget);
  } else {
    maybeCreateWidget();
  }
})();
