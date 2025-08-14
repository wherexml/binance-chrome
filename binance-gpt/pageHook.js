// 轻量拦截器：把与订单历史相关的 JSON 回包发给 content script
(function () {
    const post = (payload) => {
      try {
        window.postMessage({ source: "BIA", type: "api", payload }, "*");
      } catch {}
    };
  
    // 识别是否疑似 Alpha 订单历史接口（尽量宽松一些）
    const looksLikeAlphaOrders = (url) => {
      if (!url) return false;
      url = String(url);
      return /alpha/i.test(url) && /order/i.test(url) && /(history|list|query)/i.test(url);
    };
  
    // fetch
    const _fetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await _fetch(...args);
      try {
        const url = args?.[0]?.url || String(args?.[0] || "");
        if (looksLikeAlphaOrders(url)) {
          const clone = res.clone();
          const data = await clone.json().catch(() => null);
          if (data) post({ url, data });
        }
      } catch {}
      return res;
    };
  
    // XHR
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._bia_url = url;
      return _open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          if (looksLikeAlphaOrders(this._bia_url)) {
            const ct = this.getResponseHeader("content-type") || "";
            if (ct.includes("application/json")) {
              const data = JSON.parse(this.responseText);
              post({ url: this._bia_url, data });
            }
          }
        } catch {}
      });
      return _send.apply(this, args);
    };
  })();