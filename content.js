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
  // ========== 一、常量 ==========
  const REFRESH_SEC = 2;                         // 定时刷新间隔（秒）
  const ROTATE_INTERVAL = 5000;                  // 轮播间隔（毫秒），每 5 秒切换一屏
  const MAX_DISPLAY = 3;                         // 最多显示 3 行；>3 只时定高 3 行 + 循环轮播
  const BLANK_CODE = '__BLANK__';                // 空白占位（轮播补位用）
  const STORAGE_KEY = 'lt-stock-float-pos';     // localStorage key：浮窗位置
  const CLOSED_KEY = 'lt-stock-float-closed';    // localStorage key：用户是否点过关闭（仅通过图标再唤醒）
  const BOSS_KEY_STORAGE = 'userHidden';        // chrome.storage key：老板键隐藏状态，跨标签同步
  const DEFAULT_STOCK = 'sh600519';
  const MARKET_INDEX_CODE = 'sh000001';         // 上证指数，标题栏常驻，不参与列表轮播
  const ROW_STEP_PX = 38;                       // 单行高度（px），含走势线约 34px + 4px gap
  // 存在感三态（见 doc/PRESENCE_STATES_DESIGN.md）
  const PRESENCE_CRITICAL_THRESHOLD = 3.0;      // 关键态阈值：涨跌幅 ±3%
  const PRESENCE_CRITICAL_DURATION_SEC = 10;    // 关键态持续秒数
  const PRESENCE_STATE_CHECK_SEC = 5;           // 状态检查最小间隔（秒）
  const CRITICAL_DECAY_SEC = 20;                // 关键态降级：超过此秒数视为“已读”，恢复普通轮播
  const WORKDAY_START_MIN = 9 * 60;             // 工作时间 09:00
  const WORKDAY_END_MIN = 18 * 60;              // 工作时间 18:00

  // ========== 二、模块级状态（整个 content 脚本内共享） ==========
  let stockList = [];              // 当前自选股 code 列表，与 chrome.storage.local 同步
  let cycleOffset = 0;             // 轮播起始下标：(cycleOffset + i) % list.length
  let currentDisplayCodes = [];    // 当前 DOM 里显示的 code 列表，用于判断是否需要重建行
  let refreshTimer = null;         // 定时刷新定时器（每 REFRESH_SEC 秒调 updateDisplay）
  let rotateTimer = null;         // 轮播定时器（每 ROTATE_INTERVAL 调 rotateAndUpdate）
  let widgetCreated = false;      // 是否已创建过浮窗（防止重复创建）
  let isSettingsMode = false;     // 是否处于“设置”面板（添加/删除股票）
  let rotationPaused = false;     // 鼠标悬停时暂停轮播翻页（定时器不停，仅跳过翻页）

  // 比较两个数组是否逐项相等（用于判断“当前显示的股票”是否变化，决定是否重建 DOM）
  function arraysEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** 将用户输入规范为带交易所前缀的 code，如 600519 -> sh600519，TSLA -> usTSLA */
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

  // ========== 三、浮窗创建与 DOM ==========
  /**
   * 创建浮窗：只执行一次。先读 storage 中的老板键状态，再创建根节点并挂到 document.body。
   * 后续所有“列表、大盘、设置、拖拽、定时器”都在这个根节点内完成。
   */
  function createWidget() {
    if (widgetCreated || document.getElementById('lt-stock-float')) {
      return;
    }
    try {
      localStorage.removeItem(CLOSED_KEY);
    } catch (_) { }
    widgetCreated = true;
    isSettingsMode = false;

    // 先读老板键状态，再创建 DOM，这样刷新页面后能恢复“隐藏”状态
    chrome.storage.local.get(BOSS_KEY_STORAGE, (result) => {
      const initiallyHidden = !!result[BOSS_KEY_STORAGE];
      let isAppHidden = initiallyHidden;

      // 根节点：整个浮窗的容器，id 供 getElementById 和样式用
      const wrap = document.createElement('div');
      wrap.id = 'lt-stock-float';
      if (initiallyHidden) wrap.style.setProperty('display', 'none', 'important');
      // innerHTML 一次性写入子结构（类比 Android 的 inflate 布局）
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
      document.body.appendChild(wrap);  // 挂到页面 body 上，浮窗即可显示

      // 缓存常用 DOM 引用，避免重复 querySelector（类似 findViewById 后复用）
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
      let readCriticals = {};                       // 今日已读关键态：{ code: true }，跨刷新持久化
      const READ_CRITICALS_KEY = 'lt-read-criticals'; // chrome.storage.local key

      /** 获取今日交易日 key（格式 YYYY-MM-DD） */
      function getTradingDayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      /** 从 storage 加载今日已读关键态 */
      function loadReadCriticals(cb) {
        chrome.storage.local.get([READ_CRITICALS_KEY], (result) => {
          const stored = result[READ_CRITICALS_KEY];
          if (stored && stored.day === getTradingDayKey()) {
            readCriticals = stored.codes || {};
          } else {
            readCriticals = {}; // 新的交易日，清空
          }
          if (cb) cb();
        });
      }

      /** 保存已读关键态到 storage */
      function saveReadCriticals() {
        chrome.storage.local.set({ [READ_CRITICALS_KEY]: { day: getTradingDayKey(), codes: readCriticals } });
      }

      /** 标记一只股票为今日已读 */
      function markCriticalRead(code) {
        if (!readCriticals[code]) {
          readCriticals[code] = true;
          saveReadCriticals();
        }
      }

      /**
       * 请求单只股票行情：通过 chrome.runtime.sendMessage 发给 background，由 background 请求 qt.gtimg.cn 后返回。
       * 返回 Promise，resolve 得到 { ok, name, price, changePct, suspended, error? }。
       */
      function fetchStock(code) {
        return new Promise((resolve) => {
          try {
            // 检查 runtime 是否可用（插件被卸载或刷新后可能不可用）
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

      // ========== 2.5 分时走势逻辑（自维护价格历史） ==========

      /**
       * 价格历史存储：{ [code]: number[] }
       * 每次 GET_STOCK 返回价格时追加（约每 REFRESH_SEC 秒一次），
       * 最多保留 TREND_MAX_POINTS 个点，超出时丢弃最旧的。
       */
      const priceHistory = {};
      const TREND_MAX_POINTS = 120; // ≈ 4 分钟（2 秒/次）

      /** 追加价格到历史 */
      function recordPrice(code, price) {
        if (!code || isNaN(price)) return;
        if (!priceHistory[code]) { priceHistory[code] = []; }
        priceHistory[code].push(price);
        if (priceHistory[code].length > TREND_MAX_POINTS) priceHistory[code].shift();
      }

      /**
       * 生成 Sparkline SVG 路径
       * @param {number[]} points - 价格数组
       * @param {number} width - SVG 宽度
       * @param {number} height - SVG 高度
       */
      function renderSparkline(points, width, height) {
        if (!points || points.length < 2) return '';
        const min = Math.min(...points);
        const max = Math.max(...points);
        const range = max - min;
        if (range === 0) {
          return `M 0 ${height / 2} L ${width} ${height / 2}`;
        }
        const parts = [];
        for (let i = 0; i < points.length; i++) {
          const x = (i / (points.length - 1)) * width;
          const y = height - ((points[i] - min) / range) * height;
          parts.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
        }
        return `M ${parts.join(' L ')}`;
      }

      /** 用价格历史同步绘制走势线 */
      function drawTrend(trendEl, code, changePct) {
        if (!trendEl) return;
        const h = priceHistory[code];
        if (!h || h.length < 2) { trendEl.innerHTML = ''; return; }
        const n = parseFloat(changePct);
        let colorClass = 'flat';
        if (n > 0) colorClass = 'up';
        else if (n < 0) colorClass = 'down';
        const w = trendEl.offsetWidth || 100;
        const pathD = renderSparkline(h, w, 12);
        trendEl.innerHTML = `<svg viewBox="0 0 ${w} 12" preserveAspectRatio="none"><path d="${pathD}" class="${colorClass}"></path></svg>`;
      }

      /** setRowContent 核心 —— 将数据写入 DOM 元素 */
      function setRowContent(rowEl, nameEl, priceEl, changeEl, trendEl, code, data) {
        rowEl.dataset.code = code; // 保证 hover 时能读取 code
        if (!data || !data.ok) {
          nameEl.textContent = (code && code.length > 5) ? code.slice(0, 5) + '…' : (code || '—');
          priceEl.textContent = '';
          changeEl.textContent = (data && data.error) || '网络重连中…';
          rowEl.className = 'lt-stock-row lt-error';
          priceEl.className = 'lt-price';
          changeEl.className = 'lt-change';
          trendEl.innerHTML = '';
          return;
        }
        const name = (data.name || '—').trim();
        const n = parseFloat(data.changePct);
        const isCritical = !data.suspended && !isNaN(n) && Math.abs(n) >= PRESENCE_CRITICAL_THRESHOLD;
        const criticalAge = criticalSinceByCode[code] ? Date.now() - criticalSinceByCode[code] : 0;
        const alreadyRead = !!readCriticals[code];
        const isNewCritical = isCritical && !alreadyRead && criticalAge < CRITICAL_DECAY_MS;
        // 如果已超过 decay 时间且之前未标记已读，自动标记
        if (isCritical && !alreadyRead && criticalAge >= CRITICAL_DECAY_MS) {
          markCriticalRead(code);
        }
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
        const cls = isNaN(n) ? '' : (n >= 0 ? 'up' : 'down');
        const sign = isNaN(n) ? '' : (n >= 0 ? '+' : '');
        changeEl.textContent = sign + (data.changePct || '—') + '%';
        priceEl.className = 'lt-price ' + cls;
        changeEl.className = 'lt-change ' + cls;

        // 记录价格到历史并绘制走势
        const price = parseFloat(data.price);
        recordPrice(code, price);
        drawTrend(trendEl, code, data.changePct);
      }
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
        <div class="lt-trend" id="lt-trend-${rowId}"></div>
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
        <div class="lt-trend" id="lt-trend-${i}"></div>
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
        const trendEl = document.getElementById('lt-trend-' + rowId);
        if (!nameEl || !priceEl || !changeEl || !rowEl || !trendEl) return;
        setRowContent(rowEl, nameEl, priceEl, changeEl, trendEl, code, data);
      }

      /** 按行下标更新一行（>3 只时循环用） */
      function updateStockRowByIndex(i, code, data) {
        const nameEl = document.getElementById('lt-name-' + i);
        const priceEl = document.getElementById('lt-price-' + i);
        const changeEl = document.getElementById('lt-change-' + i);
        const trendEl = document.getElementById('lt-trend-' + i);
        const rowEl = document.getElementById('lt-row-' + i);
        if (!nameEl || !priceEl || !changeEl || !rowEl || !trendEl) return;
        setRowContent(rowEl, nameEl, priceEl, changeEl, trendEl, code, data);
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
        // 静默态（非交易时间/午休）显示全部股票（静态展示），活跃态仅显示交易中股票
        const base = (presenceState === 'SILENT') ? getRotateList() : getTradingRotateList();
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

      /** 进入 Critical 不足 DECAY 秒且未被标记已读（新暴雷） */
      function getNewCriticals() {
        const now = Date.now();
        return getCriticalStocks().filter(code =>
          !readCriticals[code] && (now - (criticalSinceByCode[code] || 0)) < CRITICAL_DECAY_MS
        );
      }

      /** 进入 Critical 已超过 DECAY 秒或已被标记已读（已读暴雷） */
      function getOldCriticals() {
        const now = Date.now();
        return getCriticalStocks().filter(code =>
          readCriticals[code] || (now - (criticalSinceByCode[code] || 0)) >= CRITICAL_DECAY_MS
        );
      }

      /** 当前非关键股 */
      function getNormals() {
        const critical = getCriticalStocks();
        return getTradingRotateList().filter(code => !critical.includes(code));
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
          const mStart = 9 * 60 + 30, mEnd = 15 * 60;
          return (t >= mStart && t <= mEnd);
        }
        if (prefix === 'hk') {
          const { day, t } = getMarketTime('Asia/Hong_Kong', now);
          if (day === 0 || day === 6) return false;
          const mStart = 9 * 60 + 30, mEnd = 16 * 60;
          return (t >= mStart && t <= mEnd);
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
       * 计算“当前这一屏”要显示哪几只股票的 code 列表（最多 MAX_DISPLAY 个）。
       * 若有新暴雷：只显示关键股（新+旧），可能 1～3 只；否则用完整轮播列表按 cycleOffset 取一屏。
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

      /**
       * 核心刷新函数：决定当前显示哪几只、是否定高 3 行、拉取行情并更新 DOM，最后决定是否启动轮播定时器。
       * forceRebuild：为 true 时强制按 displayStocks 重建行（如从设置返回、老板键显示后）。
       */
      async function updateDisplay(forceRebuild = false) {
        if (!stockList || stockList.length === 0) stockList = [DEFAULT_STOCK];
        updateMarketIndex();
        const { list: carouselList, step } = getCarouselListAndStep();
        const isOverMax = step > 0 && carouselList.length > step;  // 是否“多于一屏”，需要固定 3 行+轮播
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
        // 防御：处于轮播视图（关键态 decay 后回到 3 行）时若定时器仍为空则强制启动，并延迟再试几次
        if (isOverMax && !rotateTimer) {
          rotateTimer = setInterval(rotateAndUpdate, ROTATE_INTERVAL);
          setTimeout(setupRotation, 0);
          setTimeout(setupRotation, 200);
          setTimeout(setupRotation, 600);
        }
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
        <div class="lt-trend" id="lt-trend-${prefix}-${i}"></div>
      `;
        return row;
      }

      /**
       * 轮播一帧：把 cycleOffset 前进 step，算出下一屏的 code，在列表底部追加 3 行、请求数据，
       * 然后做向上平移动画，动画结束后删掉最上面 3 行并更新 currentDisplayCodes。
       */
      function rotateAndUpdate() {
        // 修复：对于 position: fixed 元素，offsetParent 恒为 null，不能用来判断可见性
        if (wrap.style.display === 'none') return;
        if (rotationPaused) return;
        // 防御性清理：如果发现子元素数量异常（比如上次动画没正常结束），强制重置为 3 行
        // 这能自动修复因 transitionend 丢失、报错或其他原因导致的 DOM 残留
        while (listEl.children.length > MAX_DISPLAY) {
          listEl.removeChild(listEl.firstChild);
        }
        listEl.style.transform = '';
        listEl.style.transition = '';

        const { list, step } = getCarouselListAndStep();
        if (step <= 0 || list.length <= step) return;  // 不足一屏不轮播
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
            const trendEl = document.getElementById('lt-trend-' + prefix + '-' + idx);
            const rowEl = document.getElementById(prefix + '-' + idx);
            if (nameEl && priceEl && changeEl && rowEl && trendEl) {
              setRowContent(rowEl, nameEl, priceEl, changeEl, trendEl, code, data);
            }
          });
        });

        // 强制重绘，确保新添加的 DOM 已经布局，然后再加 transition
        void listEl.offsetWidth;

        listEl.style.transition = 'transform 0.28s ease-out';
        listEl.style.transform = `translateY(-${MAX_DISPLAY * ROW_STEP_PX}px)`;

        let cleaned = false;
        const onEnd = () => {
          if (cleaned) return;
          cleaned = true;
          listEl.removeEventListener('transitionend', onEnd);
          for (let i = 0; i < MAX_DISPLAY; i++) listEl.removeChild(listEl.firstChild);
          listEl.style.transform = '';
          listEl.style.transition = '';
          const kept = listEl.querySelectorAll('.lt-stock-row');
          kept.forEach((row, i) => {
            row.id = 'lt-row-' + i;
            row.querySelector('.lt-name').id = 'lt-name-' + i;
            const tEl = row.querySelector('.lt-trend'); if (tEl) tEl.id = 'lt-trend-' + i;
            row.querySelector('.lt-price').id = 'lt-price-' + i;
            row.querySelector('.lt-change').id = 'lt-change-' + i;
          });
          currentDisplayCodes = newCodes;
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

      // 关闭浮窗：移除 DOM、清定时器、取消老板键监听，并记“已关闭”到 localStorage（下次进页不自动弹出）
      btnClose.addEventListener('click', (e) => {
        e.stopPropagation();
        document.removeEventListener('keydown', onBossKey);
        if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        wrap.remove();
        widgetCreated = false;
        try { localStorage.setItem(CLOSED_KEY, '1'); } catch (_) { }
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

      // 监听 storage 变化，实现跨标签页同步：其他标签或 popup 改了 storage，这里会收到
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        if (changes[BOSS_KEY_STORAGE]) {
          const newVal = changes[BOSS_KEY_STORAGE].newValue;
          isAppHidden = !!newVal;
          if (isAppHidden) {
            wrap.style.setProperty('display', 'none', 'important');
            if (rotateTimer) {
              clearInterval(rotateTimer);
              rotateTimer = null;
            }
          } else {
            wrap.style.removeProperty('display');
            rotationPaused = false;
            updateDisplay(true).then(() => {
              setupRotation();
              setTimeout(setupRotation, 150);
            });
          }
        }
        // 股票列表被其他标签或 popup 修改时，同步到本地并刷新浮窗
        if (!changes.stockList) return;
        const newList = changes.stockList.newValue;
        stockList = (newList && Array.isArray(newList) && newList.length > 0) ? newList : [DEFAULT_STOCK];
        cycleOffset = 0;
        currentDisplayCodes = [];
        updateDisplay(true).then(setupRotation);
        if (isSettingsMode) renderSettingsList();
        updateTipVisibility();
      });

      /** 老板键：Option+Q（Mac） / Alt+Q 切换浮窗显示/隐藏，并写入 storage 以同步其他标签 */
      const onBossKey = (e) => {
        if (e.altKey && e.code === 'KeyQ') {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
          e.preventDefault();
          isAppHidden = !isAppHidden;
          if (isAppHidden) {
            wrap.style.setProperty('display', 'none', 'important');
            if (rotateTimer) {
              clearInterval(rotateTimer);
              rotateTimer = null;
            }
          } else {
            wrap.style.removeProperty('display');
            rotationPaused = false;
            updateDisplay(true).then(() => {
              setupRotation();
              setTimeout(setupRotation, 150);
            });
          }
          chrome.storage.local.set({ [BOSS_KEY_STORAGE]: isAppHidden });
        }
      };
      document.addEventListener('keydown', onBossKey);

      wrap.addEventListener('mouseenter', () => { rotationPaused = true; });
      wrap.addEventListener('mouseleave', () => { rotationPaused = false; setupRotation(); });

      // 修复：休眠唤醒或切换标签页时，强制重置悬停状态，防止 mouseleave 丢失导致轮播卡死
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          rotationPaused = false;
          // 唤醒时立即刷新一次
          updateDisplay(true).then(() => {
            setupRotation();
            setTimeout(setupRotation, 150);
          });
        }
      });

      // 修复：监听网络状态，断网重连后立即恢复
      window.addEventListener('online', () => {
        updateDisplay(true).then(setupRotation);
      });

      // 加载已读关键态，然后从 storage 拉取股票列表后执行首次刷新并尝试启动轮播
      loadReadCriticals(() => {
        loadStockListFromStorage(() => {
          updateDisplay(true).then(() => {
            setupRotation();
            setTimeout(setupRotation, 150);
          });
        });
      });

      // 鼠标悬浮在股票行上时，将关键态股票标记为已读
      if (listEl) {
        listEl.addEventListener('mouseenter', (e) => {
          const row = e.target.closest('.lt-stock-row');
          if (!row) return;
          const code = row.dataset.code;
          if (code && getCriticalStocks().includes(code)) {
            markCriticalRead(code);
          }
        }, true);
      }

      // 定时刷新：每 REFRESH_SEC 秒调一次 updateDisplay（静默态下降低频率）
      if (refreshTimer) clearInterval(refreshTimer);
      let silentSkipCounter = 0;
      refreshTimer = setInterval(() => {
        if (stockList.length > 0 && !isSettingsMode && !isAppHidden) {
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
  // 收到 background 发来的 SHOW_FLOAT（用户点击扩展图标）时，创建或唤醒浮窗
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SHOW_FLOAT') {
      createWidget();
    }
  });

  /** 页面加载完成后：若用户从未点过“关闭”，则自动创建浮窗；否则等用户点击图标再创建 */
  function maybeCreateWidget() {
    try {
      if (localStorage.getItem(CLOSED_KEY) === '1') return;
    } catch (_) { }
    createWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeCreateWidget);
  } else {
    maybeCreateWidget();
  }
})();
