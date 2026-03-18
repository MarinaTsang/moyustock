(function () {
  if (window.__LT_IM_PATCHED__) return;
  window.__LT_IM_PATCHED__ = true;

  function relay(text) {
    window.postMessage({ __lt_ws__: true, data: text }, '*');
  }

  // 拦截 fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = origFetch.apply(this, arguments);
    if (url.includes('web.im.weibo.com/im/connect')) {
      p.then(function (res) {
        res.clone().text().then(relay).catch(function () {});
      }).catch(function () {});
    }
    return p;
  };

  // 拦截 XMLHttpRequest（备用）
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lt_url__ = url || '';
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__lt_url__ && this.__lt_url__.includes('web.im.weibo.com/im/connect')) {
      this.addEventListener('load', function () {
        relay(this.responseText || '');
      });
    }
    return origSend.apply(this, arguments);
  };
})();
