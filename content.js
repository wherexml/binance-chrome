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
    collecting: false
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

  // 选项：默认排除含 ALPHA 的条目
const opts = { excludeAlpha: true };

// 是否排除（支持界面切换）
function shouldExcludeToken(token) {
  if (!token) return false;
  return (document.getElementById("bia-exclude-alpha")?.checked ?? opts.excludeAlpha)
         && /(^|[^A-Z])ALPHA([^A-Z]|$)/i.test(token);
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
  
  // 合并记录（去重按 orderId + updateTime）
  function mergeOrders(arr, src = "api") {
    const key = (o) => `${o.orderId || o.id || ""}_${o.updateTime || o.time || o.transactTime || ""}`;
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
  
    // 聚合并展示
    const result = aggregateByToken();
    console.table(result.tokens);
    console.log('总买入金额:', result.totalVolume.toFixed(2), 'USDT');
    console.log('Alpha积分:', result.alphaScore);
    
    // 显示结果表格
    renderResultTable(result);
    
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
      side: ths.findIndex(t => /方向|side/i.test(t)),
      filled: ths.findIndex(t => /已成交|executed/i.test(t)),
      amount: ths.findIndex(t => /成交额|quote|金额|filled\s*quote/i.test(t)),
      status: ths.findIndex(t => /状态|status/i.test(t))
    };
  
    const arr = [];
    for (const tr of trows) {
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
  
      // 只纳入目标日期范围内的数据（8:00-次日8:00）
      if (!isInDateRange(timeStr, state.targetDate)) continue;
  
      // 只纳入已成交
      if (!/(已成交|filled)/i.test(statusStr)) continue;
  
      const side = /买入|buy/i.test(sideStr) ? "BUY" : /卖出|sell/i.test(sideStr) ? "SELL" : "";
      if (!side) continue;
  
      const token = parseToken(symbolStr, filledStr);
      const filledQty = parseNumber(filledStr);
      const amountUSDT = parseNumber(amountStr); // 以 USDT 计价
  
      // 构造与 API 类似的对象
      arr.push({
        orderId: `${datePart}-${token}-${side}-${amountUSDT}-${filledQty}`,
        updateTime: timeStr,
        symbol: token,
        side,
        status: "FILLED",
        executedQty: filledQty,
        cummulativeQuoteQty: amountUSDT
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
  

  function aggregateByToken() {
    // 规整为通用行
    const rows = [];
    for (const o of state.rawOrders) {
      const side = (o.side || "").toUpperCase();
      if (!(side === "BUY" || side === "SELL")) continue;
  
      // 时间过滤 - 使用时间范围检查
      const t = o.updateTime || o.time || o.transactTime;
      if (t && !isInDateRange(t, state.targetDate)) continue;
  
      // 代币名规整：去掉 /USDT 之类的报价货币
      let symbol = (o.symbol || "").trim();
      if (symbol.includes("/")) symbol = symbol.split("/")[0];
      symbol = symbol || "UNKNOWN";
      if (shouldExcludeToken(symbol)) continue; // 排除 ALPHA*
  
      const qty = Number(o.executedQty || o.origQty || 0) || 0;
      const quote = Number(o.cummulativeQuoteQty || o.quoteQty || 0) || 0;
  
      // 只纳入已成交
      const st = (o.status || "").toUpperCase();
      if (st && !/FILLED/.test(st)) continue;
  
      rows.push({ symbol, side, qty, quote });
    }
  
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
      const wear = Math.max(0, (avgBuy - avgSell) * matched);
  
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
      tokens: out,
      totalVolume: totalVolume,
      alphaScore: calculateAlphaScore(totalVolume)
    };
  }
  

  
  function round(n, p = 8) { return Number((n || 0).toFixed(p)); }
  
  // 导出 CSV
  function downloadCSV(rows) {
    const headers = ["代币","今日买入总额","今日卖出总额","磨损"];
    const data = [headers, ...rows.map(r => headers.map(h => r[h]))];
    const csv = data.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `alpha_统计_${state.targetDate}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function renderResultTable(result) {
    // 先清除旧表
    document.querySelector("#bia-result")?.remove();
  
    const box = document.createElement("div");
    box.id = "bia-result";
    box.style.cssText = `
      position: fixed; right: 16px; bottom: 72px; z-index: 999999;
      max-height: 75vh; overflow: auto; background: #0d1117; color: #c9d1d9;
      border: 1px solid #30363d; border-radius: 12px; padding: 12px;
      min-width: 650px; box-shadow: 0 8px 24px rgba(0,0,0,.4);
    `;
  
    const { tokens, totalVolume, alphaScore } = result;
    
    // 计算时间范围显示
    const targetDate = new Date(state.targetDate + 'T08:00:00');
    const nextDay = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
    const timeRangeStr = `${targetDate.toLocaleDateString()} 08:00 - ${nextDay.toLocaleDateString()} 08:00`;
    
    // Alpha积分信息
    const scoreInfo = alphaScore.score > 0 ? 
      `当前档位: $${alphaScore.currentTier.volume.toLocaleString()} (${alphaScore.score}分)` : 
      '当前档位: 未达标 (0分)';
    
    const nextTierInfo = alphaScore.nextTier ? 
      `下一档位: $${alphaScore.nextTier.volume.toLocaleString()} (${alphaScore.nextTier.score}分) | 差距: $${alphaScore.gap.toFixed(2)}` :
      '已达最高档位';
  
    const title = document.createElement("div");
    title.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px;">交易统计结果</div>
      <div style="font-size:11px;color:#8b949e;margin-bottom:4px;">时间范围: ${timeRangeStr}</div>
      <div style="font-size:11px;color:#8b949e;margin-bottom:4px;">代币数量: ${tokens.length} | 总磨损: ${tokens.reduce((sum, r) => sum + r['磨损'], 0).toFixed(4)} USDT</div>
      <div style="font-size:12px;color:#f79000;margin-bottom:4px;font-weight:600;">📊 总买入金额: $${totalVolume.toFixed(2)} USDT</div>
      <div style="font-size:12px;color:#3fb950;margin-bottom:4px;">🏆 ${scoreInfo}</div>
      <div style="font-size:11px;color:#8b949e;margin-bottom:4px;">${nextTierInfo}</div>
      <div style="font-size:10px;color:#f85149;margin-bottom:8px;">⚠️ BSC活动倍数自行计算</div>
    `;
    box.appendChild(title);
  
    const table = document.createElement("table");
    table.style.cssText = "width:100%; border-collapse: collapse; font-size:12px;";
    const headers = ["代币","买入总额","卖出总额","磨损"];
  
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
        const value = r[h === "买入总额" ? "今日买入总额" : h === "卖出总额" ? "今日卖出总额" : h];
        td.textContent = (h === "代币") ? value : String(value);
        td.style.cssText = "padding:6px 8px;";
        
        // 磨损列添加颜色
        if (h === "磨损") {
          const wearValue = parseFloat(value);
          if (wearValue > 0) {
            td.style.color = "#f85149"; // 红色表示损失
          } else if (wearValue < 0) {
            td.style.color = "#3fb950"; // 绿色表示盈利
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
    buttonContainer.style.cssText = "margin-top:12px; display:flex; gap:8px;";
    
    // 导出CSV按钮
    const exportBtn = document.createElement("button");
    exportBtn.textContent = "导出CSV";
    exportBtn.style.cssText = "padding:6px 12px; border:1px solid #444; background:#238636; color:#fff; border-radius:8px; cursor:pointer; font-size:12px;";
    exportBtn.onclick = () => downloadCSV(tokens);
    buttonContainer.appendChild(exportBtn);
    
    // 关闭按钮
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "关闭";
    closeBtn.style.cssText = "padding:6px 12px; border:1px solid #444; background:#21262d; color:#fff; border-radius:8px; cursor:pointer; font-size:12px;";
    closeBtn.onclick = () => box.remove();
    buttonContainer.appendChild(closeBtn);
    
    box.appendChild(buttonContainer);
  
    document.body.appendChild(box);
  }