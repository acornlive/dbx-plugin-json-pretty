/* ============================================================
   core.js - 通用工具（命名空间 window.JP）
   - 通知 / 复制 / HTML 转义
   - 文本宽度测量（canvas，避免逐行读 DOM 触发同步布局）
   - 光标逻辑位置映射（不用正则，避免大文本逐字符正则开销）
   ============================================================ */
(function () {
  'use strict';
  var JP = window.JP = window.JP || {};

  JP.dbx = (typeof window !== 'undefined' && window.dbxPlugin) ? window.dbxPlugin : null;

  JP.$ = function (id) { return document.getElementById(id); };

  JP.t = function (key) {
    if (typeof window.t === 'function') return window.t.apply(null, arguments);
    return key;
  };

  JP.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };

  // 默认文件名格式：yyyymmddss.json（年4 + 月2 + 日2 + 秒2）
  // 导出、工作区自动保存、右键新建文件三处共用同一个生成器，避免各写一份跑偏。
  JP.defaultFileName = function () {
    var d = new Date();
    var p = function (v) { return ('0' + v).slice(-2); };
    return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getSeconds()) + '.json';
  };

  JP.fmtNum = function (n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  JP.escapeHtml = function (s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  /* ---------- 搜索匹配器（key 与 value 共用的一份实现） ----------
     app.js 用它判断「整棵数据里哪些行命中」，view.js 用它给可见行的文本上色，
     两边必须同源，否则会出现「计数说命中了但没高亮」。
     make(term, regex, ci) -> { test(s), mark(s) } | null（term 为空或正则非法） */
  JP.makeMatcher = function (term, regex, ci) {
    if (!term) return null;

    var m = { re: null, src: '', ci: !!ci };
    if (regex) {
      try { m.re = new RegExp(term, ci ? 'gi' : 'g'); }
      catch (e) { return null; }          // 正则还没写完/写错
      m.src = term;
    } else {
      m.src = ci ? term.toLowerCase() : term;
    }

    // 该文本是否命中
    m.test = function (s) {
      if (s === null || s === undefined) return false;
      s = String(s);
      if (m.re) { m.re.lastIndex = 0; return m.re.test(s); }
      return ci ? s.toLowerCase().indexOf(m.src) >= 0 : s.indexOf(m.src) >= 0;
    };

    /* 这段文本里有几个命中。搜索框显示的是「第几个 / 共几个」，↑↓ 就在这些命中之间跳，
       所以计数必须与 mark() 包出来的块数一一对得上 —— 否则会出现「数 3 个、只染 1 块」
       或者「数 1 个、块却有 3 个」这种对不上的情况。 */
    m.count = function (s) {
      if (s === null || s === undefined) return 0;
      s = String(s);
      if (!m.re) {
        var hayT = ci ? s.toLowerCase() : s;
        var cnt = 0, pos = 0;
        while ((pos = hayT.indexOf(m.src, pos)) >= 0) { cnt++; pos += m.src.length; }
        return cnt;
      }
      var reC = m.re, n = 0, mtC;
      reC.lastIndex = 0;
      while ((mtC = reC.exec(s)) !== null) {
        if (mtC[0] === '') {                 // 零宽匹配：手动前进一格，否则死循环
          if (mtC.index >= s.length) break;
          reC.lastIndex++;
          continue;
        }
        n++;
      }
      reC.lastIndex = 0;
      return n;
    };

    /* 把命中片段逐个包进 <mark>；没命中返回 null，调用方回退到纯文本渲染。
       cur >= 0 时，第 cur 个（本次调用内的序号）额外加 .is-cur —— 那是 ↑↓ 当前停的那个。
       走过的每一处都要包，不能只包第一处，否则「一行里明明有三处，界面只染一块」。 */
    m.mark = function (s, cur) {
      s = String(s);
      var seq = 0;
      var wrap = function (t) {
        var cls = 'jv-mark' + (seq === cur ? ' is-cur' : '');
        seq++;
        return '<mark class="' + cls + '">' + JP.escapeHtml(t) + '</mark>';
      };

      // 非正则：要包下**所有**出现，不能只包第一处 —— 否则「一行里明明有三处命中，
      // 界面只染了一块」，看起来就像漏匹配
      if (!m.re) {
        var hay = ci ? s.toLowerCase() : s;
        var outT = '', lastT = 0, at, hitT = false;
        while ((at = hay.indexOf(m.src, lastT)) >= 0) {
          hitT = true;
          outT += JP.escapeHtml(s.slice(lastT, at)) + wrap(s.substr(at, m.src.length));
          lastT = at + m.src.length;
        }
        if (!hitT) return null;
        return outT + JP.escapeHtml(s.slice(lastT));
      }

      var re = m.re;
      re.lastIndex = 0;
      var out = '', last = 0, hit = false, mt;
      while ((mt = re.exec(s)) !== null) {
        if (mt[0] === '') {                 // 零宽匹配：手动前进一格，否则死循环
          if (mt.index >= s.length) break;
          re.lastIndex++;
          continue;
        }
        hit = true;
        out += JP.escapeHtml(s.slice(last, mt.index)) + wrap(mt[0]);
        last = mt.index + mt[0].length;
      }
      re.lastIndex = 0;
      if (!hit) return null;
      return out + JP.escapeHtml(s.slice(last));
    };

    return m;
  };

  // 反馈统一走宿主通知；宿主不支持时静默
  JP.notify = function (msg) {
    if (!msg) return;
    if (JP.dbx && typeof JP.dbx.notify === 'function') {
      try {
        var r = JP.dbx.notify(msg);
        if (r && typeof r.then === 'function') r.catch(function () {});
      } catch (e) { /* 宿主通知失败，忽略 */ }
    }
  };

  JP.copyText = function (text) {
    if (!text) return Promise.reject(new Error('empty'));
    // 宿主桥接（写操作无权限门控，直接走）
    var dbx = JP.dbx;
    if (dbx) {
      if (typeof dbx.copy === 'function') return Promise.resolve(dbx.copy(text));
      if (dbx.clipboard && typeof dbx.clipboard.writeText === 'function') {
        return Promise.resolve(dbx.clipboard.writeText(text));
      }
    }
    // 回退：浏览器原生 clipboard API
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (e) { reject(e); }
    });
  };

  /* ---------- 文本宽度：canvas 测量 ---------- */
  var _canvas = null, _ctx = null, _font = '', _charW = 7;

  JP.setMeasureFont = function (font) {
    if (!font || font === _font) return;
    _font = font;
    try {
      if (!_canvas) {
        _canvas = document.createElement('canvas');
        _ctx = _canvas.getContext('2d');
      }
      if (_ctx) {
        _ctx.font = font;
        _charW = _ctx.measureText('M').width || 7;
      }
    } catch (e) { _charW = 7; }
  };

  JP.textWidth = function (s) {
    if (!s) return 0;
    return _ctx ? _ctx.measureText(s).width : s.length * _charW;
  };

  JP.charWidth = function () { return _charW; };

  /* ---------- 光标逻辑位置映射（JSON 美化只插入空白） ---------- */
  function isWs(c) {
    return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 0xFEFF;
  }

  JP.caretLogicalPos = function (text, pos) {
    var n = 0;
    var end = pos < text.length ? pos : text.length;
    for (var i = 0; i < end; i++) { if (!isWs(text.charCodeAt(i))) n++; }
    return n;
  };

  JP.posFromLogical = function (text, n) {
    if (n <= 0) return 0;
    var c = 0;
    for (var i = 0; i < text.length; i++) {
      if (!isWs(text.charCodeAt(i))) {
        c++;
        if (c === n) return i + 1;
      }
    }
    return text.length;
  };

  /* ---------- 加载遮罩 ---------- */
  JP.showLoading = function (msg) {
    var el = JP.$('jpLoadOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'jpLoadOverlay';
      el.className = 'load-overlay';
      el.innerHTML = '<div class="load-box"><span class="load-spinner"></span><span class="load-text"></span></div>';
      document.body.appendChild(el);
    }
    el.querySelector('.load-text').textContent = msg || JP.t('loading');
    el.hidden = false;
  };

  JP.hideLoading = function () {
    var el = JP.$('jpLoadOverlay');
    if (el) el.hidden = true;
  };
})();
