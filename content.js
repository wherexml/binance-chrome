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
        
        console.log(`已设置日期选择器为今天: ${today}`);
      }
    });
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
  
  // 合并API记录（只对有真实orderId的API数据去重）
  function mergeOrders(arr, src = "api") {
    if (src !== "api") {
      console.log(`错误：mergeOrders只应用于API数据，收到src=${src}`);
      return;
    }
    
    const key = (o) => `${o.orderId || o.id || ""}_${o.updateTime || o.time || o.transactTime || ""}`;
    const map = new Map(state.rawOrders.filter(o => o._src === "api").map(o => [key(o), o]));
    const nonApiOrders = state.rawOrders.filter(o => o._src !== "api");
    
    console.log(`API数据合并前：已有${map.size}条API记录，${nonApiOrders.length}条非API记录，新增${arr.length}条API记录`);
    
    let addedCount = 0;
    let duplicateCount = 0;
    
    for (const o of arr) {
      const orderKey = key(o);
      if (map.has(orderKey)) {
        console.log(`发现重复API记录: ${o.symbol} ${o.side} ${o.updateTime}`);
        duplicateCount++;
      } else {
        addedCount++;
      }
      map.set(orderKey, { ...o, _src: src });
    }
    
    // 重新组合所有数据：去重后的API数据 + 非API数据
    state.rawOrders = [...nonApiOrders, ...map.values()];
    console.log(`API数据合并后：总计${state.rawOrders.length}条记录，API新增${addedCount}条，重复${duplicateCount}条`);
  }
  

  // 主流程：自动翻页抓取 + DOM 回退解析 + 统计
  async function runCollection() {
    if (state.collecting) return;
    state.collecting = true;
    state.rawOrders = [];
    state.collectedPages.clear();
  
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
    console.log(`开始解析表格，共${trows.length}行，表头${ths.length}列`);
    console.log(`列索引映射:`, idx);
    console.log(`表头内容:`, ths);
    for (let i = 0; i < trows.length; i++) {
      const tr = trows[i];
      const tds = [...tr.querySelectorAll("td")];
      if (!tds.length) {
        console.log(`第${i+1}行：跳过空行，td数量=0`);
        continue; // 跳过空行
      }
      if (tds.length < ths.length) {
        console.log(`第${i+1}行：跳过不完整行，td数量=${tds.length} < 表头数量${ths.length}`);
        continue; // 跳过展开行或不完整行  
      }
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
      if (amountUSDT === 0) {
        console.log(`WARNING: 跳过0成交额订单: 时间=${timeStr}, 代币=${symbolStr}, 原始成交额='${amountStr}', 解析结果=${amountUSDT}`);
        continue;
      }
  
      // 处理方向列的文本或颜色样式
      let side = "";
      if (/买入|buy/i.test(sideStr)) {
        side = "BUY";
      } else if (/卖出|sell/i.test(sideStr)) {
        side = "SELL";  
      } else {
        // 尝试通过颜色或样式判断
        const sideCell = tds[idx.side];
        const hasGreen = sideCell && (sideCell.innerHTML.includes('#00C851') || sideCell.innerHTML.includes('green'));
        const hasRed = sideCell && (sideCell.innerHTML.includes('#FF4444') || sideCell.innerHTML.includes('red'));
        if (hasGreen) side = "BUY";
        else if (hasRed) side = "SELL";
      }
      
      console.log(`第${i+1}行数据: 时间=${timeStr}, 代币=${symbolStr}, 方向=${sideStr}->${side}, 已成交=${filledStr}, 成交额=${amountStr}`);
      if (!side) {
        console.log(`WARNING: 无法识别交易方向，sideStr='${sideStr}', 行HTML:`, tr.outerHTML);
        continue;
      }
  
      const token = parseToken(symbolStr, filledStr);
      const filledQty = parseNumber(filledStr);
      // amountUSDT已经在前面计算过了
      
      console.log(`解析结果: token=${token}, qty=${filledQty}, amount=${amountUSDT}`);
  
      // 构造与 API 类似的对象，使用行索引确保唯一性
      arr.push({
        orderId: `DOM-${i+1}-${datePart}-${token}-${side}-${amountUSDT}-${filledQty}-${timeStr}`,
        updateTime: timeStr,
        symbol: token,
        side,
        status: "FILLED",
        executedQty: filledQty,
        cummulativeQuoteQty: amountUSDT
      });
    }
    // 直接添加DOM数据，不进行去重（因为没有可靠的唯一ID）
    console.log(`DOM解析：新增${arr.length}条记录，直接加入数据集`);
    for (const o of arr) {
      state.rawOrders.push({ ...o, _src: "dom" });
    }
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
    // 保留负号、数字、小数点，但要正确处理负号位置
    const cleaned = String(s).replace(/[^\d.\-]/g, "");
    // 确保负号只在开头
    const hasNegative = s.includes('-');
    const numbersOnly = cleaned.replace(/-/g, "");
    const finalStr = hasNegative ? '-' + numbersOnly : numbersOnly;
    const n = parseFloat(finalStr);
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
    
    console.log(`开始聚合数据，总共有 ${state.rawOrders.length} 条原始记录`);
    
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
      
      // 确定交易属于哪个日期（按UTC+0自然日划分）
      const t = o.updateTime || o.time || o.transactTime;
      if (!t) {
        console.log(`跳过无时间记录:`, o);
        continue;
      }
      
      const tradeDate = getTradeDate(t);
      if (!tradeDate) {
        console.log(`无法解析时间: ${t}`, o);
        continue;
      }
      
      // 初始化日期数据
      if (!dateMap.has(tradeDate)) {
        dateMap.set(tradeDate, []);
        console.log(`发现新交易日期: ${tradeDate}`);
      }
      
      console.log(`交易记录: 时间=${t}, 解析日期=${tradeDate}, 代币=${symbol}, 方向=${side}, 金额=${quote}`);
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
  
  // 根据时间确定交易日期（按本地时间 08:00 - 次日 08:00 统计）
  function getTradeDate(timeStr) {
    if (!timeStr) return null;
    
    // 解析时间字符串，格式通常为 "YYYY-MM-DD HH:mm:ss"
    // 币安页面显示为本地时间（通常为 UTC+8）。
    const timeMatch = timeStr.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (timeMatch) {
      const [, year, month, day, hh, mm, ss] = timeMatch;
      const dt = new Date(`${year}-${month}-${day}T${hh}:${mm}:${ss}`);
      if (!isNaN(dt.getTime())) {
        // 统计日从 08:00 开始：若时间在 00:00-07:59，则归入前一天
        if (dt.getHours() < 8) dt.setDate(dt.getDate() - 1);
        const dateStr = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
        console.log(`时间转换(8点边界): ${timeStr} -> 交易日期: ${dateStr}`);
        return dateStr;
      }
    }
    
    // 回退逻辑：从时间字符串中提取日期部分
    if (timeStr.includes(' ')) {
      const datePart = timeStr.split(' ')[0];
      if (datePart.match(/\d{4}-\d{2}-\d{2}/)) {
        // 搭配具体时间再做 8 点边界修正
        const tentative = new Date(timeStr);
        if (!isNaN(tentative.getTime())) {
          if (tentative.getHours() < 8) tentative.setDate(tentative.getDate() - 1);
          const dateStr = tentative.getFullYear() + '-' + String(tentative.getMonth() + 1).padStart(2, '0') + '-' + String(tentative.getDate()).padStart(2, '0');
          console.log(`时间转换(回退+8点边界): ${timeStr} -> 交易日期: ${dateStr}`);
          return dateStr;
        }
        console.log(`时间转换(回退-未修正): ${timeStr} -> 交易日期: ${datePart}`);
        return datePart;
      }
    }
    
    // 最后的回退：使用 Date 对象并按本地时区处理，同时应用 8 点边界
    const time = new Date(timeStr);
    if (isNaN(time.getTime())) return null;
    
    if (time.getHours() < 8) time.setDate(time.getDate() - 1);
    const localDateStr = time.getFullYear() + '-' + 
                         String(time.getMonth() + 1).padStart(2, '0') + '-' + 
                         String(time.getDate()).padStart(2, '0');
    console.log(`时间转换(最终回退+8点边界): ${timeStr} -> 本地日期: ${localDateStr}`);
    
    return localDateStr;
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
  
    // 计算磨损：对于同一代币的买卖，计算实际磨损成本
    const out = [];
    for (const [, v] of map) {
      const avgBuy = v.buyQty > 0 ? v.buyQuote / v.buyQty : 0;
      const avgSell = v.sellQty > 0 ? v.sellQuote / v.sellQty : 0;
      const matched = Math.min(v.buyQty, v.sellQty);
      
      // 磨损计算方法：
      // 方法1：简单差值法（当前使用）- 买入总额 - 卖出总额 + 手续费
      // 方法2：撮合量计算法 - 撮合量 × (买均价 - 卖均价) + 手续费
      
      let wear;
      if (matched > 0 && avgBuy > 0 && avgSell > 0) {
        // 有撮合量的情况下，使用撮合量计算法
        const priceDiff = avgBuy - avgSell;
        const tradingWear = matched * priceDiff;
        const buyFee = v.buyQuote * 0.0001; // 买入手续费 0.01%
        const sellFee = v.sellQuote * 0.0001; // 卖出手续费 0.01%
        wear = tradingWear + buyFee + sellFee;
        
        console.log(`${v.token} 磨损详情: 撮合量=${matched.toFixed(4)}, 买均价=${avgBuy.toFixed(6)}, 卖均价=${avgSell.toFixed(6)}, 价差磨损=${tradingWear.toFixed(4)}, 手续费=${(buyFee + sellFee).toFixed(4)}, 总磨损=${wear.toFixed(4)}`);
      } else {
        // 只有买入或只有卖出的情况
        const buyFee = v.buyQuote * 0.0001;
        wear = v.buyQuote === 0 ? 0 : v.buyQuote - v.sellQuote + buyFee;
        
        console.log(`${v.token} 磨损详情(单边): 买入=${v.buyQuote.toFixed(4)}, 卖出=${v.sellQuote.toFixed(4)}, 手续费=${buyFee.toFixed(4)}, 总磨损=${wear.toFixed(4)}`);
      }
  
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
          sellQuote: 0,
          totalWear: 0  // 总磨损（已包含手续费）
        };
        
        existing.buyQuote += tokenData["今日买入总额"];
        existing.sellQuote += tokenData["今日卖出总额"];
        existing.totalWear += tokenData["磨损"]; // 直接累加每天计算好的磨损
        overviewMap.set(token, existing);
      }
    }
    
    // 转换为显示格式
    const tokens = [];
    for (const [, v] of overviewMap) {
      // 总览页面：直接使用累加的磨损作为盈利（磨损为负表示盈利）
      const profit = -v.totalWear; // 磨损为正数表示亏损，所以盈利是负磨损
      
      console.log(`${v.token} 总览数据汇总: 买入=${v.buyQuote.toFixed(4)}, 卖出=${v.sellQuote.toFixed(4)}, 总磨损=${v.totalWear.toFixed(4)}, 盈利=${profit.toFixed(4)}`);
      
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
      // 显示实际的统计时间范围：当日8:00到次日8:00
      const dateStr = state.currentViewDate; // 格式为 "2025-09-11"
      const startDate = new Date(dateStr + 'T08:00:00');
      const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000 - 1000); // 次日07:59:59
      
      const startStr = startDate.toLocaleString('zh-CN', {hour12: false});
      const endStr = endDate.toLocaleString('zh-CN', {hour12: false});
      
      timeRangeStr = `${startStr} - ${endStr}`;
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