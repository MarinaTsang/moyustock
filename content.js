(function () {
  const REFRESH_SEC = 2;
  const ROTATE_INTERVAL = 5000; // 每 4 秒切换一屏
  const MAX_DISPLAY = 3; // 最多显示 3 行；>3 只时定高 3 行 + 循环补位
  const BLANK_CODE = '__BLANK__'; // 空白占位（>3 时循环补位用）
  const STORAGE_KEY = 'lt-stock-float-pos';
  const CLOSED_KEY = 'lt-stock-float-closed';
  const DEFAULT_STOCK = 'sh600519';
  const MARKET_INDEX_CODE = 'sh000001'; // 上证指数，标题栏常驻，不参与轮播
  const ROW_STEP_PX = 26; // 单行高度 22 + gap 4
  // 存在感三态配置
  const PRESENCE_CRITICAL_THRESHOLD = 3.0;      // 关键态阈值（±3%）
  const PRESENCE_CRITICAL_DURATION_SEC = 10;    // 关键态持续秒数
  const PRESENCE_STATE_CHECK_SEC = 5;           // 状态检查最小间隔（秒）
  const CRITICAL_DECAY_SEC = 20;                // 关键态降级：进入 Critical 超过此秒数视为“已读”，让出轮播给普通股
  // 工作时间配置（“办公场景”感知，避免非工作时段过多打扰）
  const WORKDAY_START_MIN = 9 * 60;             // 默认 09:00
  const WORKDAY_END_MIN = 18 * 60;              // 默认 18:00

  let stockList = [];
  let cycleOffset = 0;   // 循环展示时的起始下标：(offset + i) % length
  let currentDisplayCodes = []; // 当前显示的股票 code 列表（用于判断是否需要重建 DOM）
  let refreshTimer = null;
  let rotateTimer = null;
  let widgetCreated = false;
  let isSettingsMode = false;
  let rotationPaused = false; // 鼠标悬停时暂停轮播

  function arraysEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function normalizeStockCode(input) {
    const raw = String(input).trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    if (lower.startsWith('sh') || lower.startsWith('sz') || lower.startsWith('bj') || lower.startsWith('hk')) {
      const prefix = lower.slice(0, 2);
      const rest = raw.slice(2).replace(/\D/g, '');
      return rest ? prefix + rest : raw;
    }
    if (lower.startsWith('us')) {
      const rest = raw.slice(2).replace(/[\s_]/g, '').toUpperCase();
      return rest ? 'us' + rest : raw;
    }
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 5) return 'hk' + digits;
    if (digits.length === 6) {
      const first = digits[0];
      if (first === '6' || first === '9' || first === '5') return 'sh' + digits;
      if (first === '0' || first === '1' || first === '2' || first === '3') return 'sz' + digits;
      if (first === '4' || first === '8') return 'bj' + digits;
    }
    // 纯字母（如 TSLA、AAPL）视为美股
    if (/^[a-zA-Z]+$/.test(raw)) return 'us' + raw.toUpperCase();
    return raw;
  }

  function createWidget() {
    if (widgetCreated || document.getElementById('lt-stock-float')) {
      return;
    }
    try {
      localStorage.removeItem(CLOSED_KEY);
    } catch (_) {}
    widgetCreated = true;
    isSettingsMode = false;
    
    const wrap = document.createElement('div');
    wrap.id = 'lt-stock-float';
    wrap.innerHTML = `
      <div class="lt-header">
        <div class="lt-header-left">
          <div class="lt-market-index" id="lt-market-index"></div>
          <span class="lt-mood-dot" id="lt-mood-dot"></span>
          <button type="button" class="lt-btn lt-btn-save" id="lt-btn-save" title="保存并返回" style="display:none">保存</button>
        </div>
        <div class="lt-header-right">
          <button type="button" class="lt-btn lt-btn-settings" title="设置">⚙️</button>
          <button type="button" class="lt-btn lt-btn-close" title="关闭">×</button>
        </div>
      </div>
      <div class="lt-body">
        <div class="lt-tip" id="lt-tip" style="display:none">点击右上角 ⚙️ 添加你关注的股票</div>
        <div class="lt-stock-panel" id="lt-stock-panel">
          <div class="lt-stock-list-viewport" id="lt-stock-list-viewport">
            <div class="lt-stock-list" id="lt-stock-list"></div>
          </div>
        </div>
        <div class="lt-critical-hint" id="lt-critical-hint" style="display:none">有股票涨跌超 3%，建议抽空看一下</div>
        <div class="lt-settings-panel" id="lt-settings-panel" style="display:none">
          <div class="lt-settings-input-row">
            <input type="text" class="lt-settings-input" id="lt-settings-input" placeholder="输入代码如 600519">
            <button type="button" class="lt-settings-add" id="lt-settings-add">添加</button>
          </div>
          <ul class="lt-settings-list" id="lt-settings-list"></ul>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    const viewportEl = wrap.querySelector('#lt-stock-list-viewport');
    const listEl = wrap.querySelector('#lt-stock-list');
    const stockPanel = wrap.querySelector('#lt-stock-panel');
    const settingsPanel = wrap.querySelector('#lt-settings-panel');
    const settingsInput = wrap.querySelector('#lt-settings-input');
    const settingsAddBtn = wrap.querySelector('#lt-settings-add');
    const settingsListEl = wrap.querySelector('#lt-settings-list');
    const btnSave = wrap.querySelector('#lt-btn-save');
    const btnSettings = wrap.querySelector('.lt-btn-settings');
    const btnClose = wrap.querySelector('.lt-btn-close');
    const marketIndexEl = wrap.querySelector('#lt-market-index');
    const moodDotEl = wrap.querySelector('#lt-mood-dot');
    const tipEl = wrap.querySelector('#lt-tip');
    const criticalHintEl = wrap.querySelector('#lt-critical-hint');
    // 三态状态机相关（仅在该浮窗作用域内生效）
    let presenceState = 'SILENT';                // 当前存在感状态：SILENT / ACTIVE / CRITICAL
    let presenceCriticalStocks = {};             // 关键态候选股票：{ code: { startTime, changePct } }
    let lastPresenceCheckTs = 0;                 // 上次检查时间戳
    let lastStockDataByCode = {};                // 最近一次成功的股票数据快照：{ code: { ok, changePct, ... } }
    let criticalHintTimer = null;                // 关键态软提醒定时器
    let criticalSinceByCode = {};                // 关键态时间戳：{ code: timestamp }，脱离关键态时清除

    function fetchStock(code) {
      return new Promise((resolve) => {
        try {
          // 检查 runtime 是否可用
          if (!chrome.runtime || !chrome.runtime.sendMessage) {
            resolve({ ok: false, error: '插件未就绪', code });
            return;
          }
          chrome.runtime.sendMessage({ type: 'GET_STOCK', code }, (res) => {
            if (chrome.runtime.lastError) {
              const errMsg = chrome.runtime.lastError.message;
              // Extension context invalidated 通常发生在插件重新加载后
              if (errMsg && errMsg.includes('Extension context invalidated')) {
                resolve({ ok: false, error: '插件已更新，请刷新页面', code });
                return;
              }
              resolve({ ok: false, error: errMsg, code });
              return;
            }
            resolve(res ? { ...res, code } : { ok: false, error: '未知错误', code });
          });
        } catch (e) {
          resolve({ ok: false, error: e.message || '请求失败', code });
        }
      });
    }

    /** 创建单行 DOM（按 code；BLANK_CODE 时需传 idx 以生成唯一 id） */
    function createStockRow(code, idx) {
      const rowId = code === BLANK_CODE ? 'blank-' + (idx ?? 0) : code.replace(/[^a-zA-Z0-9-_]/g, '_');
      const row = document.createElement('div');
      row.className = code === BLANK_CODE ? 'lt-stock-row lt-row-blank' : 'lt-stock-row';
      row.id = 'lt-row-' + rowId;
      row.dataset.code = code;
      row.innerHTML = `
        <span class="lt-name" id="lt-name-${rowId}">${code === BLANK_CODE ? '—' : '加载中…'}</span>
        <span class="lt-price" id="lt-price-${rowId}">—</span>
        <span class="lt-change" id="lt-change-${rowId}">—</span>
      `;
      return row;
    }

    /** 创建固定下标的行（用于 >3 只时的 3 行定高循环，id 为 lt-row-0/1/2） */
    function createStockRowByIndex(i) {
      const row = document.createElement('div');
      row.className = 'lt-stock-row';
      row.id = 'lt-row-' + i;
      row.innerHTML = `
        <span class="lt-name" id="lt-name-${i}">加载中…</span>
        <span class="lt-price" id="lt-price-${i}">—</span>
        <span class="lt-change" id="lt-change-${i}">—</span>
      `;
      return row;
    }

    /** 按 code 更新一行（≤3 只时用；BLANK_CODE 不更新） */
    function updateStockRow(code, data) {
      if (code === BLANK_CODE) return;
      const rowId = code.replace(/[^a-zA-Z0-9-_]/g, '_');
      const nameEl = document.getElementById('lt-name-' + rowId);
      const priceEl = document.getElementById('lt-price-' + rowId);
      const changeEl = document.getElementById('lt-change-' + rowId);
      const rowEl = document.getElementById('lt-row-' + rowId);
      if (!nameEl || !priceEl || !changeEl || !rowEl) return;
      setRowContent(rowEl, nameEl, priceEl, changeEl, code, data);
    }

    /** 按行下标更新一行（>3 只时循环用） */
    function updateStockRowByIndex(i, code, data) {
      const nameEl = document.getElementById('lt-name-' + i);
      const priceEl = document.getElementById('lt-price-' + i);
      const changeEl = document.getElementById('lt-change-' + i);
      const rowEl = document.getElementById('lt-row-' + i);
      if (!nameEl || !priceEl || !changeEl || !rowEl) return;
      setRowContent(rowEl, nameEl, priceEl, changeEl, code, data);
    }

    function setRowContent(rowEl, nameEl, priceEl, changeEl, code, data) {
      if (!data || !data.ok) {
        nameEl.textContent = (code && code.length > 5) ? code.slice(0, 5) + '…' : (code || '—');
        priceEl.textContent = '';
        changeEl.textContent = (data && data.error) || '网络重连中…';
        rowEl.className = 'lt-stock-row lt-error';
        priceEl.className = 'lt-price';
        changeEl.className = 'lt-change';
        return;
      }
      const name = (data.name || '—').trim();
      const n = parseFloat(data.changePct);
      const isCritical = !data.suspended && !isNaN(n) && Math.abs(n) >= PRESENCE_CRITICAL_THRESHOLD;
      const criticalAge = criticalSinceByCode[code] ? Date.now() - criticalSinceByCode[code] : 0;
      const isNewCritical = isCritical && criticalAge < CRITICAL_DECAY_MS;
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
        return;
      }
      const cls = isNaN(n) ? '' : (n >= 0 ? 'up' : 'down');
      const sign = isNaN(n) ? '' : (n >= 0 ? '+' : '');
      changeEl.textContent = sign + (data.changePct || '—') + '%';
      priceEl.className = 'lt-price ' + cls;
      changeEl.className = 'lt-change ' + cls;
    }

    function updateTipVisibility() {
      if (!tipEl) return;
      const rotateCount = getRotateList().length;
      const tradingCount = getTradingRotateList().length;
      // 只有默认股票：提示添加
      if (stockList && stockList.length === 1 && stockList[0] === DEFAULT_STOCK) {
        tipEl.textContent = '点击右上角 ⚙️ 添加你关注的股票';
        tipEl.style.display = '';
      } else if (rotateCount > 0 && tradingCount === 0) {
        // 有自选但当前无交易中的股票
        tipEl.textContent = '暂无交易中的股票';
        tipEl.style.display = '';
      } else {
        tipEl.style.display = 'none';
      }
    }

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

    /** 轮播用股票列表（剔除 sh000001，避免与标题栏重复） */
    function getRotateList() {
      return stockList.filter(code => code !== MARKET_INDEX_CODE);
    }

    /** 仅在交易时间内的股票参与轮播展示（非交易时间不显示） */
    function getTradingRotateList() {
      const now = new Date();
      return getRotateList().filter(code => isInTradingTime(code, now));
    }

    /** 涨跌幅绝对值 >= 阈值的股票（用于关键态霸屏） */
    function getCriticalStocks() {
      return getTradingRotateList().filter(code => {
        const d = lastStockDataByCode[code];
        if (!d || !d.ok || d.suspended) return false;
        const pct = parseFloat(d.changePct);
        return !isNaN(pct) && Math.abs(pct) >= PRESENCE_CRITICAL_THRESHOLD;
      });
    }

    /** Smart Sorting：关键股在前，其余在后，供展示与轮播使用 */
    function getSortedRotateList() {
      const base = getTradingRotateList();
      const critical = getCriticalStocks();
      const normal = base.filter(code => !critical.includes(code));
      return [...critical, ...normal];
    }

    /** 根据最新数据更新关键态时间戳：新进入 Critical 记录时间，脱离则清除 */
    function updateCriticalSince() {
      const critical = getCriticalStocks();
      const now = Date.now();
      getTradingRotateList().forEach(code => {
        if (critical.includes(code)) {
          if (!criticalSinceByCode[code]) criticalSinceByCode[code] = now;
        } else {
          delete criticalSinceByCode[code];
        }
      });
    }

    const CRITICAL_DECAY_MS = CRITICAL_DECAY_SEC * 1000;

    /** 进入 Critical 不足 DECAY 秒（新暴雷） */
    function getNewCriticals() {
      const now = Date.now();
      return getCriticalStocks().filter(code => (now - (criticalSinceByCode[code] || 0)) < CRITICAL_DECAY_MS);
    }

    /** 进入 Critical 已超过 DECAY 秒（已读暴雷） */
    function getOldCriticals() {
      const now = Date.now();
      return getCriticalStocks().filter(code => (now - (criticalSinceByCode[code] || 0)) >= CRITICAL_DECAY_MS);
    }

    /** 当前非关键股 */
    function getNormals() {
      const critical = getCriticalStocks();
      return getTradingRotateList().filter(code => !critical.includes(code));
    }

    /** 轮播用列表与步长：新暴雷仅关键股轮播，已读暴雷后关键+普通一起轮播（关键股仍保留 🔥） */
    function getCarouselListAndStep() {
      const newC = getNewCriticals();
      const oldC = getOldCriticals();
      if (newC.length > 0) {
        const list = [...newC, ...oldC];
        return { list, step: MAX_DISPLAY };
      }
      // 已读暴雷或无关键股：关键态与非关键态一起轮播（列表已按关键在前排序）
      return { list: getSortedRotateList(), step: MAX_DISPLAY };
    }

    /** 兼容旧调用：仅返回轮播列表（无 step） */
    function getCarouselList() {
      const { list } = getCarouselListAndStep();
      return list;
    }

    /**
     * 获取指定时区下的当前时刻（小时、分钟、星期）
     * 使用市场所在时区，与用户设备时区无关
     */
    function getMarketTime(timeZone, now = new Date()) {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hour: '2-digit', minute: '2-digit', hour12: false,
        weekday: 'short'
      });
      const parts = fmt.formatToParts(now);
      const get = (type) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
      const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const dayStr = parts.find(p => p.type === 'weekday')?.value || 'Sun';
      const day = dayMap[dayStr] ?? 0;
      const h = get('hour');
      const m = get('minute');
      const t = h * 60 + m;
      return { day, h, m, t };
    }

    /**
     * 判断是否在交易时间内（按各市场所在时区，与用户设备时区无关）
     * A股：上海 9:30-11:30, 13:00-15:00
     * 港股：香港 9:30-12:00, 13:00-16:00
     * 美股：美东 9:30-16:00
     */
    function isInTradingTime(code, now = new Date()) {
      const prefix = String(code || '').slice(0, 2).toLowerCase();

      if (prefix === 'sh' || prefix === 'sz' || prefix === 'bj') {
        const { day, t } = getMarketTime('Asia/Shanghai', now);
        if (day === 0 || day === 6) return false;
        const mStart = 9 * 60 + 30, mEnd = 11 * 60 + 30;
        const aStart = 13 * 60, aEnd = 15 * 60;
        return (t >= mStart && t <= mEnd) || (t >= aStart && t <= aEnd);
      }
      if (prefix === 'hk') {
        const { day, t } = getMarketTime('Asia/Hong_Kong', now);
        if (day === 0 || day === 6) return false;
        const mStart = 9 * 60 + 30, mEnd = 12 * 60;
        const aStart = 13 * 60, aEnd = 16 * 60;
        return (t >= mStart && t <= mEnd) || (t >= aStart && t <= aEnd);
      }
      if (prefix === 'us') {
        const { day, t } = getMarketTime('America/New_York', now);
        if (day === 0 || day === 6) return false;
        const open = 9 * 60 + 30, close = 16 * 60;
        return t >= open && t <= close;
      }
      return false;
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
     * 关键态自动降级 (Alert Decay)：新暴雷仅关键股轮播；已读暴雷后关键+普通一起轮播（关键股保留 🔥）。
     */
    function getDisplayCodes() {
      const newC = getNewCriticals();

      // 场景 1：有新暴雷 → 仅关键股（new + old）轮播
      if (newC.length > 0) {
        const oldC = getOldCriticals();
        const list = [...newC, ...oldC];
        const total = list.length;
        if (total <= MAX_DISPLAY) {
          cycleOffset = 0;
          return list.slice(0, MAX_DISPLAY);
        }
        cycleOffset = cycleOffset % total;
        const codes = [];
        for (let i = 0; i < MAX_DISPLAY; i++) codes.push(list[(cycleOffset + i) % total]);
        return codes;
      }

      // 已读暴雷或无关键股：关键态与非关键态一起轮播（getSortedRotateList 已关键在前）
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
     * 根据当前行情数据判断存在感状态：SILENT / ACTIVE / CRITICAL
     */
    function determinePresenceState(rotateList) {
      const now = new Date();
      const nowTs = now.getTime();

       // 非工作时间统一进入静默态（但仍可手动查看，不强制隐藏浮窗）
       if (!isInWorkTime(now)) {
         presenceCriticalStocks = {};
         return 'SILENT';
       }

      // 仅考虑在交易时间内的股票，且排除无行情数据的
      const tradingStocks = rotateList.filter(code => {
        if (!code) return false;
        if (!isInTradingTime(code, now)) return false;
        const data = lastStockDataByCode[code];
        if (data && data.suspended) return false; // 停牌不参与存在感
        return data && data.ok && !isNaN(parseFloat(data.changePct));
      });

      if (tradingStocks.length === 0) {
        presenceCriticalStocks = {};
        return 'SILENT';
      }

      const prevCritical = presenceCriticalStocks;
      presenceCriticalStocks = {};
      let hasCritical = false;

      tradingStocks.forEach(code => {
        const data = lastStockDataByCode[code];
        const pct = parseFloat(data.changePct);
        const absPct = Math.abs(pct);
        if (absPct >= PRESENCE_CRITICAL_THRESHOLD) {
          const prev = prevCritical[code];
          let startTime = nowTs;
          if (prev) {
            // 保持之前的开始时间，持续计时
            startTime = prev.startTime;
          }
          presenceCriticalStocks[code] = { startTime, changePct: pct };
          const durationSec = (nowTs - startTime) / 1000;
          if (durationSec >= PRESENCE_CRITICAL_DURATION_SEC) {
            hasCritical = true;
          }
        }
      });

      if (hasCritical) return 'CRITICAL';
      return 'ACTIVE';
    }

    /**
     * 将存在感状态映射到UI（仅通过class控制，不打断用户）
     */
    function updateUIForPresenceState(state) {
      if (!wrap) return;
      wrap.classList.remove('lt-state-silent', 'lt-state-active', 'lt-state-critical', 'lt-critical-down');
      if (state === 'SILENT') {
        wrap.classList.add('lt-state-silent');
      } else if (state === 'ACTIVE') {
        wrap.classList.add('lt-state-active');
      } else if (state === 'CRITICAL') {
        wrap.classList.add('lt-state-critical');
        // 简单判断整体方向，用于选择边框颜色（此处只区分“主要下跌”场景）
        const codes = Object.keys(presenceCriticalStocks);
        let up = false; let down = false;
        codes.forEach(code => {
          const d = lastStockDataByCode[code];
          if (!d || !d.ok) return;
          const v = parseFloat(d.changePct);
          if (isNaN(v)) return;
          if (v > 0) up = true;
          if (v < 0) down = true;
        });
        if (down && !up) {
          wrap.classList.add('lt-critical-down');
        }
      }
      // mood dot 的颜色完全由外层状态 class 控制，这里无需额外逻辑
    }

    /**
     * 状态变化时的统一处理：更新UI + 一次性软提醒
     */
    function handlePresenceStateChanged(oldState, newState) {
      updateUIForPresenceState(newState);

      if (!criticalHintEl) return;

      // 从非关键态切换到关键态时，给一次柔和提示
      if (oldState !== 'CRITICAL' && newState === 'CRITICAL' && !isSettingsMode) {
        criticalHintEl.style.display = '';
        if (criticalHintTimer) clearTimeout(criticalHintTimer);
        criticalHintTimer = setTimeout(() => {
          if (criticalHintEl) criticalHintEl.style.display = 'none';
        }, 5000);
      } else if (newState !== 'CRITICAL') {
        // 离开关键态时，隐藏提示
        criticalHintEl.style.display = 'none';
      }
    }

    /**
     * 低频检查并更新存在感状态（在 updateDisplay 内部被调用）
     */
    function maybeUpdatePresenceState(rotateList) {
      if (!widgetCreated || isSettingsMode) return;
      const nowTs = Date.now();
      if (nowTs - lastPresenceCheckTs < PRESENCE_STATE_CHECK_SEC * 1000) return;
      lastPresenceCheckTs = nowTs;

      const newState = determinePresenceState(rotateList);
      if (newState !== presenceState) {
        const oldState = presenceState;
        presenceState = newState;
        handlePresenceStateChanged(oldState, newState);
      } else {
        // 状态未变时也要确保 UI 已应用（含初始加载时的透明度）
        updateUIForPresenceState(newState);
      }
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

    async function updateDisplay(forceRebuild = false) {
      if (!stockList || stockList.length === 0) stockList = [DEFAULT_STOCK];
      updateMarketIndex();
      const { list: carouselList, step } = getCarouselListAndStep();
      const isOverMax = step > 0 && carouselList.length > step;
      let displayStocks = getDisplayCodes();
      // 休眠/断网恢复后 getDisplayCodes 可能暂时返回 []，避免清空 DOM 导致一闪一闪
      if (displayStocks.length === 0 && currentDisplayCodes.length > 0) {
        displayStocks = [...currentDisplayCodes];
      }
      const needsRebuild = forceRebuild || !arraysEqual(displayStocks, currentDisplayCodes);
      
      if (viewportEl) {
        viewportEl.classList.toggle('lt-viewport-fixed', isOverMax);
      }
      if (needsRebuild && displayStocks.length > 0) {
        listEl.innerHTML = '';
        if (isOverMax) {
          // 定高模式：固定 3 行，id 为 lt-row-0/1/2
          for (let i = 0; i < MAX_DISPLAY; i++) listEl.appendChild(createStockRowByIndex(i));
        } else {
          displayStocks.forEach((code, idx) => listEl.appendChild(createStockRow(code, idx)));
        }
        currentDisplayCodes = [...displayStocks];
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
      updateCriticalSince();

      if (isOverMax) {
        results.forEach(({ code, data }, i) => updateStockRowByIndex(i, code, data));
      } else {
        results.forEach(({ code, data }) => updateStockRow(code, data));
      }

      updateTipVisibility();
      // 低频更新存在感状态（不会频繁打扰用户）
      maybeUpdatePresenceState(getRotateList());
      // 每次渲染后重新判断是否需要轮播（含场景 2 已读暴雷时普通股轮播）
      setupRotation();
    }

    /** 创建一行（临时 id 前缀 prefix） */
    function createStockRowWithPrefix(prefix, i) {
      const row = document.createElement('div');
      row.className = 'lt-stock-row';
      row.id = prefix + '-' + i;
      row.innerHTML = `
        <span class="lt-name" id="lt-name-${prefix}-${i}">加载中…</span>
        <span class="lt-price" id="lt-price-${prefix}-${i}">—</span>
        <span class="lt-change" id="lt-change-${prefix}-${i}">—</span>
      `;
      return row;
    }

    /**
     * 轮播切换：向上顶的滑动效果；步长由 getCarouselListAndStep 的 step 决定（Decay 分层）
     */
    function rotateAndUpdate() {
      const { list, step } = getCarouselListAndStep();
      if (step <= 0 || list.length <= step) return;
      const total = list.length;
      cycleOffset = (cycleOffset + step) % total;
      const newCodes = getDisplayCodes();
      const prefix = 'new';
      for (let i = 0; i < MAX_DISPLAY; i++) listEl.appendChild(createStockRowWithPrefix(prefix, i));
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
          const nameEl = document.getElementById('lt-name-' + prefix + '-' + idx);
          const priceEl = document.getElementById('lt-price-' + prefix + '-' + idx);
          const changeEl = document.getElementById('lt-change-' + prefix + '-' + idx);
          const rowEl = document.getElementById(prefix + '-' + idx);
          if (nameEl && priceEl && changeEl && rowEl) {
            setRowContent(rowEl, nameEl, priceEl, changeEl, code, data);
          }
        });
      });
      listEl.style.transition = 'transform 0.28s ease-out';
      listEl.style.transform = `translateY(-${MAX_DISPLAY * ROW_STEP_PX}px)`;
      const onEnd = () => {
        listEl.removeEventListener('transitionend', onEnd);
        for (let i = 0; i < MAX_DISPLAY; i++) listEl.removeChild(listEl.firstChild);
        listEl.style.transform = '';
        listEl.style.transition = '';
        const kept = listEl.querySelectorAll('.lt-stock-row');
        kept.forEach((row, i) => {
          row.id = 'lt-row-' + i;
          row.querySelector('.lt-name').id = 'lt-name-' + i;
          row.querySelector('.lt-price').id = 'lt-price-' + i;
          row.querySelector('.lt-change').id = 'lt-change-' + i;
        });
        currentDisplayCodes = newCodes;
      };
      listEl.addEventListener('transitionend', onEnd);
    }

    function setupRotation() {
      const { list, step } = getCarouselListAndStep();
      const needRotation = step > 0 && list.length > step && !rotationPaused;
      if (needRotation) {
        if (!rotateTimer) {
          rotateTimer = setInterval(rotateAndUpdate, ROTATE_INTERVAL);
        }
      } else {
        if (rotateTimer) {
          clearInterval(rotateTimer);
          rotateTimer = null;
        }
      }
    }

    function renderSettingsList() {
      if (stockList.length === 0) {
        settingsListEl.innerHTML = '<li class="lt-settings-empty">暂无股票，请添加</li>';
        return;
      }
      settingsListEl.innerHTML = stockList.map((code, idx) => `
        <li class="lt-settings-item">
          <span class="lt-settings-code">${code}</span>
          <button type="button" class="lt-settings-del" data-index="${idx}">删除</button>
        </li>
      `).join('');
      
      settingsListEl.querySelectorAll('.lt-settings-del').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index);
          if (idx < 0 || idx >= stockList.length) return;
          stockList.splice(idx, 1);
          if (stockList.length === 0) stockList = [DEFAULT_STOCK];
          chrome.storage.local.set({ stockList });
          currentDisplayCodes = [];
          updateTipVisibility();
          renderSettingsList();
          updateDisplay(true).then(setupRotation);
        });
      });
    }

    function switchToStock() {
      isSettingsMode = false;
      stockPanel.style.display = '';
      settingsPanel.style.display = 'none';
      if (btnSave) btnSave.style.display = 'none';
      if (marketIndexEl) marketIndexEl.style.display = '';
      currentDisplayCodes = [];
      updateDisplay(true).then(setupRotation);
    }

    function switchToSettings() {
      isSettingsMode = true;
      stockPanel.style.display = 'none';
      settingsPanel.style.display = '';
      if (btnSave) btnSave.style.display = '';
      if (marketIndexEl) marketIndexEl.style.display = 'none';
      renderSettingsList();
    }

    btnSave.addEventListener('click', (e) => {
      e.stopPropagation();
      switchToStock(); // 保存并返回股票页（列表已实时写入 storage）
    });

    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isSettingsMode) switchToStock();
      else switchToSettings();
    });

    btnClose.addEventListener('click', (e) => {
      e.stopPropagation();
      if (rotateTimer) {
        clearInterval(rotateTimer);
        rotateTimer = null;
      }
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      wrap.remove();
      widgetCreated = false;
      try {
        localStorage.setItem(CLOSED_KEY, '1');
      } catch (_) {}
    });

    settingsAddBtn.addEventListener('click', () => {
      const raw = settingsInput.value.trim();
      if (!raw) return;
      const code = normalizeStockCode(raw);
      if (!code) return;
      if (stockList.includes(code)) {
        settingsInput.value = '';
        return;
      }
      stockList.push(code);
      settingsInput.value = '';
      chrome.storage.local.set({ stockList });
      currentDisplayCodes = [];
      updateTipVisibility();
      renderSettingsList();
      updateDisplay(true).then(setupRotation);
    });

    settingsInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') settingsAddBtn.click();
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.stockList) return;
      const newList = changes.stockList.newValue;
      stockList = (newList && Array.isArray(newList) && newList.length > 0) ? newList : [DEFAULT_STOCK];
      cycleOffset = 0;
      currentDisplayCodes = [];
      updateDisplay(true).then(setupRotation);
      if (isSettingsMode) renderSettingsList();
      updateTipVisibility();
    });

    wrap.addEventListener('mouseenter', () => {
      rotationPaused = true;
      if (rotateTimer) {
        clearInterval(rotateTimer);
        rotateTimer = null;
      }
    });
    wrap.addEventListener('mouseleave', () => {
      rotationPaused = false;
      setupRotation();
    });

    loadStockListFromStorage(() => {
      updateDisplay(true).then(setupRotation);
    });

    if (refreshTimer) clearInterval(refreshTimer);
    let silentSkipCounter = 0; // 静默态下减低刷新频率
    refreshTimer = setInterval(() => {
      if (stockList.length > 0 && !isSettingsMode) {
        // 在静默态下降低刷新频率（例如约 3 倍），减少对用户的视觉打扰
        if (presenceState === 'SILENT') {
          silentSkipCounter = (silentSkipCounter + 1) % 3; // 3*2s ≈ 6s 刷新一次
          if (silentSkipCounter !== 0) return;
        }
        updateDisplay(false).catch((err) => {
          // 如果 context invalidated，停止定时器
          if (err && err.message && err.message.includes('Extension context invalidated')) {
            if (refreshTimer) {
              clearInterval(refreshTimer);
              refreshTimer = null;
            }
            if (rotateTimer) {
              clearInterval(rotateTimer);
              rotateTimer = null;
            }
          }
        });
      }
    }, REFRESH_SEC * 1000);

    // 拖拽：仅拖拽 header 区域，点击按钮不拖拽
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
        } catch (_) {}
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
    } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SHOW_FLOAT') {
      createWidget();
    }
  });

  function maybeCreateWidget() {
    try {
      if (localStorage.getItem(CLOSED_KEY) === '1') return; // 用户曾关闭，仅通过点击图标唤醒
    } catch (_) {}
    createWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeCreateWidget);
  } else {
    maybeCreateWidget();
  }
})();
