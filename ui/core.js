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
})();
