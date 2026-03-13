const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 20000,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      // Popup 测试：直接以 file:// 加载 popup.html，注入 chrome mock
      // 速度快，可 headless 运行，适合 CI
      name: 'popup',
      testMatch: 'popup.spec.js',
      use: {
        browserName: 'chromium',
        headless: true,
        launchOptions: {
          args: ['--allow-file-access-from-files'],
        },
      },
    },
    {
      // Extension E2E：加载真实扩展，测试 content script 注入
      // 需要 headful（或 CI 下的 Xvfb）
      name: 'extension',
      testMatch: 'extension.spec.js',
      use: {
        browserName: 'chromium',
      },
    },
  ],
});
