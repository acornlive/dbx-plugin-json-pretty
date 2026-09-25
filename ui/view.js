/* ============================================================
   view.js - 结果区虚拟滚动渲染器（window.JP.View）
   - DOM 行数恒定（视口行数 + overscan），与 JSON 大小无关
   - 行元素复用，更新只用 textContent（不做 innerHTML 解析）
   - 滚动用 rAF 合并，测量宽度走 canvas（不触发同步布局）
   - 纯文本模式（压缩 / 转义 / 错误）走单独的 <pre>
   ============================================================ */
(function () {
  'use strict';
  var JP = window.JP;
  var Model = JP.Model;
  var V = JP.View = {};

  var INDENT = 18;      // 每层缩进像素
  var FOLD_W = 14;      // 折叠箭头占位宽度
  var OVERSCAN = 8;     // 视口上下额外渲染行数

  var host, canvasEl, rowsEl, plainEl;
  var rows = [];
  var mode = 'none';    // 'tree' | 'plain' | 'none'
  var rowH = 22, padX = 12, padY = 10;
  var pool = [];
  var lastStart = -1, lastCount = -1;
  var contentW = 0;
  var rafId = 0;

  /* ---------- 初始化 ---------- */
  V.init = function (opts) {
    host = opts.host;
    canvasEl = opts.canvas;
    rowsEl = opts.rows;
    plainEl = opts.plain;

    readMetrics();

    host.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    if (typeof ResizeObserver !== 'undefined') {
      try { new ResizeObserver(schedule).observe(host); } catch (e) { /* 忽略 */ }
    }
    rowsEl.addEventListener('click', onRowClick);

    V.clear();
  };

  function readMetrics() {
    var cs = getComputedStyle(host);
    var rh = parseFloat(cs.getPropertyValue('--row-h'));
    var px = parseFloat(cs.getPropertyValue('--jv-pad-x'));
    var py = parseFloat(cs.getPropertyValue('--jv-pad-y'));
    if (!isNaN(rh) && rh > 0) rowH = rh;
    if (!isNaN(px) && px >= 0) padX = px;
    if (!isNaN(py) && py >= 0) padY = py;

    var cs2 = getComputedStyle(rowsEl);
    var font = cs2.font ||
      (cs2.fontStyle + ' ' + cs2.fontWeight + ' ' + cs2.fontSize + ' ' + cs2.fontFamily);
    JP.setMeasureFont(font);
  }

  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () { rafId = 0; render(); });
  }

  /* ---------- 数据入口 ---------- */
  V.setTree = function (list) {
    rows = list || [];
    mode = 'tree';
    canvasEl.hidden = false;
    plainEl.hidden = true;

    var maxW = 0;
    var cw = JP.charWidth();
    for (var i = 0; i < rows.length; i++) {
      var e = rows[i];
      var w = e.depth * INDENT + FOLD_W + e.chars * cw;
      if (w > maxW) maxW = w;
    }
    contentW = Math.ceil(maxW);
    sizeCanvas();

    lastStart = lastCount = -1;
    render();
  };

  V.setPlain = function (text, isError) {
    rows = [];
    mode = 'plain';
    canvasEl.hidden = true;
    plainEl.hidden = false;
    plainEl.className = 'jv-plain' + (isError ? ' is-error' : '');
    plainEl.textContent = text || '';
    lastStart = lastCount = -1;
  };

  V.clear = function () {
    rows = [];
    mode = 'none';
    canvasEl.hidden = true;
    plainEl.hidden = true;
    plainEl.className = 'jv-plain';
    plainEl.textContent = '';
    for (var i = 0; i < pool.length; i++) pool[i].style.display = 'none';
    lastStart = lastCount = -1;
    canvasEl.style.height = '0px';
    canvasEl.style.width = '0px';
  };

  // 主题/语言/尺寸变化后重绘
  V.refresh = function () {
    readMetrics();
    if (mode === 'tree') sizeCanvas();
    lastStart = lastCount = -1;
    render();
  };

  V.entryAt = function (i) { return rows[i] || null; };

  function sizeCanvas() {
    canvasEl.style.height = (rows.length * rowH + padY * 2) + 'px';
    canvasEl.style.width = (contentW + padX * 2) + 'px';
  }

  /* ---------- 渲染窗口 ---------- */
  function render() {
    if (mode !== 'tree') return;

    var st = host.scrollTop;
    var vh = host.clientHeight || 400;

    var start = Math.floor((st - padY) / rowH) - OVERSCAN;
    if (start < 0) start = 0;
    if (start > rows.length) start = rows.length;

    var count = Math.ceil(vh / rowH) + OVERSCAN * 2 + 2;
    if (start + count > rows.length) count = rows.length - start;
    if (count < 0) count = 0;

    if (start === lastStart && count === lastCount) return;
    lastStart = start;
    lastCount = count;

    ensurePool(count);
    rowsEl.style.transform = 'translateY(' + (start * rowH) + 'px)';

    var maxW = contentW;
    for (var i = 0; i < count; i++) {
      var el = pool[i];
      var idx = start + i;
      el.__i = idx;
      var w = fillRow(el, rows[idx]);
      var right = rows[idx].depth * INDENT + FOLD_W + w;
      if (right > maxW) maxW = right;
    }
    for (var j = count; j < pool.length; j++) pool[j].style.display = 'none';

    if (maxW > contentW) {
      contentW = Math.ceil(maxW);
      canvasEl.style.width = (contentW + padX * 2) + 'px';
    }
  }

  function ensurePool(n) {
    while (pool.length < n) {
      var el = document.createElement('div');
      el.className = 'jv-row';
      var names = ['jv-fold', 'jv-key', 'jv-punct', 'jv-val', 'jv-tail'];
      var refs = [];
      for (var k = 0; k < names.length; k++) {
        var sp = document.createElement('span');
        sp.className = names[k];
        el.appendChild(sp);
        refs.push(sp);
      }
      el.__fold = refs[0];
      el.__key = refs[1];
      el.__punct = refs[2];
      el.__val = refs[3];
      el.__tail = refs[4];
      rowsEl.appendChild(el);
      pool.push(el);
    }
    for (var i = 0; i < n; i++) pool[i].style.display = '';
  }

  function openBrace(n) { return n.kind === 'array' ? '[' : '{'; }
  function closeBrace(n) { return n.kind === 'array' ? ']' : '}'; }

  function hasKeyOf(n) { return !(n.key === null || n.key === undefined); }

  function leafText(n) {
    var v = n.value;
    if (n.kind === 'string') {
      var s = v;
      var cut = s.length > Model.MAX_CELL;
      if (cut) s = s.slice(0, Model.MAX_CELL);
      return JSON.stringify(s) + (cut ? '…' : '');
    }
    if (n.kind === 'number' || n.kind === 'boolean') return String(v);
    if (n.kind === 'null') return 'null';
    return String(v);
  }

  function fillRow(el, e) {
    var n = e.node;
    var container = Model.isContainer(n);
    var hk = hasKeyOf(n);

    var kt = '', pt = '', vt = '', tt = '', vcls = '';
    var fcls = 'jv-fold', ftxt = ' ';
    var cm = e.comma ? ',' : '';

    if (!container) {
      kt = hk ? JSON.stringify(n.key) : '';
      pt = hk ? ': ' : '';
      vt = leafText(n);
      vcls = 's-' + n.kind;
      tt = cm;
    } else if (e.part === 'close') {
      pt = closeBrace(n) + cm;
    } else if (e.part === 'more') {
      // 折叠位留空不可点，只有「加载更多」文案本身可点
      ftxt = '·';
      vt = JP.t('load_more', JP.fmtNum(n.size - e.from));
      vcls = 's-more';
      tt = cm;
    } else if (n.expanded) {
      fcls = 'jv-fold clickable';
      ftxt = '▾';
      kt = hk ? JSON.stringify(n.key) : '';
      pt = (hk ? ': ' : '') + openBrace(n);
    } else {
      fcls = 'jv-fold clickable';
      ftxt = '▸';
      kt = hk ? JSON.stringify(n.key) : '';
      pt = (hk ? ': ' : '') + openBrace(n);
      vt = ' … ' + JP.fmtNum(n.size) + (n.kind === 'array' ? JP.t('unit_items') : JP.t('unit_keys')) + ' ';
      vcls = 's-preview';
      tt = closeBrace(n) + cm;
    }

    el.__fold.textContent = ftxt;
    el.__fold.className = fcls;
    el.__key.textContent = kt;
    el.__punct.textContent = pt;
    el.__val.textContent = vt;
    el.__val.className = 'jv-val ' + vcls;
    el.__tail.textContent = tt;
    el.__tail.className = 'jv-tail' + (tt ? ' s-punct' : '');
    el.style.paddingLeft = (e.depth * INDENT) + 'px';

    return JP.textWidth(kt + pt + vt + tt);
  }

  /* ---------- 行内交互：折叠箭头 / 加载更多 ---------- */
  function onRowClick(ev) {
    var tg = ev.target;
    if (!tg || !tg.classList) return;

    var isFold = tg.classList.contains('jv-fold') && tg.classList.contains('clickable');
    var isPreview = tg.classList.contains('jv-val') && tg.classList.contains('s-preview');
    var isMore = tg.classList.contains('jv-val') && tg.classList.contains('s-more');
    if (!isFold && !isMore && !isPreview) return;

    var idx = tg.parentNode && tg.parentNode.__i;
    if (idx == null) return;
    var e = rows[idx];
    if (!e) return;

    if (isMore) { if (V.onMore) V.onMore(e, idx); }
    else if (V.onToggle) V.onToggle(e, idx);
  }
})();
