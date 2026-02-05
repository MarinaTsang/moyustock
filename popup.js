(function () {
  const DEFAULT_STOCK = 'sh600519';
  const MARKET_INDEX_CODE = 'sh000001'; // 上证指数，标题栏常驻，不参与轮播
  const ROTATE_INTERVAL = 5000; // 5秒轮播
  const MAX_DISPLAY = 3; // 最多显示3行
  const FETCH_TIMEOUT_MS = 3000; // 请求超时 3 秒

  const monitorView = document.getElementById('monitor-view');
  const settingsView = document.getElementById('settings-view');
  const stockListEl = document.getElementById('stock-list');
  const marketIndexEl = document.getElementById('market-index');
  const settingsBtn = document.getElementById('settings-btn');
  const backBtn = document.getElementById('back-btn');
  const stockInput = document.getElementById('stock-input');
  const addBtn = document.getElementById('add-btn');
  const settingsStockList = document.getElementById('settings-stock-list');

  let stockList = [];
  let rotateTimer = null;
  let marketIndexTimer = null; // 大盘指数定时刷新
  let currentPage = 0;
  let currentDisplayCodes = []; // 当前显示的股票代码列表
  let lastMarketIndexData = null; // 上次成功的大盘数据，用于失败时保留展示
  let lastStockDataByCode = {};   // 上次成功的各股票数据，用于失败时保留展示
  
  /**
   * 根据代码特征自动补全交易所前缀（用户只需输入数字代码）
   */
  function normalizeStockCode(input) {
    const raw = String(input).trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    if (lower.startsWith('sh') || lower.startsWith('sz') || lower.startsWith('bj') || lower.startsWith('hk')) {
      const prefix = lower.slice(0, 2);
      const rest = raw.slice(2).replace(/\D/g, '');
      return rest ? prefix + rest : raw;
    }
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 5) return 'hk' + digits;
    if (digits.length === 6) {
      const first = digits[0];
      if (first === '6' || first === '9' || first === '5') return 'sh' + digits;
      if (first === '0' || first === '1' || first === '2' || first === '3') return 'sz' + digits;
      if (first === '4' || first === '8') return 'bj' + digits;
    }
    return raw;
  }
  
  // 从 storage 读取股票列表
  async function loadStockList() {
    try {
      const result = await chrome.storage.local.get(['stockList']);
      if (result.stockList && Array.isArray(result.stockList) && result.stockList.length > 0) {
        stockList = result.stockList;
      } else {
        stockList = [DEFAULT_STOCK];
        await chrome.storage.local.set({ stockList });
      }
      return stockList;
    } catch (err) {
      console.error('读取失败:', err);
      stockList = [DEFAULT_STOCK];
      return stockList;
    }
  }
  
  // 保存股票列表到 storage
  async function saveStockList() {
    try {
      await chrome.storage.local.set({ stockList });
      console.log('保存成功:', stockList);
      return true;
    } catch (err) {
      console.error('保存失败:', err);
      return false;
    }
  }
  
  // 初始化：无网时仅显示离线状态，不发起请求
  async function init() {
    await loadStockList();
    renderSettings();
    if (!navigator.onLine) {
      showOfflineState();
      return;
    }
    renderMonitor();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fetchData();
    });
    window.addEventListener('online', () => {
      renderMonitor(); // 重连后完整渲染并启动定时器
    });
    window.addEventListener('offline', () => {
      showOfflineState();
    });
  }
  
  // 获取股票数据（通过 background），带 3 秒超时
  function fetchStock(code) {
    const fetchPromise = new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_STOCK', code }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { ok: false, error: '未知错误' });
      });
    });
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, error: '请求超时' }), FETCH_TIMEOUT_MS);
    });
    return Promise.race([fetchPromise, timeoutPromise]);
  }
  
  // HTML 转义
  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
  
  /**
   * 创建一个股票行 DOM 元素（带占位符）
   */
  function createStockRow(code) {
    const row = document.createElement('div');
    row.className = 'stock-item';
    row.id = 'row-' + code;
    row.innerHTML = `
      <span class="stock-name" id="name-${code}">加载中…</span>
      <span class="stock-price" id="price-${code}">—</span>
      <span class="stock-change" id="change-${code}">—</span>
    `;
    return row;
  }
  
  /**
   * 更新一个股票行的数据（无闪烁）。失败时保留旧数据并标为过时，无旧数据则显示「网络重连中…」
   */
  function updateStockRow(code, data) {
    const nameEl = document.getElementById('name-' + code);
    const priceEl = document.getElementById('price-' + code);
    const changeEl = document.getElementById('change-' + code);
    const rowEl = document.getElementById('row-' + code);

    if (!nameEl || !priceEl || !changeEl || !rowEl) return;

    if (!data || !data.ok) {
      const cached = lastStockDataByCode[code];
      if (cached) {
        nameEl.textContent = cached.name || '—';
        priceEl.textContent = cached.price || '—';
        changeEl.textContent = cached.changeText || '—';
        priceEl.className = 'stock-price ' + (cached.priceCls || '');
        changeEl.className = 'stock-change ' + (cached.changeCls || '');
        rowEl.className = 'stock-item stale';
      } else {
        nameEl.textContent = code;
        priceEl.textContent = '';
        changeEl.textContent = '网络重连中…';
        rowEl.className = 'stock-item error';
        priceEl.className = 'stock-price';
        changeEl.className = 'stock-change';
      }
      return;
    }

    const name = data.name || '—';
    const price = data.price || '—';
    const n = parseFloat(data.changePct);
    const cls = isNaN(n) ? '' : (n >= 0 ? 'up' : 'down');
    const sign = isNaN(n) ? '' : (n >= 0 ? '+' : '');
    const changeText = sign + (data.changePct || '—') + '%';
    lastStockDataByCode[code] = { name, price, changeText, priceCls: cls, changeCls: cls };

    rowEl.className = 'stock-item';
    nameEl.textContent = name;
    priceEl.textContent = price;
    changeEl.textContent = changeText;
    priceEl.className = 'stock-price ' + cls;
    changeEl.className = 'stock-change ' + cls;
  }
  
  /**
   * 轮播用股票列表（剔除 sh000001，避免与标题栏重复）
   */
  function getRotateList() {
    return stockList.filter(code => code !== MARKET_INDEX_CODE);
  }

  /**
   * 更新标题栏大盘指数（sh000001），失败时保留旧数据并显示过时/离线状态
   */
  async function updateMarketIndex() {
    if (!marketIndexEl) return;
    try {
      const data = await fetchStock(MARKET_INDEX_CODE);
      if (!data || !data.ok) {
        if (lastMarketIndexData) {
          marketIndexEl.innerHTML = `<span class="idx-value ${lastMarketIndexData.cls}">${lastMarketIndexData.price}</span><span class="idx-pct ${lastMarketIndexData.cls}">${lastMarketIndexData.pct}</span><span class="status-stale">数据可能过时</span>`;
        } else {
          marketIndexEl.innerHTML = '<span class="status-stale">网络重连中…</span>';
        }
        return;
      }
      const price = data.price || '—';
      const n = parseFloat(data.changePct);
      const cls = isNaN(n) ? 'neutral' : (n >= 0 ? 'up' : 'down');
      const sign = isNaN(n) ? '' : (n >= 0 ? '+' : '');
      const pct = isNaN(n) ? '—' : (sign + (data.changePct || '') + '%');
      lastMarketIndexData = { price, pct, cls };
      marketIndexEl.innerHTML = `<span class="idx-value ${cls}">${price}</span><span class="idx-pct ${cls}">${pct}</span>`;
    } catch {
      if (lastMarketIndexData) {
        marketIndexEl.innerHTML = `<span class="idx-value ${lastMarketIndexData.cls}">${lastMarketIndexData.price}</span><span class="idx-pct ${lastMarketIndexData.cls}">${lastMarketIndexData.pct}</span><span class="status-stale">数据可能过时</span>`;
      } else {
        marketIndexEl.innerHTML = '<span class="status-stale">网络重连中…</span>';
      }
    }
  }

  /** 离线时标题栏显示 */
  function showOfflineState() {
    if (!marketIndexEl) return;
    lastMarketIndexData = null;
    marketIndexEl.innerHTML = '<span class="status-offline">离线</span>';
    if (stockListEl) {
      stockListEl.innerHTML = '<div class="stock-item empty">网络不可用</div>';
    }
  }

  /**
   * 仅拉取并刷新数据（不重建 DOM），用于智能唤醒、重连后立即刷新
   */
  async function fetchData() {
    if (!navigator.onLine) return;
    await updateMarketIndex();
    if (currentDisplayCodes.length === 0) return;
    const promises = currentDisplayCodes.map(code =>
      fetchStock(code).then(data => ({ code, data }))
    );
    const results = await Promise.all(promises);
    results.forEach(({ code, data }) => updateStockRow(code, data));
  }

  /**
   * 渲染 Monitor 界面（无闪烁更新）
   */
  async function renderMonitor() {
    const rotateList = getRotateList();
    await updateMarketIndex();
    if (rotateList.length === 0) {
      stockListEl.innerHTML = '<div class="stock-item empty">暂无股票</div>';
      currentDisplayCodes = [];
      return;
    }
    
    // 计算当前页要显示的股票（使用剔除后的列表）
    const totalPages = Math.ceil(rotateList.length / MAX_DISPLAY);
    const startIdx = currentPage * MAX_DISPLAY;
    const endIdx = Math.min(startIdx + MAX_DISPLAY, rotateList.length);
    const displayStocks = rotateList.slice(startIdx, endIdx);
    
    // 检查是否需要重建 DOM（换页或股票列表变化）
    const needsRebuild = !arraysEqual(displayStocks, currentDisplayCodes);
    
    if (needsRebuild) {
      // 需要重建 DOM 结构
      stockListEl.innerHTML = '';
      displayStocks.forEach(code => {
        stockListEl.appendChild(createStockRow(code));
      });
      currentDisplayCodes = [...displayStocks];
    }
    
    // 获取每个股票的数据并更新（不重建 DOM）
    const promises = displayStocks.map(code => 
      fetchStock(code).then(data => ({ code, data }))
    );
    
    const results = await Promise.all(promises);
    
    // 只更新数据，不重建 DOM
    results.forEach(({ code, data }) => {
      updateStockRow(code, data);
    });
    
    // 如果超过3个，启动轮播（按剔除后的数量）
    if (rotateList.length > MAX_DISPLAY) {
      if (rotateTimer) clearInterval(rotateTimer);
      rotateTimer = setInterval(() => {
        currentPage = (currentPage + 1) % totalPages;
        renderMonitor(); // 每次轮播也会刷新大盘指数
      }, ROTATE_INTERVAL);
    } else {
      if (rotateTimer) {
        clearInterval(rotateTimer);
        rotateTimer = null;
      }
      currentPage = 0;
    }
    if (!marketIndexTimer) {
      marketIndexTimer = setInterval(updateMarketIndex, ROTATE_INTERVAL);
    }
  }
  
  /**
   * 比较两个数组是否相等
   */
  function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  
  // 渲染 Settings 界面
  function renderSettings() {
    if (stockList.length === 0) {
      settingsStockList.innerHTML = '<li class="empty-tip">暂无股票，请添加</li>';
      return;
    }
    settingsStockList.innerHTML = stockList.map((code, idx) => `
      <li class="stock-list-item">
        <span class="stock-code">${escapeHtml(code)}</span>
        <button class="delete-btn" data-index="${idx}">删除</button>
      </li>
    `).join('');
    
    settingsStockList.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.index);
        if (idx >= 0 && idx < stockList.length) {
          stockList.splice(idx, 1);
          if (stockList.length === 0) {
            stockList = [DEFAULT_STOCK];
          }
          await saveStockList();
          await loadStockList();
          currentDisplayCodes = []; // 强制重建
          renderSettings();
          renderMonitor();
        }
      });
    });
  }
  
  // 添加股票
  async function addStock() {
    const raw = stockInput.value.trim();
    if (!raw) {
      alert('请输入股票代码');
      return;
    }
    const code = normalizeStockCode(raw);
    if (!code) {
      alert('股票代码格式不正确');
      stockInput.value = '';
      return;
    }
    if (stockList.includes(code)) {
      alert('该股票已存在');
      stockInput.value = '';
      return;
    }
    stockList.push(code);
    stockInput.value = '';
    try {
      const saved = await saveStockList();
      if (saved) {
        await loadStockList();
        currentDisplayCodes = []; // 强制重建
        renderSettings();
      } else {
        alert('保存失败，请重试');
      }
    } catch (err) {
      console.error('添加股票失败:', err);
      alert('保存失败: ' + (err.message || '请重试'));
    }
  }
  
  // 切换到 Settings
  function showSettings() {
    monitorView.style.display = 'none';
    settingsView.style.display = 'block';
    if (rotateTimer) {
      clearInterval(rotateTimer);
      rotateTimer = null;
    }
    if (marketIndexTimer) {
      clearInterval(marketIndexTimer);
      marketIndexTimer = null;
    }
  }
  
  // 切换到 Monitor
  async function showMonitor() {
    settingsView.style.display = 'none';
    monitorView.style.display = 'block';
    await loadStockList();
    currentPage = 0;
    currentDisplayCodes = []; // 强制重建
    if (marketIndexTimer) clearInterval(marketIndexTimer);
    marketIndexTimer = null;
    renderMonitor();
  }
  
  // 事件绑定
  settingsBtn.addEventListener('click', showSettings);
  backBtn.addEventListener('click', showMonitor);
  addBtn.addEventListener('click', addStock);
  stockInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addStock();
    }
  });
  
  // 初始化
  init();
})();
