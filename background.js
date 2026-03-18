/**
 * Chrome 扩展的「后台脚本」(Service Worker)
 *
 * 运行环境：独立于任何网页，没有 DOM，生命周期由浏览器管理（可能被休眠）。
 * 作用：响应扩展图标点击、切换标签时补注 content、代页面请求行情（避免 CORS）。
 *
 * 与 Android 类比：类似一个没有 UI 的 Service，负责接收事件、发消息、发网络请求。
 */

importScripts('shared.js');
importScripts('crawler.js');

const AI_SUMMARY_HEADLINE_LIMIT = 5;
const DIGEST_PRE_KEY = 'lt-digest-pre-v1';
const DIGEST_POST_KEY = 'lt-digest-post-v1';
const DIGEST_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时

let digestPopupWindowId = null;

// ===== 微博群消息（WebSocket 拦截）=====
const WEIBO_GROUP_NAME = '真爱粉自由讨论群';

async function handleWeiboWsMsg(raw) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  await chrome.storage.local.set({ weiboLastRaw: String(raw || '').slice(0, 400), weiboStatus: `收到推送 ${t}` }).catch(() => {});

  let arr;
  try { arr = JSON.parse(raw); } catch (_) { return; }
  if (!Array.isArray(arr)) return;

  const stored = await chrome.storage.local.get(['weiboMsgs']);
  let existing = Array.isArray(stored.weiboMsgs) ? stored.weiboMsgs : [];
  let changed = false;

  for (const item of arr) {
    const d = item && item.data;
    if (!d || d.type !== 'groupchat') continue;
    const info = d.info;
    if (!info) continue;
    const gname = String(info.group_name || '');
    if (gname && !gname.includes(WEIBO_GROUP_NAME)) continue;
    const text = String(info.content || '').trim();
    const sender = String((info.from_user && info.from_user.screen_name) || '').trim();
    if (!text || !sender) continue;
    const id = String(info.id || Date.now());
    if (existing.some(m => m.id === id)) continue;
    existing = [...existing, { id, sender, text, time: String(info.time || t) }].slice(-5);
    changed = true;
  }

  if (!changed) return;
  await chrome.storage.local.set({ weiboMsgs: existing, weiboStatus: `新消息 ${t}` });
}

function isWeekend(date = new Date()) {
  const d = date.getDay();
  return d === 0 || d === 6;
}

function nextWeekdayTime(hour, minute) {
  const now = new Date();
  const target = new Date();
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  while (isWeekend(target)) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function scheduleDigestAlarms() {
  chrome.alarms.create('digest-pre', { when: nextWeekdayTime(8, 45) });
  chrome.alarms.create('digest-post', { when: nextWeekdayTime(15, 30) });
  chrome.alarms.create('popup-show-pre', { when: nextWeekdayTime(9, 25) });
  chrome.alarms.create('popup-hide-pre', { when: nextWeekdayTime(9, 30) });
  chrome.alarms.create('popup-show-post', { when: nextWeekdayTime(15, 5) });
}

function isTimeNear(targetHour, targetMinute, toleranceMinutes = 10) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const tgt = targetHour * 60 + targetMinute;
  return Math.abs(cur - tgt) <= toleranceMinutes;
}

async function openDigestPopup() {
  if (digestPopupWindowId !== null) {
    try {
      await chrome.windows.update(digestPopupWindowId, { focused: true });
      return;
    } catch (_) {
      digestPopupWindowId = null;
    }
  }
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: 380,
      height: 600,
      focused: true
    });
    digestPopupWindowId = win ? win.id : null;
  } catch (_) {}
}

async function closeDigestPopup() {
  if (digestPopupWindowId === null) return;
  const id = digestPopupWindowId;
  digestPopupWindowId = null;
  try { await chrome.windows.remove(id); } catch (_) {}
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === digestPopupWindowId) {
    digestPopupWindowId = null;
    chrome.alarms.clear('popup-hide-post');
  }
});

async function buildPreDigest() {
  return {
    ok: true,
    updatedAt: Date.now(),
    calendar: [],
    earnings: [],
    overnight: [],
    sources: {
      jin10: false,
      wallstreet: false,
      investing: false,
      eastmoney: false
    }
  };
}

async function buildPostDigest() {
  let fundFlow = null;
  let sectorIndustry = [];
  let sectorConcept = [];
  if (globalThis.LTCrawler && LTCrawler.fetchEastmoneyMarketFlowHistory) {
    try {
      const res = await LTCrawler.fetchEastmoneyMarketFlowHistory();
      if (res && res.ok) fundFlow = res;
    } catch (_) {}
  }
  if (globalThis.LTCrawler && LTCrawler.fetchEastmoneySectorFlow) {
    try {
      sectorIndustry = await LTCrawler.fetchEastmoneySectorFlow('industry', 7);
      sectorConcept = await LTCrawler.fetchEastmoneySectorFlow('concept', 7);
    } catch (_) {}
  }

  return {
    ok: true,
    updatedAt: Date.now(),
    fundFlow,
    sectorHeat: { industry: sectorIndustry, concept: sectorConcept },
    usSector: [],
    sources: {
      eastmoney: !!fundFlow,
      eastmoneySector: sectorIndustry.length > 0 || sectorConcept.length > 0,
      jin10: false,
      wallstreet: false,
      investing: false
    }
  };
}

async function runDigestCrawl(phase, options = {}) {
  const key = phase === 'post-market' ? DIGEST_POST_KEY : DIGEST_PRE_KEY;
  const force = !!options.force;
  if (!force) {
    const cached = await chrome.storage.local.get([key]);
    const existing = cached && cached[key];
    if (existing && existing.updatedAt && (Date.now() - existing.updatedAt) < DIGEST_TTL_MS) {
      return existing;
    }
  }

  const data = phase === 'post-market'
    ? await buildPostDigest()
    : await buildPreDigest();
  await chrome.storage.local.set({ [key]: data });
  return data;
}

function getCodeMeta(code) {
  const raw = String(code || '');
  const marketMatch = raw.match(/^(sh|sz|bj|hk|us)/i);
  return {
    market: marketMatch ? marketMatch[1].toLowerCase() : '',
    cleanCode: raw.replace(/^(sh|sz|bj|hk|us)/i, '')
  };
}

function buildNewsSearchQueries(code, name) {
  const { market, cleanCode } = getCodeMeta(code);
  const cleanName = String(name || '').trim();
  const quotedName = cleanName ? `"${cleanName}"` : '';

  if (/[\u4e00-\u9fa5]/.test(cleanName)) {
    const marketKeyword = market === 'hk' ? '港股' : (market === 'bj' ? '北交所' : 'A股');
    return [
      `${quotedName} ${marketKeyword} when:7d`,
      `${quotedName} 股票 财经 when:7d`,
      `${quotedName} 公司 财报 when:7d`
    ];
  }

  const quotedCode = cleanCode ? `"${cleanCode}"` : '';
  return [
    `${quotedName} ${quotedCode} stock when:7d`,
    `${quotedName} earnings analyst when:7d`,
    `${quotedCode} ${quotedName} shares when:7d`
  ].filter(Boolean);
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
}

function isRelevantHeadline(item, name, code) {
  const title = normalizeText(item && item.title ? item.title : '');
  if (!title) return false;
  const { cleanCode } = getCodeMeta(code);
  const cleanName = String(name || '').trim();
  if (cleanName) {
    const normalizedName = normalizeText(cleanName);
    if (normalizedName && title.includes(normalizedName)) return true;
    const nameTokens = normalizedName.split(/\s+/).filter((token) => token.length >= 3);
    if (nameTokens.some((token) => title.includes(token))) return true;
  }
  if (cleanCode && title.includes(String(cleanCode).toLowerCase())) return true;
  return false;
}

async function fetchRecentHeadlines(code, name) {
  const queries = buildNewsSearchQueries(code, name);
  const merged = [];
  const seen = new Set();

  for (const query of queries) {
    const q = encodeURIComponent(query);
    const url = `https://news.google.com/rss/search?q=${q}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const xml = await res.text();
    const items = LTShared.parseGoogleNewsRss(xml, AI_SUMMARY_HEADLINE_LIMIT);
    items.forEach((item) => {
      const key = normalizeText(item && item.title ? item.title : '');
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(item);
    });
    if (merged.length >= AI_SUMMARY_HEADLINE_LIMIT * 2) break;
  }

  const relevant = merged.filter((item) => isRelevantHeadline(item, name, code));
  const candidates = relevant.length >= 2 ? relevant : merged;
  return candidates.slice(0, AI_SUMMARY_HEADLINE_LIMIT);
}

// 判断当前标签页的 URL 是否允许注入 content script（仅 http/https 网页可注入）
function isInjectableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * 向指定标签页注入浮窗所需的 JS 和 CSS（content script）
 * 用于：用户切换到“已打开但尚未注入”的标签时补注，或点击图标时若未注入则先注入再发消息
 */
function injectIntoTab(tabId) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !isInjectableUrl(tab.url)) return;
    chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => { });
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared.js', 'market.js', 'trend.js', 'widgetView.js', 'panelView.js', 'carouselView.js', 'anomalyMonitor.js', 'content.js']
    }).catch(() => { });
  });
}

// 扩展安装或更新时：对当前已打开的所有 http(s) 标签补注
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) injectIntoTab(tab.id);
    });
  });
  scheduleDigestAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleDigestAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || !alarm.name) return;
  if (alarm.name === 'digest-pre') {
    runDigestCrawl('pre-market', { force: true }).finally(scheduleDigestAlarms);
  }
  if (alarm.name === 'digest-post') {
    runDigestCrawl('post-market', { force: true }).finally(scheduleDigestAlarms);
  }
  if (alarm.name === 'popup-show-pre') {
    if (!isWeekend() && isTimeNear(9, 25)) openDigestPopup();
    scheduleDigestAlarms();
  }
  if (alarm.name === 'popup-hide-pre') {
    closeDigestPopup();
    scheduleDigestAlarms();
  }
  if (alarm.name === 'popup-show-post') {
    if (!isWeekend() && isTimeNear(15, 5)) {
      openDigestPopup();
      chrome.alarms.create('popup-hide-post', { delayInMinutes: 5 });
    }
    scheduleDigestAlarms();
  }
  if (alarm.name === 'popup-hide-post') {
    closeDigestPopup();
  }
});

/**
 * 用户点击扩展图标时：通知当前标签页的 content script 显示/唤醒浮窗
 * 若 content 尚未注入（例如刚打开的新标签），则先注入再延迟发一次消息
 */
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) return;
  chrome.tabs.sendMessage(tab.id, { type: 'SHOW_FLOAT' }).catch(() => {
    // 可能尚未注入 content script，先注入再发消息
    injectIntoTab(tab.id);
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id, { type: 'SHOW_FLOAT' }).catch(() => { });
    }, 100);
  });
});

/**
 * 接收 content / popup 发来的消息；这里只处理 GET_STOCK（请求行情）
 * 由 background 发请求可避免在页面里直接请求 qt.gtimg.cn 触发的 CORS 限制。
 * sendResponse 是异步的，因此要 return true 告诉浏览器“稍后会调用 sendResponse”
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SHOW_FLOAT_IN_TAB') {
    const tabId = msg.tabId;
    if (!tabId) {
      sendResponse({ ok: false, error: '缺少 tabId' });
      return;
    }

    chrome.tabs.sendMessage(tabId, { type: 'SHOW_FLOAT' }).then(() => {
      sendResponse({ ok: true });
    }).catch(() => {
      injectIntoTab(tabId);
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: 'SHOW_FLOAT' })
          .then(() => sendResponse({ ok: true }))
          .catch((error) => sendResponse({ ok: false, error: error && error.message ? error.message : '浮窗唤醒失败' }));
      }, 100);
    });
    return true;
  }

  if (msg.type !== 'GET_STOCK') return;
  (async () => {
    try {
      const code = msg.code || 'sh600519'; // 支持传入股票代码，默认 sh600519
      const res = await fetch(`http://qt.gtimg.cn/q=${code}`);
      if (!res.ok) throw new Error('请求失败: ' + res.status);
      const buffer = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buffer);
      sendResponse(LTShared.parseTencentQuoteText(text));
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || '未知错误' });
    }
  })();
  return true; // 保持 channel 开启，便于异步 sendResponse
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STOCKS_BATCH') {
    (async () => {
      try {
        const codes = (Array.isArray(msg.codes) ? msg.codes : []).join(',');
        if (!codes) { sendResponse({ ok: false, error: 'no codes' }); return; }
        const res = await fetch(`http://qt.gtimg.cn/q=${codes}`);
        if (!res.ok) throw new Error('fetch failed: ' + res.status);
        const buffer = await res.arrayBuffer();
        const text = new TextDecoder('gbk').decode(buffer);
        sendResponse({ ok: true, results: LTShared.parseTencentBatch(text) });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || 'error' });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_CNH_RATE') {
    (async () => {
      try {
        const res = await fetch('https://api.frankfurter.dev/latest?from=USD&to=CNH');
        if (!res.ok) throw new Error('rate fetch failed');
        const json = await res.json();
        const rate = json && json.rates && json.rates.CNH;
        sendResponse(rate ? { ok: true, rate: String(rate) } : { ok: false, error: 'no CNH' });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || 'error' });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_DIGEST_DATA') {
    (async () => {
      try {
        const phase = msg.phase === 'post-market' ? 'post-market' : 'pre-market';
        const data = await runDigestCrawl(phase, { force: !!msg.force });
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || 'digest error' });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_MARKET_NEWS') {
    (async () => {
      try {
        const queries = Array.isArray(msg.queries) && msg.queries.length > 0
          ? msg.queries : ['美股 市场 行情 when:3d'];
        const merged = [];
        const seen = new Set();
        for (const q of queries) {
          if (merged.length >= 3) break;
          const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
          const res = await fetch(url);
          if (!res.ok) continue;
          const xml = await res.text();
          const items = LTShared.parseGoogleNewsRss(xml, 5);
          for (const item of items) {
            const key = (item.title || '').toLowerCase().replace(/\s+/g, '');
            if (!key || seen.has(key)) continue;
            seen.add(key);
            merged.push(item);
            if (merged.length >= 3) break;
          }
        }
        sendResponse({ ok: true, headlines: merged });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || 'error' });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_US_INDICES') {
    (async () => {
      try {
        const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=100.SPX,100.IXIC,99.DJI&fields=f57,f58,f2,f3&fltt=2';
        const res = await fetch(url);
        if (!res.ok) throw new Error('fetch failed: ' + res.status);
        const json = await res.json();
        const diff = (json && json.data && Array.isArray(json.data.diff)) ? json.data.diff : [];
        const indices = {};
        for (const item of diff) {
          const code = String(item.f57 || '');
          if (!code) continue;
          indices[code] = {
            ok: true,
            name: item.f58 || code,
            price: item.f2 != null ? String(item.f2) : '—',
            changePct: item.f3 != null ? String(item.f3) : '—',
          };
        }
        sendResponse({ ok: true, indices });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || 'error' });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_MARKET_FLOW') {
    (async () => {
      try {
        const result = await LTCrawler.fetchEastmoneyMarketFlowRealtime();
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || 'error' });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_SECTOR_HOT') {
    (async () => {
      try {
        const fs = encodeURIComponent('m:90+t:2');
        const fields = 'f14,f3,f62,f184';
        const [topRes, botRes] = await Promise.all([
          fetch(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fs}&fields=${fields}`),
          fetch(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&po=0&np=1&fltt=2&invt=2&fid=f3&fs=${fs}&fields=${fields}`)
        ]);
        const parseList = async (r) => {
          if (!r.ok) return [];
          const j = await r.json();
          const diff = (j && j.data && Array.isArray(j.data.diff)) ? j.data.diff : [];
          return diff.map((item) => ({
            name: item.f14 || '',
            changePct: item.f3 != null ? item.f3 : 0,
            mainNetIn: item.f62 != null ? item.f62 : 0,
          })).filter((item) => item.name);
        };
        const [top, bottom] = await Promise.all([parseList(topRes), parseList(botRes)]);
        sendResponse({ ok: true, top, bottom });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || 'error' });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_SECTOR_HEATMAP') {
    (async () => {
      try {
        const fs = encodeURIComponent('m:90+t:2');
        const fields = 'f14,f3,f62';
        const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=7&po=1&np=1&fltt=2&invt=2&fid=f62&fs=${fs}&fields=${fields}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('fetch failed: ' + res.status);
        const j = await res.json();
        const diff = (j && j.data && Array.isArray(j.data.diff)) ? j.data.diff : [];
        const items = diff.map((item) => ({
          name: item.f14 || '',
          changePct: item.f3 != null ? item.f3 : 0,
          mainNetIn: item.f62 != null ? item.f62 : 0,
        })).filter((item) => item.name);
        sendResponse({ ok: true, items });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || 'error' });
      }
    })();
    return true;
  }

  if (msg.type === 'LT_WEIBO_WS_MSG') {
    handleWeiboWsMsg(msg.data).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (msg.type !== 'GET_AI_STOCK_SUMMARY') return;
  (async () => {
    try {
      const code = msg.code || '';
      const name = msg.name || code;
      const headlines = await fetchRecentHeadlines(code, name);
      if (!headlines || headlines.length === 0) {
        sendResponse({ ok: false, error: 'no-headlines' });
        return;
      }
      const lines = LTShared.summarizeHeadlineReasons(headlines, 2);
      if (!lines || lines.length === 0) {
        sendResponse({ ok: false, error: 'summary-empty' });
        return;
      }
      sendResponse({ ok: true, headlines, lines });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || 'AI 摘要失败' });
    }
  })();
  return true;
});
