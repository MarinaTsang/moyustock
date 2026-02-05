# 股票行情插件 - 开发文档

## 文档信息

- **项目名称**：股票行情 Chrome 插件
- **技术栈**：Chrome Extension Manifest V3
- **文档版本**：v1.0
- **维护人员**：开发团队

## 1. 项目结构

```
popup/
├── manifest.json          # 插件配置文件
├── background.js          # Service Worker（后台脚本）
├── content.js            # Content Script（页面注入脚本）
├── content.css           # Content Script 样式
├── popup.html            # 弹窗页面HTML
├── popup.js              # 弹窗页面逻辑
├── icons/                # 图标资源
│   ├── icon48.png
│   └── icon128.png
├── README.md             # 产品介绍文档
├── PRD.md                # 产品需求文档
└── DEVELOPMENT.md        # 本开发文档
```

## 2. 技术架构

### 2.1 架构概述

插件采用Chrome Extension Manifest V3架构，包含三个主要部分：

1. **Background Script** (`background.js`)
   - Service Worker，处理网络请求和数据解析
   - 处理插件图标点击事件
   - 管理Content Script注入

2. **Content Script** (`content.js`)
   - 注入到网页中，创建浮窗DOM
   - 处理浮窗交互逻辑
   - 管理股票数据展示和轮播

3. **Popup** (`popup.html` + `popup.js`)
   - 当前版本中未使用（manifest.json中未设置default_popup）
   - 所有功能都在Content Script的浮窗中实现
   - 如需使用popup，需要在manifest.json中添加`action.default_popup`

### 2.2 数据流

```
用户操作 → Content Script → Background Script → 数据接口
                ↓
        更新DOM/存储数据
                ↓
        用户界面更新
```

### 2.3 核心模块

#### 2.3.1 Background Script (`background.js`)

**职责**：
- 代理网络请求（解决CORS问题）
- 处理GBK编码转换
- 解析股票数据
- 管理Content Script注入

**关键函数**：
```javascript
// 注入Content Script到指定标签页
function injectIntoTab(tabId)

// 处理GET_STOCK消息请求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 请求数据接口
  // 解析GBK编码
  // 返回解析后的数据
})
```

**技术要点**：
- 使用`fetch`请求数据
- 使用`TextDecoder('gbk')`处理GBK编码
- 使用`Promise`处理异步请求
- 使用`chrome.scripting.executeScript`注入脚本

#### 2.3.2 Content Script (`content.js`)

**职责**：
- 创建和管理浮窗DOM
- 处理浮窗交互（拖拽、关闭、设置）
- 管理股票数据展示和轮播
- 处理网络状态和错误

**关键变量**：
```javascript
const MAX_DISPLAY = 3;              // 最多显示行数
const ROTATE_INTERVAL = 4000;       // 轮播间隔（毫秒）
const REFRESH_SEC = 2;              // 刷新间隔（秒）
const MARKET_INDEX_CODE = 'sh000001'; // 大盘指数代码
let cycleOffset = 0;                // 循环偏移量
let rotationPaused = false;         // 轮播暂停标志
```

**关键函数**：
```javascript
// 创建浮窗DOM
function createWidget()

// 更新显示（无闪烁）
async function updateDisplay(forceRebuild)

// 轮播切换（向上滑动）
function rotateAndUpdate()

// 更新大盘指数
function updateMarketIndex()

// 设置轮播
function setupRotation()
```

**技术要点**：
- DOM操作：使用`createElement`、`appendChild`等
- 事件监听：`addEventListener`处理用户交互
- 定时器：`setInterval`实现轮播和刷新
- 动画：CSS `transform` + `transition`实现滑动效果
- 存储：`chrome.storage.local`存储股票列表
- 位置记忆：`localStorage`存储浮窗位置

#### 2.3.3 Popup (`popup.js`)

**注意**：当前版本中popup功能未启用，所有功能都在Content Script的浮窗中实现。

**如果未来需要启用popup**：
- 需要在manifest.json中添加`action.default_popup: "popup.html"`
- popup.js中的功能可以用于独立的弹窗界面
- 当前所有设置功能都在浮窗的设置面板中完成

## 3. 核心功能实现

### 3.1 股票代码自动识别

**实现位置**：`content.js` 中的 `normalizeStockCode()`

**注意**：`popup.js`中也存在此函数，但当前版本popup未启用，实际使用的是content.js中的实现。

**逻辑**：
```javascript
function normalizeStockCode(input) {
  // 1. 如果已有前缀（sh/sz/bj/hk），保留前缀
  // 2. 提取数字部分
  // 3. 根据数字长度和首位数字判断交易所
  //    - 5位数字 → 港股（hk）
  //    - 6位数字：
  //      - 6/9/5开头 → 上海（sh）
  //      - 0/1/2/3开头 → 深圳（sz）
  //      - 4/8开头 → 北交所（bj）
  //      - 1开头 → ETF/LOF（sz）
  //      - 5开头 → ETF/LOF（sh）
}
```

### 3.2 循环轮播算法

**实现位置**：`content.js` 中的 `getDisplayCodes()` 和 `rotateAndUpdate()`

**算法**：
```javascript
// 使用取余运算实现无限循环
function getDisplayCodes() {
  const list = getRotateList(); // 剔除大盘指数后的列表
  const total = list.length;
  if (total <= MAX_DISPLAY) return [...list];
  
  const codes = [];
  for (let i = 0; i < MAX_DISPLAY; i++) {
    codes.push(list[(cycleOffset + i) % total]);
  }
  return codes;
}

// 更新偏移量
cycleOffset = (cycleOffset + MAX_DISPLAY) % total;
```

**示例**：
- 列表：[A, B, C, D, E]
- offset=0: [A, B, C]
- offset=3: [D, E, A] ← 用A补齐第3行
- offset=1: [B, C, D]
- offset=4: [E, A, B]
- offset=2: [C, D, E]
- offset=0: [A, B, C] ← 循环

### 3.3 向上滑动动画

**实现位置**：`content.js` 中的 `rotateAndUpdate()`

**实现方式**：
```javascript
function rotateAndUpdate() {
  // 1. 在列表底部追加新的3行
  for (let i = 0; i < step; i++) {
    listEl.appendChild(createStockRowWithPrefix(prefix, i));
  }
  
  // 2. 获取新行的数据
  Promise.all(toFetch.map(...)).then(results => {
    // 更新新行的内容
  });
  
  // 3. 使用CSS transform向上滑动
  listEl.style.transition = 'transform 0.28s ease-out';
  listEl.style.transform = `translateY(-${step * ROW_STEP_PX}px)`;
  
  // 4. 动画结束后移除顶部旧行，重置transform
  listEl.addEventListener('transitionend', onEnd);
}
```

**关键常量**：
```javascript
const ROW_STEP_PX = 26; // 单行高度（22px）+ 间距（4px）
```

### 3.4 无闪烁更新

**实现位置**：`content.js` 中的 `updateDisplay()`

**策略**：
1. **分离创建和更新**：
   - 首次创建或列表变化时重建DOM
   - 日常刷新只更新数据，不重建DOM

2. **ID管理**：
   - 每个股票行有唯一ID：`lt-row-{code}`
   - 价格、涨跌幅元素也有唯一ID：`lt-price-{code}`、`lt-change-{code}`

3. **增量更新**：
   ```javascript
   // 检查是否需要重建
   const needsRebuild = forceRebuild || !arraysEqual(displayStocks, currentDisplayCodes);
   
   if (needsRebuild) {
     // 重建DOM
   } else {
     // 只更新数据
     updateStockRow(code, data);
   }
   ```

### 3.5 网络状态处理

**实现位置**：`content.js`

**注意**：`popup.js`中也存在相关功能，但当前版本popup未启用，实际使用的是content.js中的实现。

**监听事件**：
```javascript
// 监听在线状态
window.addEventListener('online', () => {
  renderMonitor(); // 重连后完整渲染
});

window.addEventListener('offline', () => {
  showOfflineState(); // 显示离线状态
});

// 监听页面可见性
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    fetchData(); // 切回标签页时立即刷新
  }
});
```

**超时处理**：
```javascript
function fetchStock(code) {
  const fetchPromise = new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STOCK', code }, (res) => {
      resolve(res || { ok: false, error: '未知错误' });
    });
  });
  
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, error: '请求超时' }), 3000);
  });
  
  return Promise.race([fetchPromise, timeoutPromise]);
}
```

**数据缓存**：
```javascript
let lastMarketIndexData = null;      // 大盘指数缓存
let lastStockDataByCode = {};        // 股票数据缓存

// 成功时更新缓存
lastMarketIndexData = { price, pct, cls };
lastStockDataByCode[code] = { name, price, changeText, ... };

// 失败时使用缓存
if (lastMarketIndexData) {
  // 显示缓存数据 + "数据可能过时"提示
}
```

## 4. 数据存储

### 4.1 chrome.storage.local

**存储内容**：
```javascript
{
  stockList: ['sh600519', 'sz000001', ...]
}
```

**使用方式**：
```javascript
// 读取
chrome.storage.local.get(['stockList'], (result) => {
  stockList = result.stockList || [DEFAULT_STOCK];
});

// 写入
chrome.storage.local.set({ stockList });
```

### 4.2 localStorage

**存储内容**：
- 浮窗位置：`lt-stock-float-pos` → `{x: number, y: number}`
- 浮窗关闭状态：`lt-stock-float-closed` → `'1'` 或不存在

**使用方式**：
```javascript
// 保存位置
localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));

// 读取位置
const saved = localStorage.getItem(STORAGE_KEY);
const { x, y } = JSON.parse(saved);
```

## 5. 样式系统

### 5.1 CSS变量（建议）

可以考虑使用CSS变量统一管理颜色：
```css
:root {
  --color-up: #c0392b;
  --color-down: #27ae60;
  --color-neutral: #666;
  --bg-color: #fff;
  --border-color: #e0e0e0;
}
```

### 5.2 响应式设计

当前浮窗宽度固定（188px），高度自适应。如需响应式：
- 使用`min-width`和`max-width`
- 使用`vw`、`vh`单位
- 使用媒体查询

### 5.3 动画性能优化

**当前实现**：
```css
.lt-stock-list {
  transition: transform 0.28s ease-out;
}
```

**优化建议**：
- 使用`will-change: transform`提示浏览器优化
- 使用`transform`而非`top/left`（GPU加速）
- 避免在动画过程中触发reflow

## 6. 错误处理

### 6.1 网络错误

```javascript
try {
  const res = await fetch(`http://qt.gtimg.cn/q=${code}`);
  if (!res.ok) throw new Error('请求失败: ' + res.status);
  // ...
} catch (e) {
  // 显示错误提示
  // 使用缓存数据（如果有）
}
```

### 6.2 数据解析错误

```javascript
const parts = text.split('~');
if (parts.length < 33) {
  throw new Error('返回数据格式异常');
}
// 使用 parts[1], parts[3], parts[32]
```

### 6.3 存储错误

```javascript
try {
  await chrome.storage.local.set({ stockList });
} catch (err) {
  console.error('保存失败:', err);
  // 提示用户
}
```

## 7. 调试技巧

### 7.1 Content Script调试

1. 打开网页，按F12打开开发者工具
2. 在Console中可以看到Content Script的日志
3. 使用`console.log`输出调试信息

### 7.2 Background Script调试

1. 打开 `chrome://extensions/`
2. 找到插件，点击"service worker"链接
3. 在新打开的调试窗口中查看日志

### 7.3 Popup调试

**注意**：当前版本popup未启用，无需调试popup。

如果未来启用popup：
1. 右键点击插件图标 → "检查弹出内容"
2. 在打开的调试窗口中查看

### 7.4 常用调试命令

```javascript
// 查看存储的数据
chrome.storage.local.get(null, console.log);

// 清空存储
chrome.storage.local.clear();

// 查看localStorage
localStorage.getItem('lt-stock-float-pos');
```

## 8. 打包发布

### 8.1 开发环境测试

1. 打开 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择项目文件夹

### 8.2 打包步骤

1.  **分发困难（Distribution）**：
    *   现代 Chrome 浏览器为了安全，**严禁用户直接安装第三方的 `.crx` 文件**。
    *   如果你只发 `.crx` 给朋友，他们需要：*下载 -> 改后缀 -> 打开开发者模式 -> 拖拽安装*。这个门槛会劝退 99% 的用户。
    *   上架商店后，用户只需要点一个“Add to Chrome”按钮。
2.  **自动更新**：
    *   如果你发现了 Bug 修复了，商店会自动推送到所有用户的浏览器里。如果是离线包，你得一个个通知人重新下载。

---

### 二、 技术实操：如何打包？

这里有两种路径，取决于你现在的目的。

#### 8.2.1：打成 `.crx` 包（仅用于本地备份或发给极客朋友测试）
这是 Chrome 自带的打包功能。

1.  在浏览器地址栏输入：`chrome://extensions/`
2.  打开右上角的 **“开发者模式” (Developer mode)**。
3.  点击顶部的 **“打包扩展程序” (Pack extension)** 按钮。
4.  **扩展程序根目录**：选择你存放 `manifest.json`、`popup.html` 等文件的那个文件夹。
5.  **私有密钥文件**：第一次打包留空即可（它会自动生成一个 `.pem` 文件）。
6.  点击“打包”。
    *   你会得到两个文件：`xxx.crx` (安装包) 和 `xxx.pem` (私钥)。
    *   **⚠️ 警告**：`xxx.pem` 极其重要，**请务必存好**。下次更新版本打包时，必须选择这个 pem 文件，否则 Chrome 会认为这是两个不同的插件，ID 会变。
7. 使用：*下载.crx 文件 -> 改后缀 -> 打开开发者模式 -> 拖拽安装*

#### 8.2.2：打成 `.zip` 包（用于上传 Chrome 应用商店 ）
商店不接受 `.crx`，它要求你上传源代码的压缩包，由商店审核后代你打包签名。

1.  **清理代码（Pre-flight Check）**：
    *   删除所有 `console.log`（尤其是打印股票数据的，为了性能也为了隐私）。
    *   删除项目里的无关文件（如 `.git` 文件夹、`.DS_Store`、设计草稿图、说明文档等）。
2.  **压缩**：
    *   确保所有文件完整，进入你的项目文件夹，全选所有文件（`manifest.json`, `popup.html`, `js`, `css`, `icons` 等）。
    *   **右键 -> 压缩 (Compress to ZIP)**。
3.  **上传**：
    *   这个 `.zip` 就是你要提交给 Google 的文件。

#### 8.2.3、 上线 Chrome 商店的流程（Go-to-Market）

目前 Google 对开发者账号收费 **5 美元（一次性，终身有效）**。

**步骤如下：**

1.  **注册开发者账号**：
    *   访问 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/developer/dashboard)。
    *   支付 $5 注册费（需要外币信用卡，你之前提到你有海外卡，这里正好用上）。
2.  **上传项目**：
    *   点击 "New Item"，上传刚才打好的 `.zip` 包。
3.  **填写商店信息（Store Listing）—— 这一步最关键**：
    *   **名称**：起个好名字。
        *   *错误示范*：StockPlugin
        *   *正确示范*：**MoyuStock - 隐蔽式上班看盘助手 (A股/港股/美股)**
        *   *SEO技巧*：在标题里包含关键词 "Stock", "Reader", "Ticker"。
    *   **描述**：
        *   第一句话讲清楚价值：“这是一款专为上班族设计的轻量级、防窥视股票监视器...”
        *   列出功能点：隐蔽模式、标题栏大盘、自动轮播等。
    *   **截图**：
        *   你需要上传至少一张 1280x800 的截图。
        *   *建议*：不要直接截屏幕。用 Canva 或 PPT 做一个简单的海报，展示那个“标题栏大盘”和“右下角悬浮窗”的效果。
4.  **隐私政策（Privacy Policy）**：
    *   Google 现在强制要求填写隐私政策 URL。
    *   *偷懒办法*：去 Notion 写一个简单的页面：“本插件不收集任何用户个人信息，股票代码仅存储在本地 Chrome Storage 中，仅向腾讯财经接口请求数据。”然后发布成公开链接填进去。
5.  **提交审核**：
    *   通常审核时间在 24小时 - 3天。

---

#### 8.2.4、最后 Check（上线前避坑指南）

在打包之前，请务必检查 `manifest.json` 里的版本号。

1.  **版本号管理**：
    *   `"version": "1.0.0"`。
    *   以后每次更新功能（比如修了 Bug），都要把这个数字改大（如 `1.0.1`），否则商店不让你上传新包。
2.  **权限最小化**：
    *   检查 `"permissions"` 和 `"host_permissions"`。
    *   确保只申请了你真正用到的权限（如 `storage`）。
    *   Host 权限只写 `http://qt.gtimg.cn/*` 和 `http://hq.sinajs.cn/*`（如果用了的话）。不要写 `<all_urls>`，否则审核会变得极慢，而且会被打上“不安全”的标签。

### 8.3 发布前检查清单

- [ ] manifest.json版本号已更新
- [ ] 所有功能测试通过
- [ ] 无console错误
- [ ] 图标文件完整
- [ ] 代码已压缩（可选）
- [ ] README文档完整

## 9. 性能优化

### 9.1 DOM操作优化

- **批量操作**：使用`DocumentFragment`
- **避免频繁查询**：缓存DOM元素引用
- **事件委托**：使用事件冒泡减少监听器

### 9.2 网络请求优化

- **请求合并**：多个股票可以合并请求（当前未实现）
- **请求缓存**：相同股票短时间内不重复请求
- **超时控制**：避免长时间等待

### 9.3 内存管理

- **及时清理**：移除不需要的DOM元素
- **定时器清理**：组件销毁时清除定时器
- **事件监听清理**：避免内存泄漏

## 10. 常见问题排查

### 10.1 浮窗不显示

**可能原因**：
1. Content Script未注入
2. 页面URL不符合匹配规则
3. 浮窗被关闭且未唤醒

**排查步骤**：
1. 检查`manifest.json`中的`content_scripts.matches`
2. 检查控制台是否有错误
3. 点击插件图标尝试唤醒

### 10.2 数据不更新

**可能原因**：
1. 网络请求失败
2. 定时器未启动
3. 数据解析错误

**排查步骤**：
1. 检查网络请求是否成功（Network面板）
2. 检查定时器是否运行（console.log）
3. 检查数据格式是否正确

### 10.3 轮播不工作

**可能原因**：
1. 股票数量不足3只
2. 定时器被清除
3. rotationPaused为true

**排查步骤**：
1. 检查`getRotateList().length > MAX_DISPLAY`
2. 检查`rotateTimer`是否存在
3. 检查鼠标是否悬停在浮窗上

## 11. 代码规范

### 11.1 命名规范

- **变量**：驼峰命名，如`stockList`、`currentPage`
- **函数**：驼峰命名，如`updateDisplay`、`createWidget`
- **常量**：大写下划线，如`MAX_DISPLAY`、`ROTATE_INTERVAL`
- **CSS类**：短横线命名，如`lt-stock-row`、`lt-header`

### 11.2 注释规范

```javascript
/**
 * 函数功能描述
 * @param {type} paramName - 参数说明
 * @returns {type} 返回值说明
 */
function functionName(paramName) {
  // 实现逻辑
}
```

### 11.3 代码组织

- 相关功能放在一起
- 使用IIFE避免全局污染
- 提取公共函数避免重复代码

## 12. 未来优化方向

### 12.1 功能扩展

- [ ] 支持更多数据源
- [ ] 支持K线图显示
- [ ] 支持价格提醒
- [ ] 支持股票分组
- [ ] 支持自定义主题

### 12.2 性能优化

- [ ] 使用Web Workers处理数据
- [ ] 实现虚拟滚动（大量股票时）
- [ ] 优化动画性能
- [ ] 减少内存占用

### 12.3 用户体验

- [ ] 添加加载动画
- [ ] 优化错误提示
- [ ] 添加快捷键支持
- [ ] 支持拖拽排序

## 13. 参考资料

- [Chrome Extension官方文档](https://developer.chrome.com/docs/extensions/)
- [Manifest V3迁移指南](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/storage/)
- [Content Scripts文档](https://developer.chrome.com/docs/extensions/mv3/content_scripts/)
