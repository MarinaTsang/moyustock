# 摸鱼看盘 - 代码结构说明

面向不熟悉 JavaScript / Chrome 扩展的客户端开发（如 Android、鸿蒙）同学，便于快速理解项目骨架和关键概念。

---

## 一、Chrome 扩展是什么（类比理解）

- **扩展** ≈ 一个独立的小应用，由浏览器加载，能注入到网页、常驻后台、有一个“点击图标弹出的窗口”。
- **和普通网页的区别**：扩展可以访问浏览器提供的 `chrome.*` API（存储、标签页、发网络请求等），且有多份“脚本”运行在不同环境里，需要互相通信。

---

## 二、项目里有哪些“部分”（入口与角色）

| 文件 | 运行环境 | 作用（一句话） |
|------|----------|----------------|
| **manifest.json** | 浏览器读配置用 | 声明扩展名、权限、哪些脚本/样式要加载、何时加载。类似 Android 的 AndroidManifest.xml。 |
| **background.js** | 扩展的“后台” | 只有一个常驻的 Service Worker，负责：点击图标时通知页面、切换标签时补注、代页面请求行情（避免 CORS）。 |
| **content.js** | **注入到每个网页** | 在用户打开的网页里运行，创建并维护右下角股票浮窗（DOM、轮播、老板键、设置等）。**核心业务逻辑在这里。** |
| **content.css** | 注入到每个网页 | 浮窗的样式，只作用于 content.js 创建的节点。 |
| **popup.html + popup.js** | 点击扩展图标时弹出的窗口 | 弹窗内的“监控/设置”界面，和 content 浮窗是两套 UI；共享同一份 `chrome.storage.local` 里的股票列表。 |

关系可以理解为：

- 用户点击扩展图标 → **background** 收到 → 给当前标签页发消息 → **content** 收到消息后显示/唤醒浮窗。
- 浮窗里的数据（自选列表、位置、是否被老板键隐藏）存在 **chrome.storage**，popup 和 content 都读写同一份。

---

## 三、manifest.json 字段说明（JSON 不能写注释，这里用文档说明）

```text
manifest_version: 3           // 使用 MV3 规范
name / version / description  // 扩展名称、版本、描述

permissions: ["scripting", "tabs", "storage"]
  // scripting：向页面注入 JS/CSS
  // tabs：获取/切换标签页
  // storage：持久化存储（类似 SharedPreferences）

host_permissions: ["http://qt.gtimg.cn/*"]
  // 允许扩展（含 background）向该域名发请求，避免页面 CORS

background: { "service_worker": "background.js" }
  // 后台脚本：只有一个 JS，以 Service Worker 形式运行，无 DOM

content_scripts: [{ "matches": ["<all_urls>"], "js": ["content.js"], "css": ["content.css"], "run_at": "document_end" }]
  // 在“所有网页”加载结束时注入 content.js 和 content.css
  // run_at: "document_end" 表示 DOM 准备好后执行，类似页面 onLoad

action: { "default_title": "...", "default_icon": {...} }
  // 工具栏图标的标题和图标；点击时触发 chrome.action.onClicked（在 background 里监听）
```

没有写 `default_popup`，所以点击图标不会直接打开 popup 页面，而是由 background 发消息给 content 显示浮窗；popup 可能是从别处打开或后续加的入口。

---

## 四、各脚本之间的通信（消息机制）

- **chrome.runtime.sendMessage(msg, callback)**  
  从 content 或 popup 发消息到“扩展内部”（background 或其它监听方）。  
  类比：发一条“事件”或 Intent，带 type 和 payload。

- **chrome.runtime.onMessage.addListener(callback)**  
  在 background 里监听消息；根据 `msg.type` 做不同事（例如 `GET_STOCK` 去请求行情并 `sendResponse`）。

- **chrome.tabs.sendMessage(tabId, msg)**  
  background 向**指定标签页**里的 content script 发消息（例如 `SHOW_FLOAT` 唤醒浮窗）。  
  只有注入过 content 的标签页才能收到。

规则：  
- 谁要“回话”就调用 `sendResponse`（异步时要 `return true` 保持通道打开）。  
- content 和 popup 之间不直接发消息，一般通过 **chrome.storage** 存数据，需要时读 storage 或由 background 中转。

---

## 五、存储：chrome.storage.local

- **chrome.storage.local.get(keys, callback)**  
  读若干 key；`keys` 可以是字符串数组，如 `['stockList', 'userHidden']`。  
  结果在 callback 的 `result` 里：`result.stockList`、`result.userHidden`。

- **chrome.storage.local.set(obj)**  
  写入一组 key-value；例如 `set({ stockList: [...] })`，可和 get 的 key 不一致，按需读写。

- **chrome.storage.onChanged.addListener((changes, areaName) => { ... })**  
  任意地方（包括别的标签页里的 content）改了 storage，这里都会收到；用于多标签同步（例如老板键隐藏状态）。

和 **localStorage** 的区别：  
- `localStorage` 按“当前网页域名”隔离，content script 用的是**被注入页面的域名**。  
- `chrome.storage.local` 按**扩展**隔离，所有 content、popup、background 共享，且可跨标签页。  
本项目中：股票列表、老板键隐藏状态用 storage；浮窗位置、是否关闭过浮窗用 localStorage（只影响当前页）。

---

## 六、content.js 结构概览（浮窗逻辑）

content.js 是 IIFE（立即执行函数），避免全局变量污染页面：

```js
(function () {
  // 1) 常量、模块级变量（定时器、列表、状态）
  // 2) createWidget()：创建浮窗 DOM，绑定事件，启动定时刷新/轮播
  // 3) 消息监听：收到 SHOW_FLOAT 则 createWidget()
  // 4) 页面加载完成后根据“是否曾关闭”决定是否自动 createWidget()
})();
```

**和 Android/鸿蒙的类比：**

- **DOM 操作**：`document.createElement`、`appendChild`、`querySelector` 等 ≈ 在 View 树里创建/查找/挂载 View。
- **事件**：`addEventListener('click', fn)` ≈ `setOnClickListener`；`keydown`、`mouseenter` 等同理。
- **定时器**：`setInterval(fn, ms)` 每隔 ms 执行一次；`clearInterval(id)` 取消。类似 Handler.postDelayed 的循环版。
- **异步**：`async/await`、`Promise` ≈ 协程或 Future，用于请求行情、顺序“先请求再刷新 UI”。

**关键状态量（在 content.js 顶部或 createWidget 内）：**

- `stockList`：当前自选股 code 列表（与 storage 同步）。
- `rotateTimer` / `refreshTimer`：轮播定时器、定时刷新定时器。
- `isAppHidden`：是否被老板键隐藏（与 storage 的 `userHidden` 同步）。
- `rotationPaused`：鼠标在浮窗上时暂停轮播翻页（定时器可不停）。

**关键流程：**

1. **浮窗创建**：`createWidget()` 里先读 storage（老板键状态、股票列表），再拼 HTML、append 到 `document.body`，绑定按钮、拖拽、老板键、storage 监听等。
2. **刷新与轮播**：`updateDisplay()` 根据当前“关键态/普通态”决定显示哪几支、是否轮播；`refreshTimer` 定期调 `updateDisplay(false)`；`rotateTimer` 定期调 `rotateAndUpdate()` 做翻页动画。
3. **老板键**：监听 document 的 keydown（Option+Q），切换 `isAppHidden` 并写 storage；storage.onChanged 里同步隐藏/显示，并清空或重建轮播定时器。

---

## 七、background.js 结构概览

- **isInjectableUrl(url)**：判断是否为 http(s)，只有这类页面才注入。
- **injectIntoTab(tabId)**：向指定标签页注入 content.css + content.js（用于补注）。
- **chrome.tabs.onActivated**：切换标签时对当前标签执行 injectIntoTab，保证旧标签也能有浮窗。
- **chrome.runtime.onInstalled**：安装/更新后对当前所有 http(s) 标签执行注入。
- **chrome.action.onClicked**：点击扩展图标时，向当前标签发 `SHOW_FLOAT`；若未注入则先注入再发。
- **chrome.runtime.onMessage**：处理 `GET_STOCK`，用 fetch 请求腾讯行情接口，解码后通过 `sendResponse` 回传；避免在页面里直接请求带来的 CORS 问题。

---

## 八、popup 与 content 的协作

- **共享数据**：都通过 `chrome.storage.local` 读写 `stockList`（以及其它需要的 key）。  
- **无直接通信**：popup 不直接调 content 的方法；popup 改完列表写 storage，content 里已通过 `chrome.storage.onChanged` 监听 `stockList`，会自己 `updateDisplay` 并刷新浮窗。  
- 若希望“打开 popup 时当前页立刻显示浮窗”，需要 background 在适当时机向当前 tab 发消息（例如 popup 打开时通知 background，再由 background 发 `SHOW_FLOAT`）；当前实现是用户点击图标就发 `SHOW_FLOAT`，由 content 负责显示。

---

## 九、阅读顺序建议

1. 先看 **manifest.json** + 本文第二节、第三节，弄清有哪些入口和权限。  
2. 看 **background.js**：从 `onClicked` 和 `onMessage` 两条线，理解“点击图标 → 发消息 → content 显示浮窗”和“请求行情”的流程。  
3. 看 **content.js**：先找 `createWidget`、`updateDisplay`、`setupRotation`、老板键和 storage 监听，再按需看关键态、轮播、交易时间等细节。  
4. 需要改 popup 界面或逻辑时再看 **popup.html / popup.js**。

---

## 十、名词与概念速查

- **Content Script**：注入到网页里的脚本，和页面共享 DOM，但 JS 环境隔离（不能直接访问页面的 JS 变量），可访问 chrome.* API。
- **Service Worker（background）**：无 DOM、生命周期由浏览器管理，可被休眠；用于接收事件、发消息、发请求。
- **CORS**：浏览器对“页面脚本直接请求别的域名”的限制；扩展的 background 不受页面 CORS 限制，所以由 background 代请求行情。
- **IIFE**：`(function () { ... })();` 立即执行并形成闭包，避免全局变量。
- **Promise / async-await**：JS 的异步写法；`await fn()` 会等 Promise 完成再往下执行，类似同步写法。

如有新文件或新职责，建议在本文档补一节“文件/职责表”和“消息/存储 key 一览”，方便后续维护。
