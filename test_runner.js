/**
 * 摸鱼看盘 - 本地测试脚本（Node.js，无需框架）
 * 覆盖范围：
 *   1. anomalyMonitor 核心逻辑
 *   2. content.js 中可抽取的纯函数（isInTradingTime, formatChangePct, normalizeStockCode）
 */

// ===== 测试工具 =====
let passed = 0, failed = 0, total = 0;
const { normalizeStockCode, parseTencentQuoteText, parseGoogleNewsRss, normalizeAiSummaryLines, summarizeHeadlineReasons } = require('./shared.js');
const market = require('./market.js');
const trend = require('./trend.js');
function assert(desc, condition) {
  total++;
  if (condition) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    console.error(`  ✗ ${desc}`);
    failed++;
  }
}
function group(name) {
  console.log(`\n[${name}]`);
}

// ===== 1. anomalyMonitor 测试 =====
// 模拟 window，因为 anomalyMonitor.js 使用 (global) = window
const mockWindow = {};
const anomalyModuleCode = require('fs').readFileSync('./anomalyMonitor.js', 'utf8')
  .replace('(window)', '(mockWindow)');
eval(anomalyModuleCode);
const { create } = mockWindow.LTAnomalyMonitor;

// 用可控的 storageGet/storageSet 替换真实 chrome.storage
function makeMonitor(opts = {}) {
  let stored = {};
  return create({
    threshold: 3.0,
    sustainSec: opts.sustainSec ?? 10,
    cooldownSec: opts.cooldownSec ?? 300,
    decaySec: opts.decaySec ?? 20,
    storageGet: (keys, cb) => cb(stored),
    storageSet: (obj) => { Object.assign(stored, obj); },
    getDayKey: opts.getDayKey ?? (() => '2026-03-05'),
  });
}

group('anomalyMonitor - 基础状态');
{
  const m = makeMonitor();
  m.init(() => {});
  const snap = m.tick({
    nowTs: Date.now(),
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '1.5', suspended: false } },
    isTradingFn: () => true,
    isInWorkTimeFn: () => true,
  });
  assert('正常涨幅 1.5% 应为 ACTIVE', snap.state === 'ACTIVE');
  assert('无关键股', snap.criticalCodes.length === 0);
}

group('anomalyMonitor - 关键态（持续时间未达）');
{
  const m = makeMonitor({ sustainSec: 10 });
  m.init(() => {});
  const nowTs = Date.now();
  const snap = m.tick({
    nowTs,
    rotateCodes: ['sh000001'],
    lastStockDataByCode: { sh000001: { ok: true, changePct: '5.0', suspended: false } },
    isTradingFn: () => true,
    isInWorkTimeFn: () => true,
  });
  assert('超 3% 但不足 10s，应为 ACTIVE（未达关键态）', snap.state === 'ACTIVE');
  assert('criticalCodes 为空', snap.criticalCodes.length === 0);
}

group('anomalyMonitor - 关键态（持续时间已达）');
{
  const m = makeMonitor({ sustainSec: 10 });
  m.init(() => {});
  const baseTs = Date.now() - 15000; // 15秒前开始突破
  // 第一次 tick：记录突破开始
  m.tick({
    nowTs: baseTs,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '4.0', suspended: false } },
    isTradingFn: () => true,
    isInWorkTimeFn: () => true,
  });
  // 第二次 tick：15秒后，达到持续时间
  const snap = m.tick({
    nowTs: baseTs + 15000,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '4.0', suspended: false } },
    isTradingFn: () => true,
    isInWorkTimeFn: () => true,
  });
  assert('持续 15s 超 3%，应为 CRITICAL', snap.state === 'CRITICAL');
  assert('criticalCodes 包含该股票', snap.criticalCodes.includes('sh600519'));
  assert('newlyAlertedCodes 有一次提醒', snap.newlyAlertedCodes.includes('sh600519'));
}

group('anomalyMonitor - 冷却期不重复提醒');
{
  const m = makeMonitor({ sustainSec: 5, cooldownSec: 300 });
  m.init(() => {});
  const baseTs = Date.now() - 10000;
  const alertTs = baseTs + 8000;
  // 第一次 tick 触发提醒
  m.tick({
    nowTs: baseTs,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '5.0', suspended: false } },
    isTradingFn: () => true,
    isInWorkTimeFn: () => true,
  });
  m.tick({
    nowTs: alertTs,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '5.0', suspended: false } },
    isTradingFn: () => true,
    isInWorkTimeFn: () => true,
  });
  // 60秒后再次 tick（仍在 300s 冷却内）
  const snap2 = m.tick({
    nowTs: alertTs + 60000,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '5.0', suspended: false } },
    isTradingFn: () => true,
    isInWorkTimeFn: () => true,
  });
  assert('冷却期内不再提醒（newlyAlerted 为空）', snap2.newlyAlertedCodes.length === 0);
  assert('仍处于 CRITICAL', snap2.state === 'CRITICAL');
}

group('anomalyMonitor - 非工作时间 → SILENT');
{
  const m = makeMonitor({ sustainSec: 5 });
  m.init(() => {});
  const baseTs = Date.now() - 10000;
  m.tick({
    nowTs: baseTs,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '5.0', suspended: false } },
    isTradingFn: () => true,
    isInWorkTimeFn: () => false, // 非工作时间
  });
  const snap = m.tick({
    nowTs: baseTs + 8000,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '5.0', suspended: false } },
    isTradingFn: () => true,
    isInWorkTimeFn: () => false,
  });
  assert('非工作时间强制 SILENT', snap.state === 'SILENT');
}

group('anomalyMonitor - 停牌股不触发关键态');
{
  const m = makeMonitor({ sustainSec: 5 });
  m.init(() => {});
  const baseTs = Date.now() - 10000;
  const snap = m.tick({
    nowTs: baseTs + 8000,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '10.0', suspended: true } },
    isTradingFn: () => true,
    isInWorkTimeFn: () => true,
  });
  assert('停牌股不触发 CRITICAL', snap.state !== 'CRITICAL');
}

group('anomalyMonitor - markRead 当日已读后不再 newlyAlert');
{
  const m = makeMonitor({ sustainSec: 5, cooldownSec: 1 }); // cooldown 极短
  m.init(() => {});
  const baseTs = Date.now() - 10000;
  m.tick({
    nowTs: baseTs,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '5.0', suspended: false } },
    isTradingFn: () => true, isInWorkTimeFn: () => true,
  });
  m.tick({
    nowTs: baseTs + 8000,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '5.0', suspended: false } },
    isTradingFn: () => true, isInWorkTimeFn: () => true,
  });
  m.markRead('sh600519');
  // 冷却过后再 tick
  const snap = m.tick({
    nowTs: baseTs + 10000,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '5.0', suspended: false } },
    isTradingFn: () => true, isInWorkTimeFn: () => true,
  });
  assert('已读后不再 newlyAlert', snap.newlyAlertedCodes.length === 0);
  assert('isRead 返回 true', m.isRead('sh600519'));
}

group('anomalyMonitor - 方向反转重计时');
{
  const m = makeMonitor({ sustainSec: 10 });
  m.init(() => {});
  const baseTs = 1000000;
  // 先突破上涨方向
  m.tick({
    nowTs: baseTs,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '5.0', suspended: false } },
    isTradingFn: () => true, isInWorkTimeFn: () => true,
  });
  // 方向反转（变为下跌）
  m.tick({
    nowTs: baseTs + 5000, // 只过了 5s
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '-5.0', suspended: false } },
    isTradingFn: () => true, isInWorkTimeFn: () => true,
  });
  // 再过 6s（方向切换后仅过 6s，不足 10s）
  const snap = m.tick({
    nowTs: baseTs + 11000,
    rotateCodes: ['sh600519'],
    lastStockDataByCode: { sh600519: { ok: true, changePct: '-5.0', suspended: false } },
    isTradingFn: () => true, isInWorkTimeFn: () => true,
  });
  assert('方向反转后重计时，6s 不足 10s，应为 ACTIVE', snap.state === 'ACTIVE');
}

// ===== 2. 纯函数测试（从 content.js 提取） =====

group('normalizeStockCode - 代码识别');
assert('600519 → sh600519', normalizeStockCode('600519') === 'sh600519');
assert('000001 → sz000001', normalizeStockCode('000001') === 'sz000001');
assert('300750 → sz300750', normalizeStockCode('300750') === 'sz300750');
assert('513301 → sh513301 (ETF)', normalizeStockCode('513301') === 'sh513301');
assert('159875 → sz159875 (ETF)', normalizeStockCode('159875') === 'sz159875');
assert('839719 → bj839719 (北交所)', normalizeStockCode('839719') === 'bj839719');
assert('00700 → hk00700 (港股5位)', normalizeStockCode('00700') === 'hk00700');
assert('TSLA → usTSLA (美股纯字母)', normalizeStockCode('TSLA') === 'usTSLA');
assert('usTSLA 已有前缀保留', normalizeStockCode('usTSLA') === 'usTSLA');
assert('sh600519 已有前缀保留', normalizeStockCode('sh600519') === 'sh600519');
assert('空字符串 → 空', normalizeStockCode('') === '');

group('parseTencentQuoteText - 基础解析');
{
  const quote = 'v_sh600519="1~贵州茅台~600519~1688.88~1666.66~1670.00~12345~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~1.33~0~0";';
  const parsed = parseTencentQuoteText(quote);
  assert('名称解析正确', parsed.name === '贵州茅台');
  assert('价格解析正确', parsed.price === '1688.88');
  assert('昨收解析正确', parsed.preClose === '1666.66');
  assert('涨跌幅解析正确', parsed.changePct === '1.33');
  assert('正常行情非停牌', parsed.suspended === false);
}

group('parseTencentQuoteText - 停牌识别');
{
  const quote = 'v_sz000001="1~平安银行~000001~0.00~12.34~0~0~停牌~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~-1.23~0~0";';
  const parsed = parseTencentQuoteText(quote);
  assert('含停牌文案时识别为停牌', parsed.suspended === true);
}

group('parseGoogleNewsRss - 提取 headline');
{
  const xml = `
    <rss><channel>
      <item><title><![CDATA[NVIDIA surges after upgrades - Reuters]]></title><link>https://example.com/1</link></item>
      <item><title>AI demand lifts chip stocks - Bloomberg</title><link>https://example.com/2</link></item>
    </channel></rss>
  `;
  const items = parseGoogleNewsRss(xml, 5);
  assert('解析两条新闻', items.length === 2);
  assert('标题去掉来源后缀', items[0].title === 'NVIDIA surges after upgrades');
}

group('normalizeAiSummaryLines - 提取两条 bullet');
{
  const lines = normalizeAiSummaryLines('- AI chip demand\n- Analyst upgrades\n- Extra line', 2);
  assert('只保留两条', lines.length === 2);
  assert('去掉 bullet 前缀', lines[0] === 'AI chip demand');
}

group('summarizeHeadlineReasons - 从 headlines 提炼原因');
{
  const lines = summarizeHeadlineReasons([
    { title: 'NVIDIA rises as AI chip demand stays strong' },
    { title: 'Broker upgrades NVIDIA and lifts price target' },
    { title: 'Semiconductor names gain on AI server orders' }
  ], 2);
  assert('返回两条原因', lines.length === 2);
  assert('包含 AI chip demand', lines.includes('AI chip demand'));
  assert('包含 Analyst upgrades', lines.includes('Analyst upgrades'));
}

group('market - 市场配置');
{
  const aShare = market.getMarketProfile('sh600519');
  const hk = market.getMarketProfile('hk00700');
  const us = market.getMarketProfile('usTSLA');
  assert('A股使用上海时区', aShare.timeZone === 'Asia/Shanghai');
  assert('港股使用香港时区', hk.timeZone === 'Asia/Hong_Kong');
  assert('美股使用纽约时区', us.timeZone === 'America/New_York');
}

group('market - 交易进度边界');
{
  const shMorning = market.getTradingProgressMinutes('sh600519', new Date('2026-03-06T01:30:00.000Z'));
  const shLunch = market.getTradingProgressMinutes('sh600519', new Date('2026-03-06T04:00:00.000Z'));
  const shAfternoon = market.getTradingProgressMinutes('sh600519', new Date('2026-03-06T05:00:00.000Z'));
  assert('A股 09:30 开盘时处于交易中', shMorning && shMorning.inTrading === true);
  assert('A股午休时不处于交易中', shLunch && shLunch.inTrading === false);
  assert('A股 13:00 重新开盘', shAfternoon && shAfternoon.inTrading === true);
}

group('market - isInTradingTime');
assert('A股 交易时段返回 true', market.isInTradingTime('sh600519', new Date('2026-03-06T01:45:00.000Z')) === true);
assert('A股 午休返回 false', market.isInTradingTime('sh600519', new Date('2026-03-06T03:45:00.000Z')) === false);
assert('港股 午后开盘返回 true', market.isInTradingTime('hk00700', new Date('2026-03-06T05:15:00.000Z')) === true);
assert('美股 周末返回 false', market.isInTradingTime('usTSLA', new Date('2026-03-08T15:00:00.000Z')) === false);

group('trend - sparkline');
{
  const path = trend.renderSparkline([
    { progressMin: 0, price: 10 },
    { progressMin: 30, price: 10.5 },
    { progressMin: 60, price: 10.2 }
  ], 120, 12, 240, 10);
  assert('至少产生 M 开头的 path', /^M /.test(path));
  assert('多点折线包含 L', path.includes(' L '));
}

group('trend - import/export state');
{
  const fakeMarket = {
    getMarketDayKey: () => '2026-03-09',
    getTradingProgressMinutes: () => ({ inTrading: true, progressMin: 10, totalMin: 240 })
  };
  const tracker = trend.createTracker({ market: fakeMarket, maxPoints: 5 });
  tracker.recordPrice('sh600519', 10, 9.8, new Date('2026-03-09T02:00:00.000Z'));
  const exported = tracker.exportState();
  const tracker2 = trend.createTracker({ market: fakeMarket, maxPoints: 5 });
  tracker2.importState(exported);
  const restored = tracker2.getHistory('sh600519');
  assert('导出状态包含对应代码', !!exported.sh600519);
  assert('导入后恢复分时点', restored && restored.points.length === 1);
}

group('trend - 5分钟采样桶');
{
  let progressMin = 11;
  const fakeMarket = {
    getMarketDayKey: () => '2026-03-09',
    getTradingProgressMinutes: () => ({ inTrading: true, progressMin, totalMin: 240 })
  };
  const tracker = trend.createTracker({ market: fakeMarket, maxPoints: 10, sampleBucketMin: 5 });
  tracker.recordPrice('sh600519', 10.0, 9.8);
  progressMin = 14;
  tracker.recordPrice('sh600519', 10.2, 9.8);
  progressMin = 16;
  tracker.recordPrice('sh600519', 10.4, 9.8);
  const history = tracker.getHistory('sh600519');
  assert('同一5分钟桶内只保留一个点', history && history.points.length === 2);
  assert('第一个桶对齐到10分钟', history && history.points[0].progressMin === 10);
  assert('第二个桶对齐到15分钟', history && history.points[1].progressMin === 15);
}

group('涨跌停逻辑验证');
function checkLimit(changePct) {
  const n = parseFloat(changePct);
  const limitUpThreshold = 9.8;
  const limitDownThreshold = -9.8;
  if (!isNaN(n) && n >= limitUpThreshold) return '涨停';
  if (!isNaN(n) && n <= limitDownThreshold) return '跌停';
  return 'normal';
}
assert('+10.00% → 涨停', checkLimit('10.00') === '涨停');
assert('+9.99% → 涨停', checkLimit('9.99') === '涨停');
assert('+9.80% → 涨停', checkLimit('9.80') === '涨停');
assert('+9.79% → 正常（未达涨停）', checkLimit('9.79') === 'normal');
assert('-10.00% → 跌停', checkLimit('-10.00') === '跌停');
assert('-9.80% → 跌停', checkLimit('-9.80') === '跌停');
assert('-9.79% → 正常（未达跌停）', checkLimit('-9.79') === 'normal');
assert('+3.00% → 正常', checkLimit('3.00') === 'normal');
assert('科创板 +20% → 涨停（>=9.8）', checkLimit('20.00') === '涨停');

group('formatChangePct 验证');
function formatChangePct(changePct) {
  const n = parseFloat(changePct);
  if (isNaN(n)) return '—';
  const sign = n > 0 ? '+' : (n < 0 ? '-' : '');
  const abs = Math.abs(n).toFixed(2);
  return sign + abs + '%';
}
assert('+3.36% 格式化', formatChangePct('3.36') === '+3.36%');
assert('-2.5% 格式化', formatChangePct('-2.5') === '-2.50%');
assert('0% 格式化', formatChangePct('0') === '0.00%');
assert('非数字 → 破折号', formatChangePct('—') === '—');
assert('空字符串 → 破折号', formatChangePct('') === '—');

// ===== 结果汇总 =====
console.log(`\n${'='.repeat(40)}`);
console.log(`测试完成：${passed}/${total} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
