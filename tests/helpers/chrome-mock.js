/**
 * 生成注入到 popup.html 的 chrome API mock 脚本字符串。
 * 通过 page.addInitScript(buildChromeMock(initialData)) 注入。
 *
 * @param {object} initialData - chrome.storage.local 的初始数据
 */
function buildChromeMock(initialData = {}) {
  return `
(function() {
  const _data = ${JSON.stringify(initialData)};
  const _listeners = [];

  window.chrome = {
    storage: {
      local: {
        get: function(keys, cb) {
          const ks = Array.isArray(keys) ? keys : Object.keys(keys || {});
          const result = {};
          ks.forEach(function(k) { if (k in _data) result[k] = _data[k]; });
          const p = Promise.resolve(result);
          if (typeof cb === 'function') p.then(cb);
          return p;
        },
        set: function(items, cb) {
          Object.assign(_data, items);
          const changes = {};
          Object.keys(items).forEach(function(k) {
            changes[k] = { newValue: items[k] };
          });
          _listeners.forEach(function(fn) {
            try { fn(changes, 'local'); } catch(e) {}
          });
          const p = Promise.resolve();
          if (typeof cb === 'function') p.then(cb);
          return p;
        }
      },
      onChanged: {
        addListener: function(fn) { _listeners.push(fn); },
        removeListener: function(fn) {
          const idx = _listeners.indexOf(fn);
          if (idx >= 0) _listeners.splice(idx, 1);
        }
      }
    },
    tabs: {
      query: function(info, cb) {
        const tabs = [{ id: 1, url: 'https://example.com', active: true }];
        const p = Promise.resolve(tabs);
        if (typeof cb === 'function') p.then(cb);
        return p;
      }
    },
    runtime: {
      sendMessage: function(msg, cb) {
        const res = { ok: true };
        const p = Promise.resolve(res);
        if (typeof cb === 'function') p.then(cb);
        return p;
      },
      lastError: null
    }
  };
})();
`;
}

module.exports = { buildChromeMock };
