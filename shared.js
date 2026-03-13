(function (global) {
  function normalizeStockCode(input) {
    const raw = String(input).trim();
    if (!raw) return '';

    const lower = raw.toLowerCase();
    if (lower.startsWith('sh') || lower.startsWith('sz') || lower.startsWith('bj') || lower.startsWith('hk')) {
      const prefix = lower.slice(0, 2);
      const rest = raw.slice(2).replace(/\D/g, '');
      return rest ? prefix + rest : raw;
    }

    if (lower.startsWith('us')) {
      const rest = raw.slice(2).replace(/[\s_]/g, '').toUpperCase();
      return rest ? 'us' + rest : raw;
    }

    const digits = raw.replace(/\D/g, '');
    if (digits.length === 5) return 'hk' + digits;
    if (digits.length === 6) {
      const first = digits[0];
      if (first === '6' || first === '9' || first === '5') return 'sh' + digits;
      if (first === '0' || first === '1' || first === '2' || first === '3') return 'sz' + digits;
      if (first === '4' || first === '8') return 'bj' + digits;
    }

    if (/^[a-zA-Z]+$/.test(raw)) return 'us' + raw.toUpperCase();
    return raw;
  }

  function parseTencentQuoteText(text) {
    const parts = String(text || '').split('~');
    if (parts.length < 33) throw new Error('返回数据格式异常');

    const open = (parts[5] || '').trim();
    const vol = (parts[6] || '').trim();
    const suspended =
      text.indexOf('停牌') !== -1 ||
      ((open === '0' || open === '0.000' || open === '0.00') && vol === '0');

    return {
      ok: true,
      name: parts[1] || '—',
      price: parts[3] || '—',
      preClose: parts[4] || '0',
      changePct: parts[32] || '—',
      suspended: !!suspended
    };
  }

  function fetchStockViaRuntime(code, options = {}) {
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 0;

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;

      function finish(result) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      }

      try {
        if (!global.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
          finish({ ok: false, error: '插件未就绪', code });
          return;
        }

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            finish({ ok: false, error: '请求超时', code });
          }, timeoutMs);
        }

        chrome.runtime.sendMessage({ type: 'GET_STOCK', code }, (res) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) {
            const errMsg = err.message || '未知错误';
            if (errMsg.includes('Extension context invalidated')) {
              finish({ ok: false, error: '插件已更新，请刷新页面', code });
              return;
            }
            finish({ ok: false, error: errMsg, code });
            return;
          }
          finish(res ? { ...res, code } : { ok: false, error: '未知错误', code });
        });
      } catch (e) {
        finish({ ok: false, error: (e && e.message) || '请求失败', code });
      }
    });
  }

  function decodeHtmlEntities(text) {
    return String(text || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function stripHeadlineSourceSuffix(title) {
    const normalized = String(title || '').trim();
    return normalized.replace(/\s+-\s+[^-]+$/, '').trim();
  }

  function parseGoogleNewsRss(xmlText, limit = 5) {
    const xml = String(xmlText || '');
    const items = [];
    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (let i = 0; i < itemMatches.length; i++) {
      const itemXml = itemMatches[i];
      const titleMatch = itemXml.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
      const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i);
      const rawTitle = titleMatch ? (titleMatch[1] || titleMatch[2] || '') : '';
      const title = stripHeadlineSourceSuffix(decodeHtmlEntities(rawTitle));
      const link = decodeHtmlEntities(linkMatch ? linkMatch[1] : '');
      if (!title) continue;
      items.push({ title, link });
      if (items.length >= limit) break;
    }
    return items;
  }

  function normalizeAiSummaryLines(text, limit = 2) {
    const lines = String(text || '')
      .split(/\r?\n+/)
      .map((line) => line.replace(/^[\s\-*•\d.]+/, '').trim())
      .filter(Boolean);
    const unique = [];
    for (const line of lines) {
      if (!unique.includes(line)) unique.push(line);
      if (unique.length >= limit) break;
    }
    return unique;
  }

  function summarizeHeadlineReasons(headlines, limit = 2) {
    const items = Array.isArray(headlines) ? headlines : [];
    const scored = [];
    const rules = [
      { label: 'AI chip demand', pattern: /(ai|gpu|chip|chips|semiconductor|hbm|datacenter|data center|算力|芯片|半导体|服务器)/i },
      { label: 'Analyst upgrades', pattern: /(analyst|upgrade|upgrades|overweight|buy rating|price target|评级|上调|目标价|看多)/i },
      { label: 'Earnings momentum', pattern: /(earnings|revenue|profit|guidance|results|财报|业绩|利润|营收|指引)/i },
      { label: 'New orders', pattern: /(order|orders|contract|deal|customer win|签约|订单|合同|中标)/i },
      { label: 'Partnership news', pattern: /(partnership|partner|alliance|collaboration|合作|联手|结盟)/i },
      { label: 'Product launches', pattern: /(launch|release|unveil|product|新品|发布|推出)/i },
      { label: 'Policy tailwinds', pattern: /(policy|regulation|tariff|subsidy|stimulus|政策|监管|补贴|关税)/i },
      { label: 'Capital return', pattern: /(buyback|repurchase|dividend|回购|分红)/i },
      { label: 'M&A activity', pattern: /(acquisition|acquire|merger|stake|takeover|收购|并购|入股)/i },
      { label: 'Supply updates', pattern: /(capacity|shipment|deliveries|factory|production|产能|出货|交付|工厂)/i },
      { label: 'Macro sentiment', pattern: /(fed|rates|inflation|economy|macro|利率|通胀|经济|宏观)/i }
    ];

    rules.forEach((rule) => {
      let count = 0;
      items.forEach((item) => {
        const title = String(item && item.title ? item.title : '');
        if (rule.pattern.test(title)) count += 1;
      });
      if (count > 0) scored.push({ label: rule.label, count });
    });

    scored.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const top = scored.slice(0, limit).map((item) => item.label);
    if (top.length >= limit) return top;

    if (items.length > 0 && !top.includes('Recent headlines focus')) {
      top.push('Recent headlines focus');
    }
    if (items.length > 1 && top.length < limit && !top.includes('News-driven momentum')) {
      top.push('News-driven momentum');
    }
    return top.slice(0, limit);
  }

  /** 解析单条腾讯行情文本（dataStr 为 `~` 分隔的字段，可来自完整响应行或提取后的值段），
   *  在原有字段基础上扩展 high / low / turnoverRate */
  function parseTencentQuoteExtended(dataStr) {
    const parts = String(dataStr || '').split('~');
    const open = (parts[5] || '').trim();
    const vol = (parts[6] || '').trim();
    const suspended =
      dataStr.indexOf('停牌') !== -1 ||
      ((open === '0' || open === '0.000' || open === '0.00') && vol === '0');
    return {
      ok: true,
      name: (parts[1] || '—').trim(),
      price: (parts[3] || '—').trim(),
      preClose: (parts[4] || '0').trim(),
      changePct: (parts[32] || '—').trim(),
      high: (parts[33] || '—').trim(),
      low: (parts[34] || '—').trim(),
      turnoverRate: (parts[38] || '—').trim(),
      suspended: !!suspended,
    };
  }

  /** 解析腾讯批量行情响应（多行 v_code="..." 格式），返回数组 */
  function parseTencentBatch(text) {
    const lines = String(text || '').split('\n');
    const results = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('v_')) continue;
      const eqIdx = trimmed.indexOf('="');
      if (eqIdx < 0) continue;
      const rawCode = trimmed.slice(2, eqIdx);
      const endQuote = trimmed.lastIndexOf('"');
      if (endQuote <= eqIdx + 1) continue;
      const dataStr = trimmed.slice(eqIdx + 2, endQuote);
      try {
        results.push({ ...parseTencentQuoteExtended(dataStr), rawCode });
      } catch (_) {
        results.push({ ok: false, rawCode });
      }
    }
    return results;
  }

  const shared = {
    normalizeStockCode,
    parseTencentQuoteText,
    parseTencentQuoteExtended,
    parseTencentBatch,
    fetchStockViaRuntime,
    parseGoogleNewsRss,
    normalizeAiSummaryLines,
    summarizeHeadlineReasons
  };

  global.LTShared = shared;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = shared;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
