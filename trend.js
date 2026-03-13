(function (global) {
  function renderSparkline(points, width, height, totalMin, preClose) {
    if (!points || points.length < 2 || !totalMin) return '';

    const prices = points.map((point) => point.price);
    const priceMin = Math.min(...prices);
    const priceMax = Math.max(...prices);

    let yMin;
    let yMax;
    if (preClose && preClose > 0) {
      const actualHalf = Math.max(priceMax - preClose, preClose - priceMin, 0);
      const minHalf = preClose * 0.015;
      const halfRange = Math.max(actualHalf, minHalf) * 1.1;
      yMin = preClose - halfRange;
      yMax = preClose + halfRange;
    } else {
      const center = (priceMin + priceMax) / 2;
      const half = Math.max((priceMax - priceMin) / 2, center * 0.005);
      yMin = center - half;
      yMax = center + half;
    }

    const range = yMax - yMin || 1;
    const svgParts = [];
    for (let i = 0; i < points.length; i++) {
      const x = (Math.max(0, Math.min(totalMin, points[i].progressMin)) / totalMin) * width;
      const rawY = height - ((points[i].price - yMin) / range) * height;
      const y = Math.max(0, Math.min(height, rawY));
      svgParts.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    return `M ${svgParts.join(' L ')}`;
  }

  function createTracker(options = {}) {
    const market = options.market || global.LTMarket;
    const maxPoints = typeof options.maxPoints === 'number' ? options.maxPoints : 900;
    const sampleBucketMin = typeof options.sampleBucketMin === 'number' ? options.sampleBucketMin : 5;
    const priceHistory = {};

    function importState(state) {
      if (!state || typeof state !== 'object') return;
      Object.keys(priceHistory).forEach((code) => delete priceHistory[code]);
      Object.keys(state).forEach((code) => {
        const entry = state[code];
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.points)) return;
        priceHistory[code] = {
          dayKey: String(entry.dayKey || ''),
          preClose: Number(entry.preClose || 0),
          points: entry.points
            .filter((point) => point && typeof point.progressMin === 'number' && typeof point.price === 'number')
            .slice(-maxPoints)
        };
      });
    }

    function exportState() {
      const snapshot = {};
      Object.keys(priceHistory).forEach((code) => {
        const entry = priceHistory[code];
        if (!entry) return;
        snapshot[code] = {
          dayKey: entry.dayKey,
          preClose: entry.preClose,
          points: entry.points.slice(-maxPoints)
        };
      });
      return snapshot;
    }

    function recordPrice(code, price, preClose, now = new Date()) {
      if (!market || !code || isNaN(price)) return;
      const dayKey = market.getMarketDayKey(code, now);
      if (!dayKey) return;

      const progress = market.getTradingProgressMinutes(code, now);
      if (!progress || !progress.inTrading) return;

      if (!priceHistory[code] || priceHistory[code].dayKey !== dayKey) {
        priceHistory[code] = { dayKey, preClose: 0, points: [] };
      }

      if (preClose > 0 && !priceHistory[code].preClose) {
        priceHistory[code].preClose = preClose;
      }

      const points = priceHistory[code].points;
      const bucketProgressMin = sampleBucketMin > 0
        ? Math.floor(progress.progressMin / sampleBucketMin) * sampleBucketMin
        : progress.progressMin;
      const point = { progressMin: bucketProgressMin, price };
      const last = points[points.length - 1];
      if (last && Math.abs(last.progressMin - point.progressMin) < 0.0001) {
        last.price = point.price;
      } else {
        points.push(point);
        if (points.length > maxPoints) points.shift();
      }
    }

    function drawTrend(trendEl, code, changePct, now = new Date()) {
      if (!trendEl || !market) return;
      const history = priceHistory[code];
      const progress = market.getTradingProgressMinutes(code, now);
      const dayKey = market.getMarketDayKey(code, now);
      if (!history || history.dayKey !== dayKey || !history.points || history.points.length < 2 || !progress || !progress.totalMin) {
        trendEl.innerHTML = '';
        return;
      }

      const n = parseFloat(changePct);
      let colorClass = 'flat';
      if (n > 0) colorClass = 'up';
      else if (n < 0) colorClass = 'down';

      const width = trendEl.offsetWidth || 160;
      const preClose = history.preClose || 0;
      const pathD = renderSparkline(history.points, width, 12, progress.totalMin, preClose);
      trendEl.innerHTML = `<svg viewBox="0 0 ${width} 12" preserveAspectRatio="none"><path d="${pathD}" class="${colorClass}"></path></svg>`;
    }

    return {
      importState,
      exportState,
      recordPrice,
      drawTrend,
      getHistory(code) {
        return priceHistory[code] || null;
      }
    };
  }

  const api = {
    createTracker,
    renderSparkline
  };

  global.LTTrend = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
