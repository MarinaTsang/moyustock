(function (global) {
  function parseJsonp(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (raw[0] === '{' || raw[0] === '[') {
      try { return JSON.parse(raw); } catch (_) { return null; }
    }
    const match = raw.match(/^[\w$]+\(([\s\S]*)\);?$/);
    if (!match) return null;
    const body = match[1];
    try { return JSON.parse(body); } catch (_) { return null; }
  }

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error('fetch failed: ' + res.status);
    const text = await res.text();
    const json = parseJsonp(text);
    if (!json) throw new Error('invalid jsonp');
    return json;
  }

  function toNumber(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return isNaN(n) ? 0 : n;
  }

  function parseDayKlineRow(row) {
    if (!row) return null;
    const parts = String(row).split(',');
    if (parts.length < 15) return null;
    return {
      date: parts[0],
      mainNetIn: toNumber(parts[1]),
      smallNetIn: toNumber(parts[2]),
      midNetIn: toNumber(parts[3]),
      largeNetIn: toNumber(parts[4]),
      superNetIn: toNumber(parts[5]),
      mainRatio: toNumber(parts[6]),
      smallRatio: toNumber(parts[7]),
      midRatio: toNumber(parts[8]),
      largeRatio: toNumber(parts[9]),
      superRatio: toNumber(parts[10]),
      shClose: toNumber(parts[11]),
      shPct: toNumber(parts[12]),
      szClose: toNumber(parts[13]),
      szPct: toNumber(parts[14])
    };
  }

  async function fetchEastmoneyMarketFlowRealtime() {
    const fields = [
      'f12', 'f14',
      'f62', 'f184',
      'f66', 'f69',
      'f72', 'f75',
      'f78', 'f81',
      'f84', 'f87'
    ].join(',');
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001&fields=${fields}`;
    const json = await fetchJson(url);
    const diff = json && json.data && Array.isArray(json.data.diff) ? json.data.diff : [];
    const map = {};
    diff.forEach((item) => {
      if (!item) return;
      const code = String(item.f12 || '').trim();
      if (!code) return;
      map[code] = {
        code,
        name: item.f14 || '',
        mainNetIn: toNumber(item.f62),
        mainRatio: toNumber(item.f184),
        superNetIn: toNumber(item.f66),
        superRatio: toNumber(item.f69),
        largeNetIn: toNumber(item.f72),
        largeRatio: toNumber(item.f75),
        midNetIn: toNumber(item.f78),
        midRatio: toNumber(item.f81),
        smallNetIn: toNumber(item.f84),
        smallRatio: toNumber(item.f87)
      };
    });
    return {
      ok: true,
      sh: map['000001'] || null,
      sz: map['399001'] || null,
      updatedAt: Date.now()
    };
  }

  async function fetchEastmoneyMarketFlowHistory() {
    const fields2 = [
      'f51', 'f52', 'f53', 'f54', 'f55', 'f56',
      'f57', 'f58', 'f59', 'f60', 'f61',
      'f62', 'f63', 'f64', 'f65'
    ].join(',');
    const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=0&klt=101&fields1=f1,f2,f3,f7&fields2=${fields2}&secid=1.000001&secid2=0.399001`;
    const json = await fetchJson(url);
    const data = json && json.data ? json.data : null;
    if (!data) return { ok: false, error: 'no-data' };
    const shRow = Array.isArray(data.klines) ? data.klines[data.klines.length - 1] : null;
    const szRow = Array.isArray(data.klines2) ? data.klines2[data.klines2.length - 1] : null;
    const sh = parseDayKlineRow(shRow);
    const sz = parseDayKlineRow(szRow);
    return {
      ok: true,
      sh,
      sz,
      updatedAt: Date.now()
    };
  }

  async function fetchEastmoneySectorFlow(kind, limit = 7) {
    const type = kind === 'concept' ? '3' : '2';
    const fs = `m:90+t:${type}`;
    const fields = ['f12', 'f14', 'f3', 'f62', 'f184'].join(',');
    const urls = [
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${limit}&po=1&np=1&fltt=2&invt=2&fid=f62&fs=${encodeURIComponent(fs)}&fields=${fields}`,
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${limit}&po=1&np=1&fltt=2&invt=2&fid=f62&fs=${encodeURIComponent(fs)}&fields=${fields}&ut=bd1d9ddb04089700cf9c27f6f7426281`
    ];
    let diff = [];
    for (const url of urls) {
      try {
        const json = await fetchJson(url);
        diff = json && json.data && Array.isArray(json.data.diff) ? json.data.diff : [];
        if (diff.length > 0) break;
      } catch (_) {}
    }
    return diff.map((item) => ({
      code: item.f12 || '',
      name: item.f14 || '',
      changePct: toNumber(item.f3),
      mainNetIn: toNumber(item.f62),
      mainNetRatio: toNumber(item.f184)
    })).filter((item) => item.name);
  }

  global.LTCrawler = {
    fetchEastmoneyMarketFlowRealtime,
    fetchEastmoneyMarketFlowHistory,
    fetchEastmoneySectorFlow
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
