(function () {
  const shared = globalThis.LTShared;
  const market = globalThis.LTMarket;
  const DEFAULT_STOCK = 'sh600519';
  const BOSS_KEY_STORAGE = 'userHidden';
  const DISPLAY_MODE_STORAGE = 'displayMode';

  if (!shared || !market) {
    console.error('Popup 依赖未加载');
    return;
  }

  const wakeBtn = document.getElementById('wake-float-btn');
  const stockInput = document.getElementById('stock-input');
  const addBtn = document.getElementById('add-btn');
  const stockListEl = document.getElementById('stock-list');
  const statusEl = document.getElementById('status-text');
  const summaryEl = document.getElementById('summary-text');
  const hiddenStateEl = document.getElementById('hidden-state');
  const tradingStateEl = document.getElementById('trading-state');
  const updateTimeEl = document.getElementById('update-time');

  let stockList = [];
  let stockNamesCache = {};

  async function loadStockList() {
    try {
      const result = await chrome.storage.local.get(['stockList']);
      if (Array.isArray(result.stockList) && result.stockList.length > 0) {
        stockList = result.stockList;
      } else {
        stockList = [DEFAULT_STOCK];
        await chrome.storage.local.set({ stockList });
      }
    } catch (err) {
      console.error('读取自选失败:', err);
      stockList = [DEFAULT_STOCK];
    }
    return stockList;
  }

  async function saveStockList() {
    await chrome.storage.local.set({ stockList });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getTradingSummary() {
    const now = new Date();
    const tradingCount = stockList.filter((code) => market.isInTradingTime(code, now)).length;
    return {
      total: stockList.length,
      trading: tradingCount
    };
  }

  async function renderDebugInfo() {
    const storage = await chrome.storage.local.get([BOSS_KEY_STORAGE, DISPLAY_MODE_STORAGE]);
    const summary = getTradingSummary();
    hiddenStateEl.textContent = storage[BOSS_KEY_STORAGE] ? '已隐藏' : '显示中';
    tradingStateEl.textContent = `${summary.trading} / ${summary.total} 交易中`;
    updateTimeEl.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    summaryEl.textContent = summary.total > 0
      ? `当前维护 ${summary.total} 只自选`
      : '当前没有自选股票。';
  }

  async function fetchStockNames() {
    const codes = stockList.slice();
    await Promise.all(codes.map(async (code) => {
      if (stockNamesCache[code]) return;
      try {
        const data = await chrome.runtime.sendMessage({ type: 'GET_STOCK', code });
        if (data && data.ok && data.name) stockNamesCache[code] = data.name;
      } catch (_) { }
    }));
  }

  function renderStockList() {
    if (stockList.length === 0) {
      stockListEl.innerHTML = '<li class="empty-tip">暂无股票，请添加</li>';
      return;
    }

    const now = new Date();
    stockListEl.innerHTML = stockList.map((code, idx) => {
      const trading = market.isInTradingTime(code, now);
      const name = stockNamesCache[code];
      return `
        <li class="stock-list-item">
          <div class="stock-main">
            <div class="stock-info">
              ${name ? `<span class="stock-name">${escapeHtml(name)}</span>` : ''}
              <span class="stock-code">${escapeHtml(code)}</span>
            </div>
            <span class="stock-state ${trading ? 'is-trading' : 'is-closed'}">${trading ? '交易中' : '休市'}</span>
          </div>
          <button class="delete-btn" data-index="${idx}">删除</button>
        </li>
      `;
    }).join('');

    stockListEl.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.index, 10);
        if (Number.isNaN(idx) || idx < 0 || idx >= stockList.length) return;
        stockList.splice(idx, 1);
        if (stockList.length === 0) {
          stockList = [DEFAULT_STOCK];
        }
        await saveStockList();
        renderStockList();
        await renderDebugInfo();
        statusEl.textContent = '已更新自选列表';
      });
    });
  }

  async function addStock() {
    const raw = stockInput.value.trim();
    if (!raw) {
      statusEl.textContent = '请输入股票代码';
      return;
    }

    const code = shared.normalizeStockCode(raw);
    if (!code) {
      statusEl.textContent = '股票代码格式不正确';
      stockInput.value = '';
      return;
    }
    if (stockList.includes(code)) {
      statusEl.textContent = '该股票已存在';
      stockInput.value = '';
      return;
    }

    stockList.push(code);
    stockInput.value = '';
    await saveStockList();
    renderStockList();
    await renderDebugInfo();
    statusEl.textContent = `已添加 ${code}`;
  }

  async function wakeCurrentTabFloat() {
    statusEl.textContent = '正在唤醒当前页浮窗...';
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        statusEl.textContent = '未找到当前标签页';
        return;
      }
      if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
        statusEl.textContent = '当前页面不支持浮窗（请先切换到普通网页）';
        return;
      }
      const res = await chrome.runtime.sendMessage({ type: 'SHOW_FLOAT_IN_TAB', tabId: tab.id });
      statusEl.textContent = res && res.ok ? '当前页浮窗已唤醒' : '当前页浮窗唤醒失败';
    } catch (err) {
      statusEl.textContent = '浮窗未就绪，请刷新目标页面后重试';
    }
  }

  const digestSectionEl = document.getElementById('digest-section');
  const digestTitleEl = document.getElementById('digest-title');
  const digestCardsEl = document.getElementById('digest-cards');
  const digestRefreshBtn = document.getElementById('digest-refresh-btn');

  function getMarketPhase() {
    const now = new Date();
    const day = now.getDay();
    const t = now.getHours() * 60 + now.getMinutes();
    if (day === 0 || day === 6) return 'weekend';
    if (t < 15 * 60) return 'pre-market';  // 9:30 前和交易时间都显示盘前预览
    return 'post-market';
  }

  function isTradingNow() {
    const now = new Date();
    const day = now.getDay();
    const t = now.getHours() * 60 + now.getMinutes();
    return day >= 1 && day <= 5 && t >= 9 * 60 + 30 && t < 15 * 60;
  }

  function truncateTitle(title, max = 50) {
    const s = String(title || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  // ===== Digest 常量 =====
  const OVERVIEW_US = ['usSPY', 'usQQQ', 'usDIA'];
  const OVERVIEW_CN = ['usKWEB', 'usYINN', 'usBABA', 'hk00700'];
  const INDEX_A = ['sh000001', 'sz399001', 'sz399006'];
  const INDEX_EXT = ['hkHSI', 'usSPY', 'usQQQ'];
  const MKTLABEL = {
    usSPY: 'S&P500 (SPY)', usQQQ: '纳斯达克 (QQQ)', usDIA: '道琼斯 (DIA)',
    usKWEB: '中概 (KWEB)', usYINN: '中国牛3X (YINN)', usBABA: '阿里 ADR',
    hk00700: '腾讯 (港)', sh000001: '上证指数', sz399001: '深证成指',
    sz399006: '创业板指', hkHSI: '恒生指数',
  };

  // ===== Digest DOM 工具 =====
  function mkEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function makeSection(label) {
    const sec = mkEl('div', 'digest-sec');
    if (label) sec.appendChild(mkEl('div', 'digest-sec-label', label));
    const body = mkEl('div', 'digest-sec-body');
    sec.appendChild(body);
    return { sec, body };
  }

  function pctDir(pctStr) {
    const n = parseFloat(pctStr);
    return isNaN(n) ? 'flat' : n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  }

  function fmtPct(pctStr) {
    const n = parseFloat(pctStr);
    if (isNaN(n)) return pctStr || '—';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function makeMarketRow(label, data) {
    const row = mkEl('div', 'digest-row');
    row.appendChild(mkEl('span', 'digest-row-name', label));
    const right = mkEl('div', 'digest-row-right');
    if (!data || !data.ok) {
      right.appendChild(mkEl('span', 'digest-row-price', '—'));
      right.appendChild(mkEl('span', 'digest-row-pct flat', '—'));
    } else {
      right.appendChild(mkEl('span', 'digest-row-price', data.price));
      right.appendChild(mkEl('span', `digest-row-pct ${pctDir(data.changePct)}`, fmtPct(data.changePct)));
    }
    row.appendChild(right);
    return row;
  }

  function makeInfoRow(label, value) {
    const row = mkEl('div', 'digest-row');
    row.appendChild(mkEl('span', 'digest-row-name', label));
    const right = mkEl('div', 'digest-row-right');
    right.appendChild(mkEl('span', 'digest-row-price', value || '—'));
    row.appendChild(right);
    return row;
  }

  function makeGroupCard(groupTitle, codes, dataMap) {
    const card = mkEl('div', 'digest-group-card');
    if (groupTitle) card.appendChild(mkEl('div', 'digest-group-title', groupTitle));
    for (const code of codes) {
      card.appendChild(makeMarketRow(MKTLABEL[code] || code, dataMap[code]));
    }
    return card;
  }

  function makeReviewCard(name, data) {
    const card = mkEl('div', 'digest-review-card');
    const header = mkEl('div', 'digest-review-header');
    header.appendChild(mkEl('span', 'digest-review-name', name));
    if (data && data.ok) {
      header.appendChild(mkEl('span', `digest-row-pct ${pctDir(data.changePct)}`, fmtPct(data.changePct)));
    }
    card.appendChild(header);
    if (data && data.ok) {
      const stats = mkEl('div', 'digest-review-stats');
      const fields = [['收', data.price], ['高', data.high], ['低', data.low]];
      if (data.turnoverRate && data.turnoverRate !== '—') fields.push(['换手', data.turnoverRate + '%']);
      for (const [lbl, val] of fields) {
        const item = mkEl('span', 'digest-stat-item');
        item.appendChild(mkEl('span', 'digest-stat-label', lbl));
        item.appendChild(document.createTextNode(val || '—'));
        stats.appendChild(item);
      }
      card.appendChild(stats);
    }
    return card;
  }

  function formatMoney(value) {
    const n = parseFloat(value);
    if (isNaN(n) || n === 0) return '—';
    const abs = Math.abs(n);
    const sign = n > 0 ? '+' : (n < 0 ? '-' : '');
    if (abs >= 1e8) return sign + (abs / 1e8).toFixed(2) + '亿';
    if (abs >= 1e4) return sign + (abs / 1e4).toFixed(2) + '万';
    return sign + abs.toFixed(0);
  }

  function renderSimpleList(body, items, emptyText) {
    body.innerHTML = '';
    if (!Array.isArray(items) || items.length === 0) {
      body.appendChild(mkEl('div', 'digest-loading', emptyText || '暂无数据'));
      return;
    }
    const ul = mkEl('ul', 'digest-news-list');
    items.slice(0, 5).forEach((item) => {
      const text = typeof item === 'string' ? item : (item.title || item.text || '');
      if (!text) return;
      ul.appendChild(mkEl('li', '', text));
    });
    body.appendChild(ul);
  }

  function formatFlowValue(value) {
    const n = parseFloat(value);
    if (isNaN(n) || n === 0) return '—';
    const abs = Math.abs(n);
    const sign = n > 0 ? '+' : (n < 0 ? '-' : '');
    if (abs >= 1e8) return sign + (abs / 1e8).toFixed(2) + '亿';
    if (abs >= 1e4) return sign + (abs / 1e4).toFixed(2) + '万';
    return sign + abs.toFixed(0);
  }

  function renderTileGrid(body, items, emptyText) {
    if (!Array.isArray(items) || items.length === 0) {
      body.appendChild(mkEl('div', 'digest-loading', emptyText || '暂无数据'));
      return;
    }
    const grid = mkEl('div', 'digest-tiles');
    items.slice(0, 7).forEach((item) => {
      const name = item.name || item.title || '—';
      const pct = typeof item.changePct === 'number' ? item.changePct : parseFloat(item.changePct);
      const netIn = typeof item.mainNetIn === 'number' ? item.mainNetIn : parseFloat(item.mainNetIn);
      const dir = (!isNaN(pct) ? pct : netIn) >= 0 ? 'up' : 'down';
      const tile = mkEl('div', `digest-tile ${dir}`);
      tile.appendChild(mkEl('div', 'digest-tile-name', name));
      tile.appendChild(mkEl('div', 'digest-tile-value', formatFlowValue(netIn)));
      tile.appendChild(mkEl('div', 'digest-tile-pct', fmtPct(pct)));
      grid.appendChild(tile);
    });
    body.appendChild(grid);
  }

  function renderHeatmap(body, sectors) {
    if (!Array.isArray(sectors) || !sectors.length) {
      body.appendChild(mkEl('div', 'digest-loading', '暂无板块数据'));
      return;
    }
    const sorted = [...sectors].sort((a, b) => Math.abs(b.mainNetIn) - Math.abs(a.mainNetIn));
    const total = sorted.reduce((s, x) => s + Math.abs(x.mainNetIn), 0) || 1;
    let splitIdx = Math.max(1, Math.floor(sorted.length / 2));
    let cumulative = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      cumulative += Math.abs(sorted[i].mainNetIn);
      if (cumulative / total >= 0.5) { splitIdx = i + 1; break; }
    }
    const hm = mkEl('div', 'digest-heatmap');
    [sorted.slice(0, splitIdx), sorted.slice(splitIdx)].forEach((row) => {
      if (!row.length) return;
      const rowEl = mkEl('div', 'digest-heatmap-row');
      const rowTotal = row.reduce((s, x) => s + Math.abs(x.mainNetIn), 0) || 1;
      row.forEach((s) => {
        const tile = mkEl('div', `digest-heatmap-tile ${s.changePct >= 0 ? 'up' : 'down'}`);
        tile.style.flexGrow = Math.round(Math.abs(s.mainNetIn) / rowTotal * 100);
        tile.appendChild(mkEl('div', 'hm-name', s.name));
        tile.appendChild(mkEl('div', 'hm-net', formatFlowValue(s.mainNetIn)));
        tile.appendChild(mkEl('div', 'hm-pct', fmtPct(s.changePct)));
        rowEl.appendChild(tile);
      });
      hm.appendChild(rowEl);
    });
    body.appendChild(hm);
  }

  async function fetchDigestData(phase, force = false) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_DIGEST_DATA', phase, force });
      return res && res.ok ? res.data : null;
    } catch (_) { return null; }
  }

  // ===== Digest 数据获取 =====
  async function fetchBatch(codes) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_STOCKS_BATCH', codes });
      if (!res || !res.ok || !Array.isArray(res.results)) return {};
      const map = {};
      for (const item of res.results) {
        map[item.rawCode] = item;
        if (item.rawCode && item.ok && item.name && item.name !== '—') {
          stockNamesCache[item.rawCode] = item.name;
        }
      }
      return map;
    } catch (_) { return {}; }
  }

  async function fetchCNH() {
    try { return await chrome.runtime.sendMessage({ type: 'GET_CNH_RATE' }); }
    catch (_) { return null; }
  }

  // ===== 开盘前速览 =====
  async function renderPreMarket(container) {
    container.innerHTML = '';
    const digestPromise = fetchDigestData('pre-market');

    // 1. 外盘行情
    const { sec: mktSec, body: mktBody } = makeSection('外盘行情');
    mktBody.appendChild(mkEl('div', 'digest-loading', '行情数据加载中…'));
    container.appendChild(mktSec);

    const PRE_US_LABELS = { SPX: 'S&P 500', IXIC: '纳斯达克', DJI: '道琼斯' };
    const [cnData, cnh, usIxPre] = await Promise.all([
      fetchBatch(OVERVIEW_CN),
      fetchCNH(),
      chrome.runtime.sendMessage({ type: 'GET_US_INDICES' }).catch(() => null),
    ]);

    mktBody.innerHTML = '';
    if (usIxPre && usIxPre.ok && usIxPre.indices) {
      const usCard = mkEl('div', 'digest-group-card');
      usCard.appendChild(mkEl('div', 'digest-group-title', '美股三大指数'));
      ['SPX', 'IXIC', 'DJI'].forEach((k) => {
        usCard.appendChild(makeMarketRow(PRE_US_LABELS[k], usIxPre.indices[k]));
      });
      mktBody.appendChild(usCard);
    } else {
      const fallback = await fetchBatch(OVERVIEW_US);
      mktBody.appendChild(makeGroupCard('美股指数(ETF)', OVERVIEW_US, fallback));
    }
    mktBody.appendChild(makeGroupCard('中概 / 港股', OVERVIEW_CN, cnData));

    if (cnh && cnh.ok && cnh.rate) {
      const cnhRow = mkEl('div', 'digest-cnh-row');
      cnhRow.appendChild(mkEl('span', '', '离岸人民币'));
      cnhRow.appendChild(mkEl('span', 'digest-cnh-rate', `USD/CNH  ${parseFloat(cnh.rate).toFixed(4)}`));
      mktBody.appendChild(cnhRow);
    }

    // 2. 自选美股盘前（如有）
    const usStocks = stockList.filter((c) => c.startsWith('us'));
    if (usStocks.length > 0) {
      const { sec, body } = makeSection('自选美股盘前');
      const usMap = await fetchBatch(usStocks);
      usStocks.forEach((code) => {
        const name = stockNamesCache[code] || (usMap[code] && usMap[code].name) || code;
        body.appendChild(makeMarketRow(name, usMap[code]));
      });
      container.appendChild(sec);
    }

    // 3. 今日大事（财经日历）
    const { sec: calSec, body: calBody } = makeSection('今日大事（财经日历）');
    calBody.appendChild(mkEl('div', 'digest-loading', '加载中…'));
    container.appendChild(calSec);

    // 4. 财报预告
    const { sec: earnSec, body: earnBody } = makeSection('财报预告');
    earnBody.appendChild(mkEl('div', 'digest-loading', '加载中…'));
    container.appendChild(earnSec);

    // 5. 隔夜重大新闻（异步）
    const { sec: newsSec, body: newsBody } = makeSection('隔夜重大新闻');
    newsBody.appendChild(mkEl('div', 'digest-loading', '加载中…'));
    container.appendChild(newsSec);

    digestPromise.then((digest) => {
      renderSimpleList(calBody, digest && digest.calendar, '暂无日历数据');
      renderSimpleList(earnBody, digest && digest.earnings, '暂无财报预告');
      const overnight = digest && Array.isArray(digest.overnight) ? digest.overnight : [];
      if (overnight.length > 0) {
        renderSimpleList(newsBody, overnight, '暂无重大新闻');
        return;
      }
      chrome.runtime.sendMessage({
        type: 'GET_MARKET_NEWS',
        queries: ['美股 道琼斯 纳斯达克 when:3d', 'A股 板块 宏观政策 when:3d'],
      }).then((res) => {
        newsBody.innerHTML = '';
        const items = res && res.ok && Array.isArray(res.headlines) ? res.headlines : [];
        if (!items.length) { newsBody.appendChild(mkEl('div', 'digest-loading', '暂无近期新闻')); return; }
        const ul = mkEl('ul', 'digest-news-list');
        items.slice(0, 3).forEach((h) => ul.appendChild(mkEl('li', '', truncateTitle(h.title))));
        newsBody.appendChild(ul);
      }).catch(() => { newsBody.innerHTML = ''; newsBody.appendChild(mkEl('div', 'digest-loading', '新闻加载失败')); });
    }).catch(() => {
      renderSimpleList(calBody, [], '日历加载失败');
      renderSimpleList(earnBody, [], '财报加载失败');
      renderSimpleList(newsBody, [], '新闻加载失败');
    });
  }

  // ===== 盘后总结 =====
  async function renderPostMarket(container) {
    container.innerHTML = '';

    const list = stockList.length > 0 ? stockList : [DEFAULT_STOCK];
    const US_IX_LABELS = { SPX: 'S&P 500', IXIC: '纳斯达克', DJI: '道琼斯' };

    // 1. 自选股复盘
    const { sec: stkSec, body: stkBody } = makeSection('自选股复盘');
    stkBody.appendChild(mkEl('div', 'digest-loading', '数据加载中…'));
    container.appendChild(stkSec);

    // 2. 大盘收盘
    const { sec: idxSec, body: idxBody } = makeSection('大盘收盘');
    idxBody.appendChild(mkEl('div', 'digest-loading', '数据加载中…'));
    container.appendChild(idxSec);

    const [idxMap, stkMap, usIx] = await Promise.all([
      fetchBatch([...INDEX_A, 'hkHSI']),
      fetchBatch(list),
      chrome.runtime.sendMessage({ type: 'GET_US_INDICES' }).catch(() => null),
    ]);

    stkBody.innerHTML = '';
    for (const code of list) {
      const name = stockNamesCache[code] || (stkMap[code] && stkMap[code].name) || code;
      stkBody.appendChild(makeReviewCard(name, stkMap[code]));
    }

    idxBody.innerHTML = '';
    idxBody.appendChild(makeGroupCard('A股', INDEX_A, idxMap));
    idxBody.appendChild(makeGroupCard('港股', ['hkHSI'], idxMap));
    if (usIx && usIx.ok && usIx.indices) {
      const usCard = mkEl('div', 'digest-group-card');
      usCard.appendChild(mkEl('div', 'digest-group-title', '美股指数'));
      ['SPX', 'IXIC', 'DJI'].forEach((k) => {
        usCard.appendChild(makeMarketRow(US_IX_LABELS[k], usIx.indices[k]));
      });
      idxBody.appendChild(usCard);
    }

    // 3. 资金动向（依赖 digest）
    const { sec: flowSec, body: flowBody } = makeSection('资金动向');
    flowBody.appendChild(mkEl('div', 'digest-loading', '加载中…'));
    container.appendChild(flowSec);

    fetchDigestData('post-market').then((digest) => {
      flowBody.innerHTML = '';
      const flow = digest && digest.fundFlow && digest.fundFlow.ok ? digest.fundFlow : null;
      if (flow && (flow.sh || flow.sz)) {
        const rows = mkEl('div', 'digest-flow-list');
        if (flow.sh) {
          rows.appendChild(makeInfoRow('上证主力净流入', `${formatMoney(flow.sh.mainNetIn)}（${flow.sh.mainRatio || 0}%）`));
          rows.appendChild(makeInfoRow('上证超大单净流入', `${formatMoney(flow.sh.superNetIn)}（${flow.sh.superRatio || 0}%）`));
        }
        if (flow.sz) {
          rows.appendChild(makeInfoRow('深证主力净流入', `${formatMoney(flow.sz.mainNetIn)}（${flow.sz.mainRatio || 0}%）`));
          rows.appendChild(makeInfoRow('深证超大单净流入', `${formatMoney(flow.sz.superNetIn)}（${flow.sz.superRatio || 0}%）`));
        }
        flowBody.appendChild(rows);
      } else {
        flowBody.appendChild(mkEl('div', 'digest-loading', '暂无资金流向数据'));
      }
    }).catch(() => {
      flowBody.innerHTML = '';
      flowBody.appendChild(mkEl('div', 'digest-loading', '资金流向加载失败'));
    });

    // 4. 今日新闻（仅加载一次，不自动刷新）
    const { sec: newsSec, body: newsBody } = makeSection('今日新闻');
    newsBody.appendChild(mkEl('div', 'digest-loading', '加载中…'));
    container.appendChild(newsSec);

    Promise.all(
      list.map((code) => chrome.runtime.sendMessage({
        type: 'GET_AI_STOCK_SUMMARY', code, name: stockNamesCache[code] || code,
      }).catch(() => null))
    ).then((results) => {
      newsBody.innerHTML = '';
      let any = false;
      for (let i = 0; i < list.length; i++) {
        const res = results[i];
        if (!res || !res.ok || !Array.isArray(res.headlines) || !res.headlines.length) continue;
        any = true;
        newsBody.appendChild(mkEl('div', 'digest-news-stock-name', stockNamesCache[list[i]] || list[i]));
        const ul = mkEl('ul', 'digest-news-list');
        res.headlines.forEach((h) => ul.appendChild(mkEl('li', '', truncateTitle(h.title))));
        newsBody.appendChild(ul);
      }
      if (!any) newsBody.appendChild(mkEl('div', 'digest-loading', '暂无近期新闻'));
    });

    // 5. 行业热度（独立获取，不依赖 digest）
    const { sec: sectorSec, body: sectorBody } = makeSection('行业热度');
    sectorBody.appendChild(mkEl('div', 'digest-loading', '加载中…'));
    container.appendChild(sectorSec);

    chrome.runtime.sendMessage({ type: 'GET_SECTOR_HEATMAP' })
      .catch(() => null)
      .then((sectorRes) => {
        sectorBody.innerHTML = '';
        renderHeatmap(sectorBody, sectorRes && sectorRes.ok ? sectorRes.items : []);
      });
  }

  // ===== 主入口 =====
  async function loadDigest(phase) {
    if (!digestSectionEl) return;
    digestSectionEl.style.display = '';
    digestTitleEl.textContent = phase === 'post-market' ? '盘后总结' : '开盘前速览';
    digestCardsEl.innerHTML = '';
    if (phase === 'post-market') {
      await renderPostMarket(digestCardsEl);
    } else {
      await renderPreMarket(digestCardsEl);
    }
  }

  function bindDigestRefresh() {
    if (!digestRefreshBtn || digestRefreshBound) return;
    digestRefreshBound = true;
    let refreshing = false;
    digestRefreshBtn.addEventListener('click', async () => {
      if (refreshing) return;
      refreshing = true;
      digestRefreshBtn.classList.add('spinning');
      try { await loadDigest(currentDigestPhase); } finally {
        setTimeout(() => { digestRefreshBtn.classList.remove('spinning'); refreshing = false; }, 800);
      }
    });
  }

  let currentDigestPhase = null;
  let digestRefreshTimer = null;
  let digestRefreshBound = false;

  function scheduleDigestRefresh() {
    if (digestRefreshTimer) return;
    const phase = getMarketPhase();
    if (phase === 'post-market' || phase === 'weekend') return;  // 盘后不自动刷新
    const delay = 30 * 60 * 1000;  // 统一30分钟，盘前无需频繁刷新
    digestRefreshTimer = setTimeout(async () => {
      digestRefreshTimer = null;
      const newPhase = getMarketPhase();
      if (newPhase === 'weekend' || newPhase === 'post-market') return;
      if (newPhase !== currentDigestPhase) {
        currentDigestPhase = newPhase;
        await loadDigest(newPhase);
      } else {
        await loadDigest(newPhase).catch(() => {});
      }
      scheduleDigestRefresh();
    }, delay);
  }

  async function startDigestAutoRefresh() {
    const phase = getMarketPhase();
    if (phase === 'weekend') return;
    currentDigestPhase = phase;
    await loadDigest(phase);
    bindDigestRefresh();
    scheduleDigestRefresh();
  }

  async function init() {
    await loadStockList();
    fetchStockNames().then(() => renderStockList()); // 异步加载名称后刷新列表
    renderStockList(); // 先渲染一次（无名称）
    await renderDebugInfo();
    statusEl.textContent = '网页浮窗负责监控，当前面板仅做设置和状态查看';
    await startDigestAutoRefresh();
  }

  wakeBtn.addEventListener('click', wakeCurrentTabFloat);
  addBtn.addEventListener('click', addStock);
  stockInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addStock();
  });

  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.stockList) {
      await loadStockList();
      await fetchStockNames();
      renderStockList();
    }
    if (changes.stockList || changes[BOSS_KEY_STORAGE] || changes[DISPLAY_MODE_STORAGE]) {
      await renderDebugInfo();
    }
  });

  init();
})();
