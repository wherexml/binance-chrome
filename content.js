// 把 hook 注入页面（content-script 与页面是隔离环境）
(function inject() {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("pageHook.js");
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  })();
  
  const state = {
    rawOrders: [],        // 原始记录（来自接口或DOM）
    collectedPages: new Set(),
    targetDate: new Date().toISOString().slice(0, 10), // yyyy-mm-dd（本地时区解析时仅看日期部分）
    collecting: false,
    multiDayData: new Map(), // 存储多日数据：日期 -> 交易数据
    currentViewDate: null    // 当前查看的日期
  };

  // 检查时间是否在指定日期的范围内（当日8:00到次日8:00）
  function isInDateRange(timeStr, targetDateStr) {
    if (!timeStr || !targetDateStr) return false;
    
    const time = new Date(timeStr);
    if (isNaN(time.getTime())) return false;
    
    // 构造目标日期的8:00和次日8:00
    const targetDate = new Date(targetDateStr + 'T08:00:00');
    const nextDayDate = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
    
    return time >= targetDate && time < nextDayDate;
  }

  // Alpha交易积分表格 - 按2的次方递增
  const ALPHA_SCORE_TABLE = [
    { volume: 2, score: 1 },
    { volume: 4, score: 2 },
    { volume: 8, score: 3 },
    { volume: 16, score: 4 },
    { volume: 32, score: 5 },
    { volume: 64, score: 6 },
    { volume: 128, score: 7 },
    { volume: 256, score: 8 },
    { volume: 512, score: 9 },
    { volume: 1024, score: 10 },
    { volume: 2048, score: 11 },
    { volume: 4096, score: 12 },
    { volume: 8192, score: 13 },
    { volume: 16384, score: 14 },
    { volume: 32768, score: 15 },
    { volume: 65536, score: 16 },
    { volume: 131072, score: 17 },
    { volume: 262144, score: 18 },
    { volume: 524288, score: 19 },
    { volume: 1048576, score: 20 },
    { volume: 2097152, score: 21 },
    { volume: 4194304, score: 22 },
    { volume: 8388608, score: 23 },
    { volume: 16777216, score: 24 },
    { volume: 33554432, score: 25 },
    { volume: 67108864, score: 26 },
    { volume: 134217728, score: 27 }
  ];

  // 计算Alpha交易分数
  function calculateAlphaScore(totalVolume) {
    let currentScore = 0;
    let currentTier = null;
    let nextTier = null;
    
    // 找到当前达到的最高档位
    for (let i = 0; i < ALPHA_SCORE_TABLE.length; i++) {
      if (totalVolume >= ALPHA_SCORE_TABLE[i].volume) {
        currentScore = ALPHA_SCORE_TABLE[i].score;
        currentTier = ALPHA_SCORE_TABLE[i];
      } else {
        nextTier = ALPHA_SCORE_TABLE[i];
        break;
      }
    }
    
    // 如果达到最高档位
    if (!nextTier && currentScore === 27) {
      nextTier = null;
    }
    
    return {
      score: currentScore,
      currentTier,
      nextTier,
      gap: nextTier ? nextTier.volume - totalVolume : 0
    };
  }


  
  // 设置日期选择器为今天
  function setDatePickerToToday() {
    const today = new Date().toISOString().slice(0, 10);
    
    // 查找币安的日期选择器输入框
    const dateInputs = document.querySelectorAll('.bn-web-datepicker-input input[date-range]');
    let dateChanged = false;
    
    dateInputs.forEach(input => {
      if (input.value !== today) {
        // 设置值
        input.value = today;
        
        // 触发输入事件以确保币安的UI更新
        const inputEvent = new Event('input', { bubbles: true });
        input.dispatchEvent(inputEvent);
        
        // 触发change事件
        const changeEvent = new Event('change', { bubbles: true });
        input.dispatchEvent(changeEvent);
        
        dateChanged = true;
        console.log(`已设置日期选择器为今天: ${today}`);
      }
    });
    
    // 如果日期有变化，自动点击搜索按钮
    if (dateChanged) {
      setTimeout(() => {
        clickSearchButton();
      }, 500); // 延迟500ms确保日期设置完成
    }
  }

  // 点击搜索按钮
  function clickSearchButton() {
    // 查找搜索按钮的多种可能选择器
    const searchSelectors = [
      'button[data-bn-type="button"] .css-j2trfz',
      'button[data-bn-type="button"]:contains("搜索")',
      'button.css-j2trfz',
      'button:contains("搜索")',
      'button[data-bn-type="button"]'
    ];
    
    let searchButton = null;
    
    // 尝试不同的选择器
    for (const selector of searchSelectors) {
      // 对于包含文本的选择器，需要手动查找
      if (selector.includes(':contains')) {
        const buttons = document.querySelectorAll('button[data-bn-type="button"]');
        for (const btn of buttons) {
          if (btn.textContent.includes('搜索') || btn.textContent.includes('Search')) {
            searchButton = btn;
            break;
          }
        }
      } else {
        searchButton = document.querySelector(selector);
      }
      
      if (searchButton) break;
    }
    
    // 额外尝试通过class查找
    if (!searchButton) {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.className.includes('css-j2trfz') || 
            btn.textContent.trim() === '搜索' || 
            btn.textContent.trim() === 'Search') {
          searchButton = btn;
          break;
        }
      }
    }
    
    if (searchButton && !searchButton.disabled) {
      searchButton.click();
      console.log('已自动点击搜索按钮');
    } else {
      console.log('未找到搜索按钮或按钮被禁用');
    }
  }

  // 页面加载完成后设置日期
  function initDatePicker() {
    // 延迟执行，等待页面完全加载
    setTimeout(() => {
      setDatePickerToToday();
    }, 1000);
    
    // 监听页面变化，如果日期选择器出现了，自动设置为今天
    const observer = new MutationObserver(() => {
      setDatePickerToToday();
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    // 10秒后停止监听，避免过度消耗资源
    setTimeout(() => {
      observer.disconnect();
    }, 10000);
  }

  // UI：简化的控制面板
  (function mountUI() {
    const panel = document.createElement('div');
    panel.style.cssText = `
      position: fixed; z-index: 999999; right: 16px; bottom: 16px;
      display:flex; gap:8px; padding:10px 12px; background:#111; color:#fff;
      border:1px solid #333; border-radius:12px; font-size:12px; align-items:center
    `;
    panel.innerHTML = `
    <button id="bia-collect" style="padding:6px 10px;border:1px solid #444;background:#1f6feb;color:#fff;border-radius:8px;cursor:pointer">统计交易数据</button>
  `;
  
    document.body.appendChild(panel);
  
    document.getElementById('bia-collect').onclick = runCollection;
    
    // 初始化日期选择器
    initDatePicker();
  })();
  
  // 监听 pageHook 发来的 API 数据
  window.addEventListener("message", (ev) => {
    const msg = ev?.data;
    if (!msg || msg.source !== "BIA" || msg.type !== "api") return;
    const list = normalizeApiPayload(msg.payload?.data || msg.payload); // 尝试规整出 orders 数组
    if (Array.isArray(list) && list.length) {
      mergeOrders(list, "api");
    }
  });
  
  // 规整 API 回包结构（不同接口字段名可能不同：data、list、orders…）
  function normalizeApiPayload(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.list)) return data.list;
    if (Array.isArray(data.rows)) return data.rows;
    if (Array.isArray(data.orders)) return data.orders;
    // 兜底：尝试在对象里找到类似订单的数组
    const candidates = Object.values(data).find(v => Array.isArray(v) && v.length && typeof v[0] === "object");
    return Array.isArray(candidates) ? candidates : [];
  }
  
  // 合并记录（去重按 orderId + updateTime + 代币 + 方向 + 金额）
  function mergeOrders(arr, src = "api") {
    const key = (o) => {
      const orderId = o.orderId || o.id || "";
      const time = o.updateTime || o.time || o.transactTime || "";
      const symbol = o.symbol || "";
      const side = o.side || "";
      const amount = o.cummulativeQuoteQty || o.quoteQty || 0;
      return `${orderId}_${time}_${symbol}_${side}_${amount}`;
    };
    const map = new Map(state.rawOrders.map(o => [key(o), o]));
    for (const o of arr) {
      map.set(key(o), { ...o, _src: src });
    }
    state.rawOrders = [...map.values()];
  }
  

  // 主流程：自动翻页抓取 + DOM 回退解析 + 统计
  async function runCollection() {
    if (state.collecting) return;
    state.collecting = true;
    state.rawOrders = [];
    state.collectedPages.clear();
  
    // 先尝试当前页 DOM 解析一次（以便页面尚未触发接口也能拿到）
    scrapeDomIntoState();
  
    // 自动翻页：直到没有"下一页"
    const maxPages = 1000; // 保险
    for (let i = 0; i < maxPages; i++) {
      // 本页 DOM 解析
      scrapeDomIntoState();
  
      // 尝试点击"下一页"
      const moved = await gotoNextPage();
      if (!moved) break;
  
      // 等待表格刷新
      await waitForTableChange(1500);
    }
  
    // 聚合所有日期的数据
    const allDatesData = aggregateAllDates();
    console.log('多日数据统计完成，共', allDatesData.size, '天');
    
    // 显示结果表格（支持多日切换）
    renderMultiDayResults(allDatesData);
    
    state.collecting = false;
  }
  
  // DOM 解析当前页表格
  function scrapeDomIntoState() {
    const table = document.querySelector("table");
    if (!table) return;
    const ths = [...table.querySelectorAll("thead th")].map(el => el.textContent.trim());
    const trows = [...table.querySelectorAll("tbody tr")];
    if (!ths.length || !trows.length) return;
  
    // 建立列索引（中英兼容）
    const idx = {
      time: ths.findIndex(t => /时间|time/i.test(t)),
      symbol: ths.findIndex(t => /代币|币种|symbol/i.test(t)),
      side: ths.findIndex(t => /方向|side|买入|卖出/i.test(t)),
      filled: ths.findIndex(t => /已成交|executed|数量/i.test(t)),
      amount: ths.findIndex(t => /成交额|quote|金额/i.test(t)),
      status: ths.findIndex(t => /状态|status/i.test(t))
    };
  
    const arr = [];
    for (let trIndex = 0; trIndex < trows.length; trIndex++) {
      const tr = trows[trIndex];
      const tds = [...tr.querySelectorAll("td")];
      if (!tds.length || tds.length < ths.length) continue; // 跳过展开行
      const get = (i) => (i >= 0 ? tds[i].innerText.trim() : "");
      const timeStr = get(idx.time);            // 2025-08-14 21:40:37
      const datePart = (timeStr || "").slice(0, 10);
      const sideStr = get(idx.side);            // 买入/卖出 or BUY/SELL
      const statusStr = get(idx.status);        // 已成交/FILLED/…
      const filledStr = get(idx.filled);        // "24.9113 KOGE"
      const amountStr = get(idx.amount);        // "1,195.73679 USDT"
      const symbolStr = get(idx.symbol);        // "KOGE" or "KOGE/USDT"
  
      // 移除时间过滤 - 收集所有数据，稍后按日期分组
      // if (!isInDateRange(timeStr, state.targetDate)) continue;
  
      // 检查成交额不为0（不过滤已取消订单）
      const amountUSDT = parseNumber(amountStr);
      if (amountUSDT === 0) continue;
  
      // 处理方向列的文本或颜色样式
      const side = /买入|buy|绿色/i.test(sideStr) || tr.querySelector('td[style*="color"] span')?.textContent?.includes('买入') ? "BUY" : 
                   /卖出|sell|红色/i.test(sideStr) || tr.querySelector('td[style*="color"] span')?.textContent?.includes('卖出') ? "SELL" : "";
      
      console.log(`行数据: 时间=${timeStr}, 代币=${symbolStr}, 方向=${sideStr}->${side}, 已成交=${filledStr}, 成交额=${amountStr}`);
      if (!side) continue;
  
      const token = parseToken(symbolStr, filledStr);
      const filledQty = parseNumber(filledStr);
      // amountUSDT已经在前面计算过了
      
      console.log(`解析结果: token=${token}, qty=${filledQty}, amount=${amountUSDT}`);
  
      // 构造与 API 类似的对象，使用时间戳和行索引确保唯一性
      const currentTime = Date.now();
      const uniqueId = `dom-${currentTime}-${trIndex}-${arr.length}`;
      arr.push({
        orderId: uniqueId,
        updateTime: timeStr,
        symbol: token,
        side,
        status: "FILLED",
        executedQty: filledQty,
        cummulativeQuoteQty: amountUSDT,
        _uniqueId: uniqueId, // 添加唯一标识用于调试
        _originalData: { datePart, token, side, amountUSDT, filledQty } // 保留原始数据用于调试
      });
    }
    mergeOrders(arr, "dom");
  }
  
  function parseToken(symbolCell, filledCell) {
    // 优先从"代币"列抽取，例如 "KOGE" 或 "KOGE/USDT"
    let t = (symbolCell || "").replace(/\s+/g, "");
    if (t.includes("/")) t = t.split("/")[0];
    if (!t) {
      // 回退：从"已成交"列的 "24.91 KOGE" 提取
      const m = (filledCell || "").match(/[A-Z0-9\-_.]+$/i);
      if (m) t = m[0].toUpperCase();
    }
    return t || "UNKNOWN";
  }
  
  function parseNumber(s) {
    if (!s) return 0;
    const n = parseFloat(String(s).replace(/[^\d.\-]/g, ""));
    return isFinite(n) ? n : 0;
  }
  
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  
  async function gotoNextPage() {
    // 适配多种分页按钮：aria-label、文字、图标…
    const candidates = [
      'button[aria-label*="下一页"]',
      'li[title*="下一页"] button',
      'button[aria-label*="Next"]',
      'li.ant-pagination-next button',
      'button:has(svg[aria-label*="right"])'
    ];
    let btn = null;
    for (const sel of candidates) {
      btn = document.querySelector(sel);
      if (btn) break;
    }
    if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
    btn.click();
    return true;
  }
  
  async function waitForTableChange(timeout = 1500) {
    const tbody = document.querySelector("table tbody");
    if (!tbody) return sleep(timeout);
    const prev = tbody.innerText;
    let elapsed = 0;
    const step = 150;
    while (elapsed < timeout) {
      await sleep(step);
      elapsed += step;
      if (tbody.innerText !== prev) break;
    }
  }
  

  // 按日期聚合所有数据
  function aggregateAllDates() {
    const dateMap = new Map(); // 日期 -> 交易数据
    
    for (const o of state.rawOrders) {
      // 只使用DOM数据进行计算，忽略API数据以确保与页面显示一致
      if (o._src !== "dom") continue;
      
      const side = (o.side || "").toUpperCase();
      if (!(side === "BUY" || side === "SELL")) continue;
      
      // 代币名规整：去掉 /USDT 之类的报价货币
      let symbol = (o.symbol || "").trim();
      if (symbol.includes("/")) symbol = symbol.split("/")[0];
      symbol = symbol || "UNKNOWN";
      
      const qty = Number(o.executedQty || o.origQty || 0) || 0;
      const quote = Number(o.cummulativeQuoteQty || o.quoteQty || 0) || 0;
      
      // 只纳入已成交
      const st = (o.status || "").toUpperCase();
      if (st && !/FILLED/.test(st)) continue;
      
      // 确定交易属于哪个日期（按8:00划分）
      const t = o.updateTime || o.time || o.transactTime;
      if (!t) continue;
      
      const tradeDate = getTradeDate(t);
      if (!tradeDate) continue;
      
      // 初始化日期数据
      if (!dateMap.has(tradeDate)) {
        dateMap.set(tradeDate, []);
        console.log(`发现新交易日期: ${tradeDate}`);
      }
      
      dateMap.get(tradeDate).push({ symbol, side, qty, quote });
    }
    
    // 为每个日期计算聚合结果
    const results = new Map();
    for (const [date, rows] of dateMap) {
      console.log(`${date}: ${rows.length}笔交易`);
      results.set(date, calculateDayResult(rows, date));
    }
    
    state.multiDayData = results;
    return results;
  }
  
  // 根据时间确定交易日期（按自然日00:00-23:59统计）
  function getTradeDate(timeStr) {
    const time = new Date(timeStr);
    if (isNaN(time.getTime())) return null;
    
    // 转换为UTC+0时间，然后取日期部分
    // 输入的timeStr是UTC+8时间，需要减去8小时得到UTC+0
    const utcTime = new Date(time.getTime() - 8 * 60 * 60 * 1000);
    const utcDateStr = utcTime.toISOString().slice(0, 10);
    
    console.log(`时间转换: ${timeStr} (UTC+8) -> ${utcTime.toISOString()} (UTC+0) -> 交易日: ${utcDateStr}`);
    
    return utcDateStr;
  }
  
  // 计算单日结果
  function calculateDayResult(rows, date) {
    // 按代币聚合
    const map = new Map();
    for (const r of rows) {
      const it = map.get(r.symbol) || { token: r.symbol, buyQty: 0, buyQuote: 0, sellQty: 0, sellQuote: 0 };
      if (r.side === "BUY") { it.buyQty += r.qty; it.buyQuote += r.quote; }
      else { it.sellQty += r.qty; it.sellQuote += r.quote; }
      map.set(r.symbol, it);
    }
  
    // 计算磨损：同日撮合量 × (买均价 - 卖均价), 低于0按0计
    const out = [];
    for (const [, v] of map) {
      const avgBuy = v.buyQty > 0 ? v.buyQuote / v.buyQty : 0;
      const avgSell = v.sellQty > 0 ? v.sellQuote / v.sellQty : 0;
      const matched = Math.min(v.buyQty, v.sellQty);
      // 磨损 = 买入总额 - 卖出总额 + 买入手续费(0.01%)
      const buyFee = v.buyQuote * 0.0001; // 0.01% = 0.0001
      const wear = v.buyQuote === 0 ? 0 : v.buyQuote - v.sellQuote + buyFee;
  
      out.push({
        "代币": v.token,
        "今日买入总额": round(v.buyQuote, 8),
        "今日卖出总额": round(v.sellQuote, 8),
        "磨损": round(wear, 8)
      });
    }
  
    // 排序：按磨损倒序
    out.sort((a, b) => b["磨损"] - a["磨损"]);
    
    // 计算总交易额（仅计算买入金额）
    const totalVolume = [...map.values()].reduce((sum, v) => sum + v.buyQuote, 0);
    
    return {
      date,
      tokens: out,
      totalVolume: totalVolume,
      alphaScore: calculateAlphaScore(totalVolume)
    };
  }
  

  
  function round(n, p = 8) { return Number((n || 0).toFixed(p)); }
  
  // 导出统计汇总 CSV (所有日期)
  function downloadCSV() {
    const allSummaryData = [];
    const headers = ["日期", "代币", "买入总额", "卖出总额", "磨损"];
    
    // 收集所有日期的汇总数据
    for (const [date, result] of state.multiDayData) {
      for (const tokenData of result.tokens) {
        allSummaryData.push({
          日期: date,
          代币: tokenData["代币"],
          买入总额: tokenData["今日买入总额"],
          卖出总额: tokenData["今日卖出总额"],
          磨损: tokenData["磨损"]
        });
      }
    }
    
    if (allSummaryData.length === 0) {
      alert('没有数据可导出');
      return;
    }
    
    // 按日期和代币排序
    allSummaryData.sort((a, b) => {
      const dateCompare = b.日期.localeCompare(a.日期); // 日期倒序
      if (dateCompare !== 0) return dateCompare;
      return a.代币.localeCompare(b.代币); // 代币正序
    });
    
    const data = [headers, ...allSummaryData.map(r => headers.map(h => r[h]))];
    const csv = data.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `alpha_统计汇总_所有日期.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // 导出详细交易记录 CSV (所有日期)
  function downloadDetailCSV() {
    // 收集所有日期的原始交易记录
    const detailRecords = [];
    
    for (const o of state.rawOrders) {
      // 只导出DOM数据，确保与页面显示一致
      if (o._src !== "dom") continue;
      
      const t = o.updateTime || o.time || o.transactTime;
      if (!t) continue;
      
      const tradeDate = getTradeDate(t);
      if (!tradeDate) continue;
      
      // 只包含已成交的订单
      const st = (o.status || "").toUpperCase();
      if (st && !/FILLED/.test(st)) continue;
      
      const side = (o.side || "").toUpperCase();
      if (!(side === "BUY" || side === "SELL")) continue;
      
      // 代币名规整
      let symbol = (o.symbol || "").trim();
      if (symbol.includes("/")) symbol = symbol.split("/")[0];
      symbol = symbol || "UNKNOWN";
      
      // 解析时间格式
      const timeObj = new Date(t);
      const formattedTime = timeObj.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      
      const quoteAmount = parseFloat(o.cummulativeQuoteQty || 0);
      const avgPrice = parseFloat(o.cummulativeQuoteQty || 0) / parseFloat(o.executedQty || 1);
      const qty = parseFloat(o.executedQty || 0);
      
      detailRecords.push({
        时间: formattedTime,
        代币: symbol,
        方向: side === 'BUY' ? '买入' : '卖出',
        平均价格: avgPrice.toFixed(8),
        价格: avgPrice.toFixed(8),
        已成交: qty.toFixed(8) + ' ' + symbol,
        数量: qty.toFixed(8) + ' ' + symbol,
        成交额: side === 'BUY' ? (-quoteAmount).toFixed(8) : quoteAmount.toFixed(8), // 买入为负数（资金流出）
        状态: '已成交'
      });
    }
    
    if (detailRecords.length === 0) {
      alert('当前日期没有交易记录可导出');
      return;
    }
    
    // 按时间倒序排序
    detailRecords.sort((a, b) => new Date(b.时间) - new Date(a.时间));
    
    const headers = ["时间", "代币", "方向", "平均价格", "价格", "已成交", "数量", "成交额", "状态"];
    const data = [headers, ...detailRecords.map(r => headers.map(h => r[h]))];
    const csv = data.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `alpha_详细交易记录_所有日期.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // 计算总览数据（汇总所有日期）
  function calculateOverviewData(allDatesData) {
    const overviewMap = new Map(); // 代币 -> 汇总数据
    let totalVolume = 0;
    
    // 汇总所有日期的数据
    for (const [date, dayResult] of allDatesData) {
      totalVolume += dayResult.totalVolume;
      
      for (const tokenData of dayResult.tokens) {
        const token = tokenData["代币"];
        const existing = overviewMap.get(token) || {
          token: token,
          buyQuote: 0,
          sellQuote: 0
        };
        
        existing.buyQuote += tokenData["今日买入总额"];
        existing.sellQuote += tokenData["今日卖出总额"];
        overviewMap.set(token, existing);
      }
    }
    
    // 转换为显示格式
    const tokens = [];
    for (const [, v] of overviewMap) {
      // 总览页面：盈利 = 卖出总额 - 买入总额 - 买入手续费(0.01%)
      const buyFee = v.buyQuote * 0.0001; // 0.01% = 0.0001
      const profit = v.buyQuote === 0 ? 0 : v.sellQuote - v.buyQuote - buyFee;
      tokens.push({
        "代币": v.token,
        "今日买入总额": round(v.buyQuote, 8),
        "今日卖出总额": round(v.sellQuote, 8),
        "盈利": round(profit, 8)
      });
    }
    
    // 按盈利倒序排列
    tokens.sort((a, b) => b["盈利"] - a["盈利"]);
    
    return {
      date: 'overview',
      tokens,
      totalVolume,
      alphaScore: calculateAlphaScore(totalVolume)
    };
  }

  // 渲染多日结果表格
  function renderMultiDayResults(allDatesData) {
    // 先清除旧表
    document.querySelector("#bia-result")?.remove();
    
    // 获取日期列表，按日期倒序排列
    const dates = Array.from(allDatesData.keys()).sort((a, b) => b.localeCompare(a));
    if (dates.length === 0) {
      alert('未找到任何交易数据');
      return;
    }
    
    // 默认显示总览
    state.currentViewDate = 'overview';
    
    renderMultiDayTable(allDatesData, dates);
  }
  
  // 渲染多日表格界面
  function renderMultiDayTable(allDatesData, dates) {
    // 先清除旧表
    document.querySelector("#bia-result")?.remove();
    
    // 如果是总览模式，计算汇总数据
    let result;
    if (state.currentViewDate === 'overview') {
      result = calculateOverviewData(allDatesData);
    } else {
      result = allDatesData.get(state.currentViewDate);
      if (!result) return;
    }
  
    const box = document.createElement("div");
    box.id = "bia-result";
    box.style.cssText = `
      position: fixed; right: 16px; bottom: 72px; z-index: 999999;
      max-height: 80vh; overflow: auto; background: #0d1117; color: #c9d1d9;
      border: 1px solid #30363d; border-radius: 12px; padding: 12px;
      min-width: 700px; box-shadow: 0 8px 24px rgba(0,0,0,.4);
    `;
  
    const { tokens, totalVolume, alphaScore } = result;
    
    // 计算时间范围显示
    let timeRangeStr;
    if (state.currentViewDate === 'overview') {
      const firstDate = dates[dates.length - 1]; // 最早日期
      const lastDate = dates[0]; // 最晚日期
      timeRangeStr = `${firstDate} 到 ${lastDate} 总览`;
    } else {
      const targetDate = new Date(state.currentViewDate + 'T08:00:00');
      const nextDay = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
      timeRangeStr = `${targetDate.toLocaleDateString()} 08:00 - ${nextDay.toLocaleDateString()} 08:00`;
    }
    
    // Alpha积分信息
    const scoreInfo = alphaScore.score > 0 ? 
      `当前档位: $${alphaScore.currentTier.volume.toLocaleString()} (${alphaScore.score}分)` : 
      '当前档位: 未达标 (0分)';
    
    const nextTierInfo = alphaScore.nextTier ? 
      `下一档位: $${alphaScore.nextTier.volume.toLocaleString()} (${alphaScore.nextTier.score}分) | 差距: $${alphaScore.gap.toFixed(2)}` :
      '已达最高档位';

    // 创建日期标签页
    const tabsContainer = document.createElement("div");
    tabsContainer.style.cssText = "display: flex; gap: 4px; margin-bottom: 12px; flex-wrap: wrap;";
    
    // 先添加各日期标签
    dates.forEach(date => {
      const tab = document.createElement("button");
      const dayResult = allDatesData.get(date);
      const isActive = date === state.currentViewDate;
      
      tab.style.cssText = `
        padding: 4px 8px; border: 1px solid #444; border-radius: 6px; cursor: pointer; font-size: 11px;
        background: ${isActive ? '#238636' : '#21262d'}; color: #fff;
        ${isActive ? 'font-weight: 600;' : ''}
      `;
      
      const dateObj = new Date(date);
      const displayDate = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
      const dayVolume = dayResult.totalVolume.toFixed(0);
      
      tab.innerHTML = `${displayDate}<br><span style="font-size:9px;">$${dayVolume}</span>`;
      
      tab.onclick = () => {
        state.currentViewDate = date;
        renderMultiDayTable(allDatesData, dates);
      };
      
      tabsContainer.appendChild(tab);
    });
    
    // 最后添加总览标签
    const overviewTab = document.createElement("button");
    const isOverviewActive = state.currentViewDate === 'overview';
    overviewTab.style.cssText = `
      padding: 4px 8px; border: 1px solid #444; border-radius: 6px; cursor: pointer; font-size: 11px;
      background: ${isOverviewActive ? '#238636' : '#21262d'}; color: #fff;
      ${isOverviewActive ? 'font-weight: 600;' : ''}
    `;
    overviewTab.innerHTML = `总览<br><span style="font-size:9px;">$${result.totalVolume.toFixed(0)}</span>`;
    overviewTab.onclick = () => {
      state.currentViewDate = 'overview';
      renderMultiDayTable(allDatesData, dates);
    };
    tabsContainer.appendChild(overviewTab);
    
    box.appendChild(tabsContainer);
  
    const title = document.createElement("div");
    const displayTitle = state.currentViewDate === 'overview' ? '交易统计结果 - 总览' : `交易统计结果 - ${state.currentViewDate}`;
    
    // 计算总盈利或总磨损
    let totalSummary;
    if (state.currentViewDate === 'overview') {
      const totalProfit = tokens.reduce((sum, r) => sum + r['盈利'], 0);
      const profitColor = totalProfit >= 0 ? '#f85149' : '#3fb950';
      totalSummary = `<span style="color:${profitColor}">总盈利: ${totalProfit.toFixed(4)} USDT</span>`;
    } else {
      const totalWear = tokens.reduce((sum, r) => sum + r['磨损'], 0);
      totalSummary = `总磨损: ${totalWear.toFixed(4)} USDT`;
    }
    
    title.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px;">${displayTitle}</div>
      <div style="font-size:11px;color:#8b949e;margin-bottom:4px;">时间范围: ${timeRangeStr}</div>
      <div style="font-size:11px;color:#8b949e;margin-bottom:4px;">代币数量: ${tokens.length} | ${totalSummary}</div>
      <div style="font-size:12px;color:#f79000;margin-bottom:4px;font-weight:600;">📊 总买入金额: $${totalVolume.toFixed(2)} USDT</div>
      <div style="font-size:12px;color:#3fb950;margin-bottom:4px;">🏆 ${scoreInfo}</div>
      <div style="font-size:11px;color:#8b949e;margin-bottom:4px;">${nextTierInfo}</div>
      <div style="font-size:10px;color:#f85149;margin-bottom:8px;">⚠️ BSC活动倍数自行计算</div>
    `;
    box.appendChild(title);
  
    const table = document.createElement("table");
    table.style.cssText = "width:100%; border-collapse: collapse; font-size:12px;";
    const headers = state.currentViewDate === 'overview' ? 
      ["代币","买入总额","卖出总额","盈利"] : 
      ["代币","买入总额","卖出总额","磨损"];
  
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    headers.forEach(h => {
      const th = document.createElement("th");
      th.textContent = h;
      th.style.cssText = "text-align:left; padding:6px 8px; border-bottom:1px solid #30363d; position:sticky; top:0; background:#0d1117; font-weight:600;";
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);
  
    const tbody = document.createElement("tbody");
    tokens.forEach(r => {
      const tr = document.createElement("tr");
      tr.style.cssText = "border-bottom:1px dashed #21262d;";
      
      headers.forEach(h => {
        const td = document.createElement("td");
        let value;
        
        // 根据是否总览模式选择不同的字段
        if (state.currentViewDate === 'overview') {
          value = r[h === "买入总额" ? "今日买入总额" : h === "卖出总额" ? "今日卖出总额" : h === "盈利" ? "盈利" : h];
        } else {
          value = r[h === "买入总额" ? "今日买入总额" : h === "卖出总额" ? "今日卖出总额" : h === "磨损" ? "磨损" : h];
        }
        
        td.textContent = (h === "代币") ? value : String(value);
        td.style.cssText = "padding:6px 8px;";
        
        // 为盈利/磨损列添加颜色
        if (h === "盈利" || h === "磨损") {
          const numValue = parseFloat(value);
          if (state.currentViewDate === 'overview') {
            // 总览模式：盈利用红色正数，亏损用绿色负数
            if (numValue > 0) {
              td.style.color = "#f85149"; // 红色表示盈利
            } else if (numValue < 0) {
              td.style.color = "#3fb950"; // 绿色表示亏损
            }
          } else {
            // 单日模式：磨损用红色
            if (numValue > 0) {
              td.style.color = "#f85149"; // 红色表示损失
            } else if (numValue < 0) {
              td.style.color = "#3fb950"; // 绿色表示盈利
            }
          }
        }
        
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
  
    // 按钮容器
    const buttonContainer = document.createElement("div");
    buttonContainer.style.cssText = "margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;";
    
    // 导出统计汇总CSV按钮
    const exportSummaryBtn = document.createElement("button");
    exportSummaryBtn.textContent = "导出统计汇总";
    exportSummaryBtn.style.cssText = "padding:6px 12px; border:1px solid #444; background:#238636; color:#fff; border-radius:8px; cursor:pointer; font-size:12px;";
    exportSummaryBtn.onclick = () => downloadCSV();
    buttonContainer.appendChild(exportSummaryBtn);
    
    // 导出详细记录CSV按钮
    const exportDetailBtn = document.createElement("button");
    exportDetailBtn.textContent = "导出详细记录";
    exportDetailBtn.style.cssText = "padding:6px 12px; border:1px solid #444; background:#0969da; color:#fff; border-radius:8px; cursor:pointer; font-size:12px;";
    exportDetailBtn.onclick = () => downloadDetailCSV();
    buttonContainer.appendChild(exportDetailBtn);
    
    // 重新抓取按钮
    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "重新抓取";
    refreshBtn.style.cssText = "padding:6px 12px; border:1px solid #444; background:#f79000; color:#fff; border-radius:8px; cursor:pointer; font-size:12px;";
    refreshBtn.onclick = async () => {
      // 清空旧数据
      state.rawOrders = [];
      state.collectedPages.clear();
      state.multiDayData.clear();
      state.currentViewDate = null;
      console.log('开始重新抓取数据...');
      box.remove();
      // 重新运行收集流程
      await runCollection();
    };
    buttonContainer.appendChild(refreshBtn);
    
    // 关闭按钮
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "关闭";
    closeBtn.style.cssText = "padding:6px 12px; border:1px solid #444; background:#21262d; color:#fff; border-radius:8px; cursor:pointer; font-size:12px;";
    closeBtn.onclick = () => {
      // 清空收集的数据
      state.rawOrders = [];
      state.collectedPages.clear();
      state.multiDayData.clear();
      state.currentViewDate = null;
      console.log('已清空所有收集的数据');
      box.remove();
    };
    buttonContainer.appendChild(closeBtn);
    
    box.appendChild(buttonContainer);
  
    document.body.appendChild(box);
  }

  // 向后兼容的单日结果展示函数
  function renderResultTable(result) {
    renderMultiDayResults(new Map([[result.date || state.targetDate, result]]));
  }