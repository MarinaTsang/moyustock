(function () {
  if (window.__LT_WEIBO_RELAY__) return;
  window.__LT_WEIBO_RELAY__ = true;
  window.addEventListener('message', function (evt) {
    if (!evt.data || !evt.data.__lt_ws__) return;
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
    chrome.runtime.sendMessage({ type: 'LT_WEIBO_WS_MSG', data: evt.data.data }).catch(() => {});
  });
})();
