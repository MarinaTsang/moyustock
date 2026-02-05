// 可注入的页面：仅 http/https 网页
function isInjectableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

// 向指定标签页注入悬浮窗（用于已打开的标签切换过来时补注）
function injectIntoTab(tabId) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !isInjectableUrl(tab.url)) return;
    chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
  });
}

// 切换标签时补注：这样在「已打开的旧标签」里也能看到悬浮窗
chrome.tabs.onActivated.addListener((activeInfo) => {
  injectIntoTab(activeInfo.tabId);
});

// 安装/更新后给当前已打开的所有网页标签补注
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) injectIntoTab(tab.id);
    });
  });
});

// 点击扩展图标：向当前标签页发送 SHOW_FLOAT，若浮窗已关闭则重新创建
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) return;
  chrome.tabs.sendMessage(tab.id, { type: 'SHOW_FLOAT' }).catch(() => {
    // 可能尚未注入 content script，先注入再发消息
    injectIntoTab(tab.id);
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id, { type: 'SHOW_FLOAT' }).catch(() => {});
    }, 100);
  });
});

// 由 content/popup 调用：请求接口并返回解析后的行情数据（避免页面 CORS）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'GET_STOCK') return;
  (async () => {
    try {
      const code = msg.code || 'sh600519'; // 支持传入股票代码，默认 sh600519
      const res = await fetch(`http://qt.gtimg.cn/q=${code}`);
      if (!res.ok) throw new Error('请求失败: ' + res.status);
      const buffer = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buffer);
      const parts = text.split('~');
      if (parts.length < 33) throw new Error('返回数据格式异常');
      // 停牌：响应含「停牌」或 今开=0+成交量=0（如中韩半导体ETF 513310）
      const open = (parts[5] || '').trim();
      const vol = (parts[6] || '').trim();
      const suspended =
        text.indexOf('停牌') !== -1 ||
        ((open === '0' || open === '0.000' || open === '0.00') && vol === '0');
      sendResponse({
        ok: true,
        name: parts[1] || '—',
        price: parts[3] || '—',
        changePct: parts[32] || '—',
        suspended: !!suspended
      });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || '未知错误' });
    }
  })();
  return true; // 保持 channel 开启，便于异步 sendResponse
});
