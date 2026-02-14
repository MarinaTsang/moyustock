# 存在感三态机制设计文档

## 1. 状态定义

### 1.1 三种状态

- **静默态（SILENT）**：当前时间无任何股票处于其交易时间
- **活跃态（ACTIVE）**：有股票处于交易时间，但无显著波动（涨跌幅 < ±3%）
- **关键态（CRITICAL）**：至少一只处于交易时间的股票，涨跌幅超过 ±3%，且持续超过 N 秒

### 1.2 状态优先级

关键态 > 活跃态 > 静默态

## 2. 状态判断伪代码

### 2.1 交易时间判断

```javascript
/**
 * 判断股票是否处于交易时间
 * @param {string} code - 股票代码（如：sh600519, sz000001, hk00700）
 * @param {Date} now - 当前时间（可选，默认使用系统时间）
 * @returns {boolean} - true表示在交易时间，false表示非交易时间
 */
function isInTradingTime(code, now = new Date()) {
  const prefix = code.slice(0, 2).toLowerCase();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dayOfWeek = now.getDay(); // 0=周日, 1=周一, ..., 6=周六
  
  // 周末不交易
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return false;
  }
  
  // 转换为分钟数，便于比较
  const timeInMinutes = hour * 60 + minute;
  
  if (prefix === 'sh' || prefix === 'sz' || prefix === 'bj') {
    // A股交易时间：9:30-11:30, 13:00-15:00
    const morningStart = 9 * 60 + 30;  // 9:30
    const morningEnd = 11 * 60 + 30;    // 11:30
    const afternoonStart = 13 * 60;     // 13:00
    const afternoonEnd = 15 * 60;       // 15:00
    
    return (timeInMinutes >= morningStart && timeInMinutes <= morningEnd) ||
           (timeInMinutes >= afternoonStart && timeInMinutes <= afternoonEnd);
  }
  
  if (prefix === 'hk') {
    // 港股交易时间：9:30-12:00, 13:00-16:00
    const morningStart = 9 * 60 + 30;  // 9:30
    const morningEnd = 12 * 60;        // 12:00
    const afternoonStart = 13 * 60;     // 13:00
    const afternoonEnd = 16 * 60;      // 16:00
    
    return (timeInMinutes >= morningStart && timeInMinutes <= morningEnd) ||
           (timeInMinutes >= afternoonStart && timeInMinutes <= afternoonEnd);
  }
  
  // 其他交易所默认返回 false（不参与状态判断）
  return false;
}
```

### 2.2 状态判断主逻辑

```javascript
/**
 * 状态判断常量
 */
const CRITICAL_THRESHOLD = 3.0;        // 关键态阈值：±3%
const CRITICAL_DURATION_SEC = 10;       // 关键态持续时间：10秒
const STATE_CHECK_INTERVAL_SEC = 5;     // 状态检查间隔：5秒（低频检查）

/**
 * 状态判断数据结构
 */
let stateMachine = {
  currentState: 'SILENT',              // 当前状态：SILENT | ACTIVE | CRITICAL
  criticalStocks: {},                  // 关键股票记录：{ code: { startTime, changePct } }
  lastCheckTime: null,                 // 上次检查时间
  stateHistory: []                     // 状态历史（可选，用于调试）
};

/**
 * 判断当前应处于的状态
 * @param {Array} stockList - 股票代码列表
 * @param {Object} stockDataByCode - 股票数据：{ code: { changePct, ... } }
 * @returns {string} - 'SILENT' | 'ACTIVE' | 'CRITICAL'
 */
function determineState(stockList, stockDataByCode) {
  const now = new Date();
  const nowTimestamp = now.getTime();
  
  // 过滤出在交易时间的股票
  const tradingStocks = stockList.filter(code => {
    if (code === MARKET_INDEX_CODE) return false; // 大盘指数不参与状态判断
    return isInTradingTime(code, now);
  });
  
  // 如果没有股票在交易时间，返回静默态
  if (tradingStocks.length === 0) {
    return 'SILENT';
  }
  
  // 检查是否有股票达到关键态条件
  let hasCritical = false;
  const newCriticalStocks = {};
  
  for (const code of tradingStocks) {
    const data = stockDataByCode[code];
    if (!data || !data.ok) continue;
    
    const changePct = parseFloat(data.changePct);
    if (isNaN(changePct)) continue;
    
    const absChangePct = Math.abs(changePct);
    
    // 如果涨跌幅超过阈值
    if (absChangePct >= CRITICAL_THRESHOLD) {
      const existing = stateMachine.criticalStocks[code];
      
      if (existing) {
        // 检查持续时间
        const duration = (nowTimestamp - existing.startTime) / 1000;
        if (duration >= CRITICAL_DURATION_SEC) {
          // 持续时间足够，标记为关键态
          hasCritical = true;
          newCriticalStocks[code] = existing; // 保持原有开始时间
        } else {
          // 持续时间不足，继续累积
          newCriticalStocks[code] = existing;
        }
      } else {
        // 首次检测到超过阈值，记录开始时间
        newCriticalStocks[code] = {
          startTime: nowTimestamp,
          changePct: changePct
        };
      }
    }
  }
  
  // 更新关键股票记录
  stateMachine.criticalStocks = newCriticalStocks;
  
  // 如果有股票达到关键态，返回关键态
  if (hasCritical) {
    return 'CRITICAL';
  }
  
  // 否则返回活跃态（有股票在交易，但无显著波动）
  return 'ACTIVE';
}

/**
 * 状态检查定时器（低频，每5秒检查一次）
 */
function startStateChecker() {
  setInterval(() => {
    if (isSettingsMode || !widgetCreated) return;
    
    const rotateList = getRotateList();
    const newState = determineState(rotateList, lastStockDataByCode);
    
    // 状态变化时才更新UI
    if (newState !== stateMachine.currentState) {
      const oldState = stateMachine.currentState;
      stateMachine.currentState = newState;
      
      // 触发状态变化回调
      onStateChanged(oldState, newState);
    }
    
    stateMachine.lastCheckTime = Date.now();
  }, STATE_CHECK_INTERVAL_SEC * 1000);
}

/**
 * 状态变化回调
 * @param {string} oldState - 旧状态
 * @param {string} newState - 新状态
 */
function onStateChanged(oldState, newState) {
  // 更新UI样式
  updateUIForState(newState);
  
  // 可选：记录状态变化历史
  stateMachine.stateHistory.push({
    time: Date.now(),
    from: oldState,
    to: newState
  });
  
  // 限制历史记录长度（保留最近50条）
  if (stateMachine.stateHistory.length > 50) {
    stateMachine.stateHistory.shift();
  }
}
```

### 2.3 关键态持续时间判断优化

```javascript
/**
 * 优化版：使用更精确的持续时间判断
 * 避免因数据刷新间隔导致的持续时间计算不准确
 */
function updateCriticalStockDuration(code, changePct, nowTimestamp) {
  const absChangePct = Math.abs(changePct);
  
  if (absChangePct >= CRITICAL_THRESHOLD) {
    const existing = stateMachine.criticalStocks[code];
    
    if (existing) {
      // 如果涨跌幅方向一致（都是涨或都是跌），继续累积时间
      const sameDirection = (existing.changePct >= 0 && changePct >= 0) ||
                           (existing.changePct < 0 && changePct < 0);
      
      if (sameDirection) {
        // 更新记录，保持开始时间不变
        stateMachine.criticalStocks[code] = {
          startTime: existing.startTime,
          changePct: changePct
        };
      } else {
        // 方向改变，重置开始时间
        stateMachine.criticalStocks[code] = {
          startTime: nowTimestamp,
          changePct: changePct
        };
      }
    } else {
      // 首次检测到，记录开始时间
      stateMachine.criticalStocks[code] = {
        startTime: nowTimestamp,
        changePct: changePct
      };
    }
  } else {
    // 涨跌幅低于阈值，移除记录
    delete stateMachine.criticalStocks[code];
  }
}
```

## 3. 状态机设计

### 3.1 状态转换图

```
                    ┌─────────┐
                    │ SILENT  │ ←─── 默认状态
                    └────┬────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │ ACTIVE  │◄───┤ CRITICAL│───►│ ACTIVE  │
    └─────────┘    └─────────┘    └─────────┘
         │               │               │
         └───────────────┴───────────────┘
                         │
                    (非交易时间)
                         │
                         ▼
                    ┌─────────┐
                    │ SILENT  │
                    └─────────┘
```

### 3.2 状态转换规则

| 当前状态 | 条件 | 下一状态 | 说明 |
|---------|------|---------|------|
| SILENT | 有股票进入交易时间 | ACTIVE | 开始交易 |
| ACTIVE | 无股票在交易时间 | SILENT | 交易结束 |
| ACTIVE | 股票涨跌幅 ≥ ±3% 且持续 ≥ 10秒 | CRITICAL | 达到关键态条件 |
| CRITICAL | 所有关键股票涨跌幅 < ±3% | ACTIVE | 波动回落 |
| CRITICAL | 无股票在交易时间 | SILENT | 交易结束 |
| CRITICAL | 关键股票涨跌幅持续 < ±3% 超过 5秒 | ACTIVE | 快速回落（避免频繁切换）|

### 3.3 状态机实现建议

```javascript
/**
 * 状态机类（可选，如果使用面向对象）
 */
class PresenceStateMachine {
  constructor() {
    this.state = 'SILENT';
    this.criticalStocks = {};
    this.lastCheckTime = null;
    this.stateHistory = [];
  }
  
  /**
   * 状态转换
   */
  transition(newState) {
    if (newState === this.state) return false;
    
    const oldState = this.state;
    this.state = newState;
    
    // 触发状态变化事件
    this.onStateChanged(oldState, newState);
    return true;
  }
  
  /**
   * 检查并更新状态
   */
  checkAndUpdate(stockList, stockDataByCode) {
    const newState = determineState(stockList, stockDataByCode);
    return this.transition(newState);
  }
  
  /**
   * 状态变化回调（可扩展）
   */
  onStateChanged(oldState, newState) {
    // 子类可重写此方法
  }
}
```

## 4. UI 行为差异说明

### 4.1 静默态（SILENT）

**视觉表现**：
- **浮窗透明度**：`opacity: 0.4`（更低调）
- **浮窗位置**：保持当前位置不变
- **背景色**：浅灰色（`#f5f5f5`），与页面融合
- **边框**：细边框（`1px solid rgba(0,0,0,0.05)`），几乎不可见
- **文字颜色**：灰色调（`#999`），降低存在感

**交互行为**：
- **轮播**：暂停（不轮播）
- **数据刷新**：继续刷新（保持数据最新），但频率可降低到每5秒
- **鼠标悬停**：悬停时透明度恢复到 `opacity: 1`，移开后恢复

**动画效果**：
- **状态切换**：使用 `transition: opacity 0.5s ease` 平滑过渡
- **无闪烁**：状态变化时使用淡入淡出，避免突兀

### 4.2 活跃态（ACTIVE）

**视觉表现**：
- **浮窗透明度**：`opacity: 0.7`（中等存在感）
- **背景色**：白色（`#fff`），正常显示
- **边框**：正常边框（`1px solid rgba(0,0,0,0.06)`）
- **文字颜色**：正常颜色（`#333`）

**交互行为**：
- **轮播**：正常轮播（如果股票数 > 3）
- **数据刷新**：正常刷新（每2秒）
- **鼠标悬停**：暂停轮播（保持现有行为）

**动画效果**：
- **状态切换**：平滑过渡
- **轮播动画**：保持现有的向上滑动效果

### 4.3 关键态（CRITICAL）

**视觉表现**：
- **浮窗透明度**：`opacity: 1`（完全显示）
- **背景色**：轻微高亮（`#fffef0` 或 `#f0f8ff`），根据涨跌选择暖色/冷色
- **边框**：加粗边框（`2px solid`），颜色跟随涨跌：
  - 涨：`#c0392b`（红色边框）
  - 跌：`#27ae60`（绿色边框）
- **文字颜色**：正常颜色，但关键股票的涨跌幅更醒目
- **阴影**：增强阴影（`box-shadow: 0 6px 24px rgba(0,0,0,0.15)`）

**交互行为**：
- **轮播**：继续轮播，但关键股票优先显示（如果可能）
- **数据刷新**：正常刷新（每2秒）
- **鼠标悬停**：暂停轮播（保持现有行为）

**动画效果**：
- **状态切换**：平滑过渡，但可添加轻微的"呼吸"效果（可选）
- **边框闪烁**：关键态首次进入时，边框轻微闪烁一次（`animation: borderPulse 0.5s ease`），之后保持静态

### 4.4 CSS 实现示例

```css
/* 静默态 */
#lt-stock-float.state-silent {
  opacity: 0.4;
  background: #f5f5f5;
  border-color: rgba(0, 0, 0, 0.05);
  transition: opacity 0.5s ease, background 0.5s ease;
}

#lt-stock-float.state-silent .lt-stock-row {
  color: #999;
}

/* 活跃态 */
#lt-stock-float.state-active {
  opacity: 0.7;
  background: #fff;
  border-color: rgba(0, 0, 0, 0.06);
  transition: opacity 0.5s ease, background 0.5s ease;
}

/* 关键态 */
#lt-stock-float.state-critical {
  opacity: 1;
  background: #fffef0; /* 暖色调，可根据涨跌调整 */
  border: 2px solid #c0392b; /* 红色边框，涨时 */
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.15);
  transition: opacity 0.5s ease, background 0.5s ease, border-color 0.5s ease;
}

#lt-stock-float.state-critical.critical-down {
  border-color: #27ae60; /* 绿色边框，跌时 */
  background: #f0f8ff; /* 冷色调 */
}

/* 关键态进入动画（可选） */
@keyframes borderPulse {
  0%, 100% { border-width: 2px; }
  50% { border-width: 3px; }
}

#lt-stock-float.state-critical.entering {
  animation: borderPulse 0.5s ease;
}
```

### 4.5 UI 更新函数

```javascript
/**
 * 根据状态更新UI
 * @param {string} state - 'SILENT' | 'ACTIVE' | 'CRITICAL'
 */
function updateUIForState(state) {
  if (!wrap) return;
  
  // 移除所有状态类
  wrap.classList.remove('state-silent', 'state-active', 'state-critical', 'critical-down');
  
  // 添加新状态类
  wrap.classList.add('state-' + state.toLowerCase());
  
  // 关键态特殊处理：判断整体涨跌
  if (state === 'CRITICAL') {
    const criticalCodes = Object.keys(stateMachine.criticalStocks);
    let overallUp = false;
    let overallDown = false;
    
    for (const code of criticalCodes) {
      const data = lastStockDataByCode[code];
      if (data && data.ok) {
        const changePct = parseFloat(data.changePct);
        if (!isNaN(changePct)) {
          if (changePct > 0) overallUp = true;
          if (changePct < 0) overallDown = true;
        }
      }
    }
    
    // 如果主要是涨，添加 critical-up（默认）
    // 如果主要是跌，添加 critical-down
    if (overallDown && !overallUp) {
      wrap.classList.add('critical-down');
    }
  }
}
```

## 5. 集成建议

### 5.1 初始化

```javascript
// 在 createWidget() 函数中初始化状态机
function createWidget() {
  // ... 现有代码 ...
  
  // 初始化状态机
  stateMachine = {
    currentState: 'SILENT',
    criticalStocks: {},
    lastCheckTime: null,
    stateHistory: []
  };
  
  // 启动状态检查器
  startStateChecker();
  
  // 初始UI状态
  updateUIForState('SILENT');
  
  // ... 其他代码 ...
}
```

### 5.2 数据更新时触发状态检查

```javascript
// 在 updateDisplay() 函数中，数据更新后触发状态检查
async function updateDisplay(forceRebuild = false) {
  // ... 现有代码 ...
  
  // 数据更新后，立即检查状态（不等待定时器）
  const rotateList = getRotateList();
  const newState = determineState(rotateList, lastStockDataByCode);
  
  if (newState !== stateMachine.currentState) {
    const oldState = stateMachine.currentState;
    stateMachine.currentState = newState;
    onStateChanged(oldState, newState);
  }
  
  // ... 其他代码 ...
}
```

### 5.3 注意事项

1. **状态检查频率**：使用低频检查（5秒一次），避免频繁状态切换
2. **持续时间判断**：关键态需要持续10秒才生效，避免短暂波动触发
3. **状态切换平滑**：使用CSS transition实现平滑过渡，避免突兀变化
4. **非交易时间**：周末、节假日、非交易时段自动进入静默态
5. **数据缺失处理**：如果股票数据获取失败，不参与状态判断

## 6. 配置参数

```javascript
// 可在代码顶部定义，便于调整
const PRESENCE_CONFIG = {
  CRITICAL_THRESHOLD: 3.0,           // 关键态阈值（%）
  CRITICAL_DURATION_SEC: 10,         // 关键态持续时间（秒）
  STATE_CHECK_INTERVAL_SEC: 5,       // 状态检查间隔（秒）
  SILENT_OPACITY: 0.4,               // 静默态透明度
  ACTIVE_OPACITY: 0.7,               // 活跃态透明度
  CRITICAL_OPACITY: 1.0,             // 关键态透明度
  SILENT_REFRESH_INTERVAL_SEC: 5,    // 静默态刷新间隔（秒，可选）
};
```

## 7. 测试场景

### 7.1 静默态测试
- 非交易时间（晚上、周末）
- 无股票在交易时间

### 7.2 活跃态测试
- 交易时间内，所有股票涨跌幅 < ±3%
- 从静默态切换到活跃态

### 7.3 关键态测试
- 股票涨跌幅达到 ±3%
- 持续时间达到 10 秒
- 多只股票同时达到关键态
- 关键态回落（涨跌幅 < ±3%）后回到活跃态

### 7.4 状态切换测试
- 静默态 → 活跃态（交易开始）
- 活跃态 → 关键态（波动达到阈值）
- 关键态 → 活跃态（波动回落）
- 活跃态 → 静默态（交易结束）
