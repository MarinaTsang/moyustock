(function (global) {
  function getMarketProfile(code) {
    const prefix = String(code || '').slice(0, 2).toLowerCase();
    if (prefix === 'sh' || prefix === 'sz' || prefix === 'bj') {
      return { timeZone: 'Asia/Shanghai', sessions: [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]] };
    }
    if (prefix === 'hk') {
      return { timeZone: 'Asia/Hong_Kong', sessions: [[9 * 60 + 30, 12 * 60], [13 * 60, 16 * 60]] };
    }
    if (prefix === 'us') {
      return { timeZone: 'America/New_York', sessions: [[9 * 60 + 30, 16 * 60]] };
    }
    return null;
  }

  function getMarketTime(timeZone, now = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      weekday: 'short'
    });
    const parts = fmt.formatToParts(now);
    const get = (type) => parseInt(parts.find((p) => p.type === type)?.value || '0', 10);
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayStr = parts.find((p) => p.type === 'weekday')?.value || 'Sun';
    const day = dayMap[dayStr] ?? 0;
    const y = get('year');
    const mo = get('month');
    const da = get('day');
    const h = get('hour');
    const m = get('minute');
    const s = get('second');
    const t = h * 60 + m;
    return { day, y, mo, da, h, m, s, t };
  }

  function getMarketDayKey(code, now = new Date()) {
    const profile = getMarketProfile(code);
    if (!profile) return '';
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: profile.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = fmt.formatToParts(now);
    const y = parts.find((p) => p.type === 'year')?.value || '0000';
    const m = parts.find((p) => p.type === 'month')?.value || '01';
    const d = parts.find((p) => p.type === 'day')?.value || '01';
    return `${y}-${m}-${d}`;
  }

  function getTradingProgressMinutes(code, now = new Date()) {
    const profile = getMarketProfile(code);
    if (!profile) return null;

    const mt = getMarketTime(profile.timeZone, now);
    const minuteNow = mt.t + (mt.s / 60);
    const totalMin = profile.sessions.reduce((sum, session) => sum + (session[1] - session[0]), 0);
    let elapsed = 0;

    for (let i = 0; i < profile.sessions.length; i++) {
      const start = profile.sessions[i][0];
      const end = profile.sessions[i][1];
      const span = end - start;
      if (minuteNow < start) {
        return { inTrading: false, progressMin: elapsed, totalMin };
      }
      if (minuteNow >= start && minuteNow <= end) {
        return { inTrading: true, progressMin: elapsed + (minuteNow - start), totalMin };
      }
      elapsed += span;
    }

    return { inTrading: false, progressMin: elapsed, totalMin };
  }

  function isInTradingTime(code, now = new Date()) {
    const profile = getMarketProfile(code);
    if (!profile) return false;

    const { day, t } = getMarketTime(profile.timeZone, now);
    if (day === 0 || day === 6) return false;

    return profile.sessions.some((session) => t >= session[0] && t <= session[1]);
  }

  const api = {
    getMarketProfile,
    getMarketTime,
    getMarketDayKey,
    getTradingProgressMinutes,
    isInTradingTime
  };

  global.LTMarket = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
