/**
 * Chrome 扩展的「后台脚本」(Service Worker)
 *
 * 运行环境：独立于任何网页，没有 DOM，生命周期由浏览器管理（可能被休眠）。
 * 作用：响应扩展图标点击、切换标签时补注 content、代页面请求行情（避免 CORS）。
 *
 * 与 Android 类比：类似一个没有 UI 的 Service，负责接收事件、发消息、发网络请求。
 */

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
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => { });
  });
}

// 用户切换标签时：对当前激活的标签补注一次，这样在旧标签里也能看到浮窗
chrome.tabs.onActivated.addListener((activeInfo) => {
  injectIntoTab(activeInfo.tabId);
});

// 扩展安装或更新时：对当前已打开的所有 http(s) 标签补注
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) injectIntoTab(tab.id);
    });
  });
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
