/**
 * Extension E2E 测试
 *
 * 加载真实 Chrome 扩展，测试 content script 注入行为和 popup 可访问性。
 * 需要 headful Chromium（或 CI 环境下的 Xvfb + headless:false）。
 *
 * 运行：npm run test:extension
 */

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, '..');

// Mock 行情接口返回：贵州茅台，涨幅 1.33%
const MOCK_QUOTE_BODY =
  'v_sh600519="1~贵州茅台~600519~1688.88~1666.66~1670.00~12345~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~1.33~0~0";\n';

let context;
let extensionId;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
  });

  // 获取 Service Worker 以拿到扩展 ID
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  }
  extensionId = new URL(sw.url()).hostname;

  // 拦截 background.js 发出的行情请求，返回 mock 数据
  await context.route('http://qt.gtimg.cn/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=GBK',
      body: MOCK_QUOTE_BODY,
    })
  );
});

test.afterAll(() => context.close());

// ───── 扩展基础 ─────

test('扩展 ID 不为空', () => {
  expect(extensionId).toBeTruthy();
  expect(extensionId.length).toBeGreaterThan(10);
});

test('Popup 页面可正常加载', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('h1')).toContainText('股票插件设置');
  await page.close();
});

// ───── Content Script 注入 ─────

test('浮窗注入到页面 DOM', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

  // content.js 调用 maybeCreateWidget() 后会在 body 里插入 #lt-stock-float
  await expect(page.locator('#lt-stock-float')).toBeAttached({ timeout: 8000 });
  await page.close();
});

test('浮窗初始状态可见', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await page.locator('#lt-stock-float').waitFor({ state: 'attached', timeout: 8000 });

  // 确认浮窗未被 display:none 隐藏（display 不为 none）
  const display = await page.locator('#lt-stock-float').evaluate((el) =>
    getComputedStyle(el).display
  );
  expect(display).not.toBe('none');
  await page.close();
});

test('Alt+Q 老板键隐藏浮窗', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await page.locator('#lt-stock-float').waitFor({ state: 'attached', timeout: 8000 });

  // 按 Alt+Q 隐藏
  await page.keyboard.press('Alt+q');
  await page.waitForTimeout(300);

  const display = await page.locator('#lt-stock-float').evaluate((el) =>
    getComputedStyle(el).display
  );
  expect(display).toBe('none');
  await page.close();
});

test('Alt+Q 再次按下重新显示浮窗', async () => {
  // 通过 service worker 重置存储，保证浮窗从可见状态开始
  // （page.evaluate 在隔离的 world 里 chrome 对象不可用）
  const sw = context.serviceWorkers()[0];
  await sw.evaluate(() => chrome.storage.local.set({ userHidden: false }));

  const page = await context.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await page.locator('#lt-stock-float').waitFor({ state: 'attached', timeout: 8000 });

  const getDisplay = () =>
    page.locator('#lt-stock-float').evaluate((el) => getComputedStyle(el).display);

  // 记录初始状态，验证两次 Alt+Q 后恢复初始状态（完整的 toggle 循环）
  const initial = await getDisplay();
  await page.keyboard.press('Alt+q');
  await page.waitForTimeout(300);
  const afterFirst = await getDisplay();
  expect(afterFirst).not.toBe(initial); // 第一次切换

  await page.keyboard.press('Alt+q');
  await page.waitForTimeout(300);
  const afterSecond = await getDisplay();
  expect(afterSecond).toBe(initial); // 第二次切换还原
  await page.close();
});

// ───── 行情数据渲染（需要网络 mock 生效） ─────

test('行情数据渲染后浮窗包含价格文本', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  await page.locator('#lt-stock-float').waitFor({ state: 'attached', timeout: 8000 });

  // 等待数据刷新（最多 10s），检查浮窗内出现价格（mock 返回 1688.88）
  await expect(
    page.locator('#lt-stock-float').getByText(/\d+\.\d{2}|贵州茅台/).first()
  ).toBeVisible({ timeout: 10000 });
  await page.close();
});
