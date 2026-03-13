/**
 * Popup UI 测试
 *
 * 以 file:// 加载 popup.html，注入 chrome API mock，测试 UI 交互。
 * 无需扩展环境，可 headless 运行，适合 CI。
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const { buildChromeMock } = require('./helpers/chrome-mock');

const POPUP_URL = `file://${path.join(__dirname, '..', 'popup.html')}`;

// 打开 popup 并等待初始化完成
async function openPopup(page, initialData = {}) {
  await page.addInitScript(buildChromeMock(initialData));
  await page.goto(POPUP_URL, { waitUntil: 'networkidle' });
  // 等待 popup.js 异步初始化（loadStockList + renderDebugInfo）
  await page.waitForSelector('#stock-list li', { timeout: 5000 });
}

// ───── 页面加载 ─────

test('页面标题正确', async ({ page }) => {
  await openPopup(page);
  await expect(page.locator('h1')).toContainText('股票插件设置');
});

test('无存储数据时显示默认股票 sh600519', async ({ page }) => {
  await openPopup(page);
  await expect(page.locator('.stock-code').first()).toHaveText('sh600519');
});

test('有存储数据时显示自定义股票列表', async ({ page }) => {
  await openPopup(page, { stockList: ['sz000001', 'usTSLA'] });
  const items = page.locator('.stock-code');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveText('sz000001');
  await expect(items.nth(1)).toHaveText('usTSLA');
});

test('状态速览：浮窗状态和时间显示', async ({ page }) => {
  await openPopup(page);
  // 浮窗状态显示"显示中"或"已隐藏"
  await expect(page.locator('#hidden-state')).toHaveText(/显示中|已隐藏/);
  // 更新时间为 HH:MM:SS 格式
  await expect(page.locator('#update-time')).toHaveText(/\d{2}:\d{2}:\d{2}/);
});

// ───── 股票管理 ─────

test('点击添加按钮后代码自动规范化', async ({ page }) => {
  await openPopup(page);
  await page.fill('#stock-input', '000001');
  await page.click('#add-btn');
  // 000001 → sz000001
  await expect(page.locator('.stock-code', { hasText: 'sz000001' })).toBeVisible();
  await expect(page.locator('#status-text')).toHaveText(/已添加 sz000001/);
});

test('按 Enter 键添加股票', async ({ page }) => {
  await openPopup(page);
  await page.fill('#stock-input', 'TSLA');
  await page.keyboard.press('Enter');
  await expect(page.locator('.stock-code', { hasText: 'usTSLA' })).toBeVisible();
});

test('重复添加同一股票时提示已存在', async ({ page }) => {
  await openPopup(page);
  // sh600519 是默认股票，再次添加应该提示已存在
  await page.fill('#stock-input', '600519');
  await page.click('#add-btn');
  await expect(page.locator('#status-text')).toHaveText('该股票已存在');
  // 输入框被清空
  await expect(page.locator('#stock-input')).toHaveValue('');
});

test('输入为空时提示填写代码', async ({ page }) => {
  await openPopup(page);
  await page.click('#add-btn');
  await expect(page.locator('#status-text')).toHaveText('请输入股票代码');
});

test('删除股票后列表更新', async ({ page }) => {
  await openPopup(page, { stockList: ['sh600519', 'sz000001'] });
  // 确认两只股票都在
  await expect(page.locator('.stock-code')).toHaveCount(2);
  // 删除第一只
  await page.locator('.delete-btn').first().click();
  // 只剩一只
  await expect(page.locator('.stock-code')).toHaveCount(1);
  await expect(page.locator('#status-text')).toHaveText('已更新自选列表');
});

test('删除到 0 只时自动恢复默认股票', async ({ page }) => {
  // 只有一只股票时删除，应恢复默认
  await openPopup(page, { stockList: ['sz000001'] });
  await page.locator('.delete-btn').first().click();
  // 恢复默认 sh600519
  await expect(page.locator('.stock-code').first()).toHaveText('sh600519');
});

// ───── 模式切换 ─────

test('初始状态 Normal 按钮处于激活态', async ({ page }) => {
  await openPopup(page);
  await expect(page.locator('#mode-normal-btn')).toHaveClass(/is-active/);
  await expect(page.locator('#mode-stealth-btn')).not.toHaveClass(/is-active/);
});

test('存储了 stealth 模式时初始显示 Stealth 激活', async ({ page }) => {
  await openPopup(page, { displayMode: 'stealth' });
  await expect(page.locator('#mode-stealth-btn')).toHaveClass(/is-active/);
  await expect(page.locator('#mode-normal-btn')).not.toHaveClass(/is-active/);
});

test('点击 Stealth 按钮后切换模式', async ({ page }) => {
  await openPopup(page);
  await page.click('#mode-stealth-btn');
  await expect(page.locator('#mode-stealth-btn')).toHaveClass(/is-active/);
  await expect(page.locator('#mode-normal-btn')).not.toHaveClass(/is-active/);
  await expect(page.locator('#status-text')).toHaveText('已切换到 Stealth Mode');
});

test('切换到 Stealth 后再点 Normal 可切回', async ({ page }) => {
  await openPopup(page);
  await page.click('#mode-stealth-btn');
  await page.click('#mode-normal-btn');
  await expect(page.locator('#mode-normal-btn')).toHaveClass(/is-active/);
  await expect(page.locator('#status-text')).toHaveText('已切换到 Normal Mode');
});

// ───── 唤醒浮窗 ─────

test('点击唤醒按钮后显示成功反馈（mock 返回 ok:true）', async ({ page }) => {
  await openPopup(page);
  await page.click('#wake-float-btn');
  // mock tabs.query 返回 https://example.com，mock sendMessage 返回 ok:true
  await expect(page.locator('#status-text')).toHaveText('当前页浮窗已唤醒', { timeout: 5000 });
});
