/**
 * 异常波动监控模块（MV3 content script 可直接注入）
 * - 稳定持续检测：涨跌幅越过阈值并持续 N 秒才进入 critical
 * - 防重复提醒：同一股票 5 分钟冷却；鼠标关注/已读后当日不再提醒
 */
(function (global) {
  const DEFAULT_STORAGE_KEY = 'lt-read-criticals-v2';

  function defaultDayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function create(options = {}) {
    const threshold = typeof options.threshold === 'number' ? options.threshold : 3.0;
    const sustainMs = (typeof options.sustainSec === 'number' ? options.sustainSec : 10) * 1000;
    const cooldownMs = (typeof options.cooldownSec === 'number' ? options.cooldownSec : 300) * 1000;
    const decayMs = (typeof options.decaySec === 'number' ? options.decaySec : 20) * 1000;
    const storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
    const getDayKey = options.getDayKey || defaultDayKey;
    const storageGet = options.storageGet || ((keys, cb) => chrome.storage.local.get(keys, cb));
    const storageSet = options.storageSet || ((obj, cb) => chrome.storage.local.set(obj, cb));

    const state = {
      dayKey: '',
      readByCode: {},
      byCode: {},
      lastSnapshot: {
        state: 'SILENT',
        criticalCodes: [],
        newlyAlertedCodes: []
      }
    };

    function ensureDay() {
      const day = getDayKey();
      if (state.dayKey !== day) {
        state.dayKey = day;
        state.readByCode = {};
      }
    }

    function getCodeState(code) {
      if (!state.byCode[code]) {
        state.byCode[code] = {
          breachStartTs: 0,
          breachDir: 0,
          lastPct: 0,
          isCritical: false,
          lastAlertTs: 0,
          alertedInWave: false
        };
      }
      return state.byCode[code];
    }

    function resetWave(codeState) {
      codeState.breachStartTs = 0;
      codeState.breachDir = 0;
      codeState.isCritical = false;
      codeState.alertedInWave = false;
    }

    function persistReadState() {
      storageSet({ [storageKey]: { day: state.dayKey, codes: state.readByCode } });
    }

    function init(cb) {
      ensureDay();
      storageGet([storageKey], (res) => {
        const stored = res && res[storageKey];
        if (stored && stored.day === state.dayKey && stored.codes && typeof stored.codes === 'object') {
          state.readByCode = stored.codes;
        } else {
          state.readByCode = {};
        }
        if (cb) cb();
      });
    }

    function tick(params) {
      ensureDay();
      const nowTs = params && typeof params.nowTs === 'number' ? params.nowTs : Date.now();
      const rotateCodes = (params && Array.isArray(params.rotateCodes)) ? params.rotateCodes : [];
      const stockData = (params && params.lastStockDataByCode) || {};
      const isTradingFn = (params && typeof params.isTradingFn === 'function') ? params.isTradingFn : (() => true);
      const isInWorkTimeFn = (params && typeof params.isInWorkTimeFn === 'function') ? params.isInWorkTimeFn : (() => true);

      const codesSet = new Set(rotateCodes);
      Object.keys(state.byCode).forEach(code => {
        if (!codesSet.has(code)) {
          delete state.byCode[code];
        }
      });

      const criticalCodes = [];
      const newlyAlertedCodes = [];
      let hasTradingStock = false;

      for (const code of rotateCodes) {
        const codeState = getCodeState(code);
        const inTrading = !!isTradingFn(code);
        const data = stockData[code];

        if (!inTrading) {
          resetWave(codeState);
          continue;
        }
        hasTradingStock = true;

        const pct = parseFloat(data && data.changePct);
        const valid = !!(data && data.ok && !data.suspended && !isNaN(pct));
        if (!valid) {
          resetWave(codeState);
          continue;
        }

        const abs = Math.abs(pct);
        const dir = pct >= 0 ? 1 : -1;

        if (abs >= threshold) {
          if (!codeState.breachStartTs) {
            codeState.breachStartTs = nowTs;
            codeState.breachDir = dir;
            codeState.alertedInWave = false;
          } else if (codeState.breachDir !== dir) {
            codeState.breachStartTs = nowTs;
            codeState.breachDir = dir;
            codeState.alertedInWave = false;
          }

          codeState.lastPct = pct;
          const isStableCritical = (nowTs - codeState.breachStartTs) >= sustainMs;
          codeState.isCritical = isStableCritical;

          if (isStableCritical) {
            criticalCodes.push(code);
            const readToday = !!state.readByCode[code];
            const inCooldown = codeState.lastAlertTs > 0 && (nowTs - codeState.lastAlertTs) < cooldownMs;
            if (!readToday && !inCooldown && !codeState.alertedInWave && isInWorkTimeFn()) {
              codeState.lastAlertTs = nowTs;
              codeState.alertedInWave = true;
              newlyAlertedCodes.push(code);
            }
          }
        } else {
          resetWave(codeState);
        }
      }

      const overallState = !isInWorkTimeFn()
        ? 'SILENT'
        : (!hasTradingStock ? 'SILENT' : (criticalCodes.length > 0 ? 'CRITICAL' : 'ACTIVE'));

      state.lastSnapshot = {
        state: overallState,
        criticalCodes,
        newlyAlertedCodes
      };
      return state.lastSnapshot;
    }

    function markRead(code) {
      ensureDay();
      if (!code || state.readByCode[code]) return false;
      state.readByCode[code] = true;
      persistReadState();
      return true;
    }

    function isRead(code) {
      ensureDay();
      return !!state.readByCode[code];
    }

    function isCritical(code) {
      const codeState = state.byCode[code];
      return !!(codeState && codeState.isCritical);
    }

    function getRowLevel(code, nowTs = Date.now()) {
      const codeState = state.byCode[code];
      if (!codeState || !codeState.isCritical) return 'none';
      if (isRead(code)) return 'old';
      if (codeState.lastAlertTs > 0 && (nowTs - codeState.lastAlertTs) < decayMs) return 'new';
      return 'old';
    }

    function getCodeDebug(code, nowTs = Date.now()) {
      ensureDay();
      const codeState = state.byCode[code];
      const cooldownLeftSec = (!codeState || !codeState.lastAlertTs)
        ? 0
        : Math.max(0, Math.ceil((cooldownMs - (nowTs - codeState.lastAlertTs)) / 1000));
      const sustainSec = (!codeState || !codeState.breachStartTs)
        ? 0
        : Math.max(0, Math.floor((nowTs - codeState.breachStartTs) / 1000));
      return {
        code,
        tracked: !!codeState,
        isCritical: !!(codeState && codeState.isCritical),
        isRead: isRead(code),
        rowLevel: getRowLevel(code, nowTs),
        lastPct: codeState ? codeState.lastPct : 0,
        sustainSec,
        cooldownLeftSec,
        alertedInWave: !!(codeState && codeState.alertedInWave),
        breachDir: codeState ? codeState.breachDir : 0
      };
    }

    return {
      init,
      tick,
      markRead,
      isRead,
      isCritical,
      getRowLevel,
      getCodeDebug,
      getSnapshot: () => state.lastSnapshot
    };
  }

  global.LTAnomalyMonitor = { create };
})(window);
