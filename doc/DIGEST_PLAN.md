# 开盘前 / 盘后速览（Daily Digest in Popup）

## 目标

在 popup.html 非交易时段展示"开盘前速览"或"盘后总结"：每只自选股显示最新价格和近期新闻摘要。

---

## 涉及文件

| 文件 | 改动 |
|---|---|
| `popup.html` | 新增 `#digest-section` + 样式 |
| `popup.js` | 新增 5 个函数 + 在 `init()` 末尾调用 |
| `background.js` | 不改（复用 `GET_STOCK` + `GET_AI_STOCK_SUMMARY`） |
| `content.js` | 不改 |
| `manifest.json` | 不改 |

---

## 时段判断（`getMarketPhase()`）

以 A 股为参考（覆盖大多数自选）：

| 条件 | 返回值 | 显示标题 |
|---|---|---|
| 周一-五 < 9:30 | `'pre-market'` | 开盘前速览 |
| 周一-五 ≥ 15:00 | `'post-market'` | 盘后总结 |
| 周末 | `'weekend'` | 开盘前速览（下一交易日） |
| 其他（交易中） | `'trading'` | 不显示 |

---

## UI 结构（插在 hero 和 自选管理 之间）

```
┌─────────────────────────────────────┐
│ 开盘前速览                    [↻]   │ ← section-title
├─────────────────────────────────────┤
│ 贵州茅台 sh600519        ¥1480 +1.2%│ ← digest-card-top
│ • 财报超预期                        │ ← digest-reasons
│ • 分析师上调评级                     │
├─────────────────────────────────────┤
│ 比亚迪 sz002594         ¥280 -0.5%  │
│ 加载新闻中…                         │ ← loading state
└─────────────────────────────────────┘
```

---

## 数据获取（两阶段，每只股票独立并行）

```
loadOneStockDigest(code)
  ├─ 1. GET_STOCK → ~100ms → 立即渲染价格 + 名称
  └─ 2. GET_AI_STOCK_SUMMARY(code, name) → 1-3s → 更新新闻 bullets
```

所有股票**同时**发起，互不阻塞。失败时显示"暂无近期新闻"。

---

## popup.js 新增函数

| 函数 | 作用 |
|---|---|
| `getMarketPhase()` | 返回当前时段 |
| `createDigestCard(code)` | 创建骨架 card，返回 `{ el, setPrice, setNews }` |
| `loadOneStockDigest(code, card)` | 两阶段获取 + 更新 card |
| `loadDigest()` | 设置标题、创建卡片、并行触发加载 |
| 刷新按钮绑定 | 防抖 2s，重新调用 `loadDigest()` |

`init()` 末尾追加：
```javascript
const phase = getMarketPhase();
if (phase !== 'trading') loadDigest(phase);
```

---

## 新增 CSS（在 popup.html `<style>` 中追加）

- `.digest-card`: 白底圆角卡片，`gap: 8px`
- `.digest-card-top`: flex 横排，名称靠左 + 价格靠右
- `.digest-price.up` / `.down`: 绿色 / 红色
- `.digest-reasons`: 小字 `font-size: 11px`，灰色
- `.digest-reasons-loading`: 斜体占位

---

## 边界处理

- 无自选时：不渲染 digest section
- 价格获取失败：显示"—"
- 新闻获取失败 / 无结果：显示"暂无近期新闻"
- 交易时段：`#digest-section { display:none }`
