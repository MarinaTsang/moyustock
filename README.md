# Stock Float · 摸鱼看盘

[简体中文](doc/README.zh-CN.md)

> A minimalist Chrome extension for discreet stock monitoring while working.

![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

### Overview

Stock Float is a Chrome extension that embeds a compact, unobtrusive floating widget in the bottom-right corner of any webpage. It shows real-time stock quotes, intraday trend lines, and market indices — without requiring you to switch tabs or open a dedicated financial app.

Designed for people who need to keep an eye on the market while working, it stays out of the way when nothing's happening and surfaces information precisely when it matters.

---

### Features

#### Real-Time Quotes
- Supports **A-shares** (Shanghai `sh`, Shenzhen `sz`, Beijing `bj`), **Hong Kong** (`hk`), and **US stocks** (`us`)
- Displays stock name, current price, and change percentage
- Intraday trend mini-chart sampled locally
- Limit-up / limit-down badge for A-shares (±9.8%)
- Shanghai Composite Index always shown in the header

#### Carousel & Watchlist
- Up to 3 stocks displayed simultaneously; automatically rotates every 5 seconds when you have more
- Manage your watchlist from the extension popup — supports codes like `600519`, `TSLA`, `00700`
- Carousel position persists across page refreshes

#### Three Presence States
| State | Appearance | Condition |
|-------|-----------|-----------|
| **Silent** | 35% opacity, minimal | Outside trading hours |
| **Active** | 85% opacity, normal | Market open, no significant moves |
| **Critical** | 100% opacity, colored border | Any stock ±3% for 10+ seconds |

Critical state distinguishes rising vs. falling with amber (up) vs. blue (down) accents and shows a contextual prompt.

#### Stealth / News Mode
Switch the widget into a **"News"** disguise — it hides all stock data and shows recent financial headlines instead, making it look like a news reader to onlookers. Toggle between Normal and News mode inside the widget.

#### Pre-Market & Post-Market Digest
A digest popup automatically appears at key times:
- **08:45 (pre-market)**: US market overnight summary, economic calendar
- **15:05 (post-market)**: A-share sector heatmap, institutional fund flow, stock review

The digest can also be opened manually from the popup.

#### AI Stock Summary
When a watchlist stock moves more than **5%**, the extension fetches recent news headlines from Google News and generates a concise plain-language reason summary. Cools down 30 minutes between triggers.

#### Theme
Follows the browser / OS color scheme automatically:
- **Dark mode**: dark background, amber (up) / steel-blue (down)
- **Light mode**: white background, amber-brown (up) / steel-blue (down)
- No glaring red/green in either mode — intentionally low-profile

#### Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| `Alt + Q` | Toggle widget visibility (Boss Key) |
| `Alt + Shift + D` | Toggle debug panel |

#### Privacy
- No account required, no login
- All data is fetched directly from public market APIs
- Nothing is uploaded or sent to any third-party server
- Watchlist stored locally in `chrome.storage.local`

---

### Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Click the extension icon or press `Alt + Q` on any page

---

### Data Sources

| Source | Used For |
|--------|----------|
| `qt.gtimg.cn` | Real-time A-share / HK / US quotes |
| `push2.eastmoney.com` | Sector heatmap, fund flows, US indices |
| `news.google.com` (RSS) | News headlines for AI summary |
| `api.frankfurter.dev` | USD/CNH exchange rate |

---

### Project Structure

```
├── manifest.json        # Extension manifest (MV3)
├── background.js        # Service worker: quote proxy, digest alarms
├── content.js           # Injected into every page: widget logic
├── content.css          # Widget styles (dark/light theme via CSS variables)
├── popup.html           # Extension popup UI
├── popup.js             # Popup logic
├── shared.js            # Shared utilities (quote parsing, normalization)
├── market.js            # Market hours, exchange detection
├── trend.js             # Intraday trend line rendering (SVG)
├── widgetView.js        # Widget DOM creation
├── panelView.js         # Settings panel view
├── carouselView.js      # Carousel / rotation view
├── anomalyMonitor.js    # Anomaly detection module
└── crawler.js           # Data crawler (sector, fund flow)
```

---

### License

MIT
