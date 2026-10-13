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
  var PAD_R = 8;        // 行右侧留白，与 .jv-row 的 padding-right 对齐
  var OVERSCAN = 8;     // 视口上下额外渲染行数
  var MIN_USABLE = 60;  // 缩进再深也给它留出这么多宽度算换行
  var RELAYOUT_FIX_MAX = 4;   // 实测高度校正布局的最大次数（估算抖动时兜底，避免反复重排）
  var HIGHLIGHT_LIMIT = 100000; // 超过这个长度的值不再逐段包 <mark>（见 paintCell）

  var host, canvasEl, rowsEl, plainEl;
  var rows = [];
  var mode = 'none';    // 'tree' | 'plain' | 'none'
  var rowH = 22, padX = 12, padY = 10;
  var pool = [];
  var lastStart = -1, lastCount = -1;
  var rafId = 0;

  /* 长值（大段文本）要整段展示并按可视宽度软换行，所以每行不再是固定 22px 高：
     yOff[i] 是第 i 行相对画布顶部的像素偏移（第 0 行 = padY），lnArr[i] 是它占的视觉行数。
     有了这两份表，累积偏移改成前缀和，滚动定位从「乘行高」换成「二分查 yOff」。 */
  var availW = 0;       // 可用文本宽度（px），随面板宽度变化
  var yOff = null;      // Float64Array(rows.length + 1)，末项是内容总底部
  var lnArr = null;     // Int32Array(rows.length)
  var fixLeft = 0;      // 用真实 DOM 高度校正布局的剩余次数（防止估算抖动导致反复重排）
  var measuring = false;

  var matcher = null;   // 搜索匹配器（JP.makeMatcher 的产物），null = 不搜索
  var curIdx = -1;      // 当前搜索命中所在的下标，整行加 .is-cur
  var lnW = 0;          // 行号槽宽度（px）

  /* ---------- 初始化 ---------- */
  V.onRender = null;   // 每次窗口重排后回调（外部挂的行 hover 浮层要用它自保）

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
    updateLnWidth();     // 字符宽度随字体变化，行号槽要跟着重算
  }

  // 行号槽宽度：按总行数的位数算，避免行数变化时每行的缩进都跳动
  function updateLnWidth() {
    var digits = String(rows.length || 1).length;
    if (digits < 2) digits = 2;
    lnW = Math.round(digits * JP.charWidth()) + 16;
    if (rowsEl) rowsEl.style.setProperty('--jv-ln-w', lnW + 'px');
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

    updateLnWidth();
    availW = contentWidth();
    fixLeft = RELAYOUT_FIX_MAX;
    layout(0);
    sizeCanvas();

    lastStart = lastCount = -1;
    render();
  };

  /* ---------- 布局：每行占几个视觉行 + 累积像素偏移 ---------- */

  // 可用文本宽度：面板宽度减去左右留白（clientWidth 已扣掉滚动条）
  function contentWidth() {
    var w = host.clientWidth - padX * 2;
    return (w && w > 80) ? w : 600;
  }

  // 行盒内真正能放文本的宽度（行号槽与缩进要占掉）
  function usableOf(e) {
    var u = availW - (lnW + e.depth * INDENT) - PAD_R;
    return u > MIN_USABLE ? u : MIN_USABLE;
  }

  /* 一行的视觉行数：等宽字体下能任意位置断行（word-break: break-all），所以
     「总宽 ÷ 可用宽」向上取整就是行数；CJK 宽字符造成的偏差由 verifyVisible 拿实测高度兜住。
     短行先用 model 给的字符数估个便宜的下界，省掉每行一次 measureText。 */
  function linesOf(e) {
    var cw = JP.charWidth();
    // 按最坏情况（全是中文这类双宽字符）都装得下，就必定是单行，省掉一次 measureText
    if (FOLD_W + e.chars * cw * 2 <= usableOf(e)) return 1;
    var c = rowCells(e);
    var w = FOLD_W + JP.textWidth(c.kt + c.pt + c.vt + c.tt);
    if (w <= 0) return 1;
    var n = Math.ceil(w / usableOf(e));
    return n > 1 ? n : 1;
  }

  /* 从 from 行起重算偏移表。rows 变了、面板宽度变了、行数被实测校正了都要走这里一次。
     整树重算是 O(行数)，只在数据/尺寸变化与少数几次校正时发生，滚动本身不触发。 */
  function layout(from) {
    var n = rows.length;
    if (!yOff || yOff.length !== n + 1) yOff = new Float64Array(n + 1);
    if (!lnArr || lnArr.length !== n) lnArr = new Int32Array(n);
    if (!from || from < 0) from = 0;

    var y = from === 0 ? padY : yOff[from];
    for (var i = from; i < n; i++) {
      yOff[i] = y;
      lnArr[i] = linesOf(rows[i]);
      y += lnArr[i] * rowH;
    }
    yOff[n] = y;
  }

  // 第一个顶部 > y 的行；找不到就返回 rows.length
  function rowAfter(y) {
    var lo = 0, hi = rows.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (yOff[mid] <= y) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /* ---------- 搜索高亮 / 命中跳转 ----------
     外部（app.js）负责在整棵 JSON 里找出命中位置并把它展开成行，
     这里只负责「当前<b>可见</b>窗口」里的着色，成本恒定，与 JSON 大小无关。 */

  // 设置搜索模式：pat 为 JP.makeMatcher 的产物，null 表示关闭搜索
  V.setSearch = function (pat) {
    matcher = pat || null;
    lastStart = lastCount = -1;
    render();
  };

  // 当前命中行（-1 表示没有）
  V.setCurrentRow = function (i) {
    curIdx = (typeof i === 'number' && i >= 0) ? i : -1;
    lastStart = lastCount = -1;
    render();
  };

  // 把某一行滚到视口中间（行高可能是好几倍，超高就直接对齐到行首）
  V.scrollToIndex = function (i) {
    if (i < 0 || i >= rows.length) return;
    if (!yOff) layout(0);
    var vh = host.clientHeight || 400;
    var top = yOff[i] - padY;
    var h = lnArr[i] * rowH;
    host.scrollTop = Math.max(0, Math.round(h >= vh ? top : top + h / 2 - vh / 2));
    lastStart = lastCount = -1;
    render();
  };

  V.rowCount = function () { return rows.length; };

  // 某个节点第一次出现的行下标（容器的首行就是显示它 key 的那行）
  V.indexOfNode = function (node) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].node === node) return i;
    }
    return -1;
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
    curIdx = -1;
    yOff = lnArr = null;
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
    if (mode === 'tree') {
      availW = contentWidth();     // 面板宽 / 字体变了，每行的换行结果都可能变
      fixLeft = RELAYOUT_FIX_MAX;
      layout(0);
      sizeCanvas();
    }
    lastStart = lastCount = -1;
    render();
  };

  V.entryAt = function (i) { return rows[i] || null; };

  function sizeCanvas() {
    if (!rows.length || !yOff) {
      canvasEl.style.height = '0px';
      canvasEl.style.width = '0px';
      return;
    }
    // 内容按面板宽度换行，横向不再撑开画布
    canvasEl.style.width = '100%';
    canvasEl.style.height = (yOff[rows.length] + padY) + 'px';
  }

  /* ---------- 渲染窗口 ---------- */
  function render() {
    if (mode !== 'tree') return;

    ensureLayout();          // 面板宽度变化后按新宽度重排一次

    var st = host.scrollTop;
    var vh = host.clientHeight || 400;

    // 二分取代「乘行高」：行高不再恒定，窗口边界要靠累积偏移表来定位
    var start = rowAfter(st - padY) - 1 - OVERSCAN;
    if (start < 0) start = 0;
    if (start > rows.length) start = rows.length;

    var end = rowAfter(st + vh) + OVERSCAN;
    if (end > rows.length) end = rows.length;
    var count = end - start;
    if (count < 0) count = 0;

    if (start === lastStart && count === lastCount) return;
    lastStart = start;
    lastCount = count;

    ensurePool(count);
    rowsEl.style.transform = 'translateY(' + (yOff[start] - padY) + 'px)';

    for (var i = 0; i < count; i++) {
      var el = pool[i];
      var idx = start + i;
      el.__i = idx;
      applyRow(el, rows[idx], rowCells(rows[idx]));
    }
    for (var j = count; j < pool.length; j++) pool[j].style.display = 'none';

    verifyVisible(start, count);

    // 行 DOM 被复用过：之前挂在某一行上的 hover 浮层（复制按钮）已经指向别的数据了，通知外部收回去
    if (V.onRender) V.onRender();
  }

  // 宽度变了就重排（拖拽面板、工作区收起都会走到这里）
  function ensureLayout() {
    var w = contentWidth();
    if (!yOff || yOff.length !== rows.length + 1 || w !== availW) {
      availW = w;
      layout(0);
      sizeCanvas();
    }
  }

  /* 行数是按「宽度 ÷ 可用宽」估算的，中英混排 / 宽字符会让它偏一两行。这里拿渲染出来的
     真实高度回写一次累积偏移，画布总高才准（否则最末几行滚不到）。只校可见窗口 + 次数封顶，
     避免滚动时每一帧都全树重排。 */
  function verifyVisible(start, count) {
    if (measuring || fixLeft <= 0 || !yOff) return;

    var first = -1;
    for (var j = 0; j < count; j++) {
      var real = pool[j].offsetHeight;
      if (!real) continue;
      var ln = Math.round(real / rowH);
      if (ln < 1) ln = 1;
      var idx = start + j;
      if (ln !== lnArr[idx]) {
        lnArr[idx] = ln;
        if (first < 0 || idx < first) first = idx;
      }
    }
    if (first < 0) return;

    fixLeft--;
    measuring = true;
    layout(first);
    sizeCanvas();
    lastStart = lastCount = -1;
    measuring = false;
    render();               // 偏移变了，按新的累积高度重画这一帧
  }

  function ensurePool(n) {
    while (pool.length < n) {
      var el = document.createElement('div');
      el.className = 'jv-row';
      // 行号放最前面（绝对定位在行首，不参与缩进）
      var ln = document.createElement('span');
      ln.className = 'jv-ln';
      el.appendChild(ln);
      el.__ln = ln;
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

  // 值整段渲染，不再截到定长加省略号：超长文本交给行内换行展示，双击复制仍拿到完整值
  function leafText(n) {
    var v = n.value;
    if (n.kind === 'string') return JSON.stringify(v);
    if (n.kind === 'number' || n.kind === 'boolean') return String(v);
    if (n.kind === 'null') return 'null';
    return String(v);
  }

  /* 一行的各段文本：抽成纯计算，布局（换行算行数）与渲染共用同一份结果，
     否则两边算法一旦漂移，就会出现「按两行算的高度里塞一行、位置错半行」。 */
  function rowCells(e) {
    if (e.__cells) return e.__cells;      // 一份 rows 里行文本不会再变，重复 stringify 太贵
    var n = e.node;
    var container = Model.isContainer(n);
    var hk = hasKeyOf(n);
    var cm = e.comma ? ',' : '';
    var c = { hk: hk, container: container, vcls: '', fcls: 'jv-fold', ftxt: ' ', kt: '', pt: '', vt: '', tt: '', vtitle: '' };

    if (!container) {
      c.vt = leafText(n);
      c.vcls = 's-' + n.kind;
      c.kt = hk ? JSON.stringify(n.key) : '';
      c.pt = hk ? ': ' : '';
      c.tt = cm;
    } else if (e.part === 'close') {
      c.pt = closeBrace(n) + cm;
    } else if (e.part === 'more') {
      // 折叠位留空不可点，只有「加载更多」文案本身可点
      c.ftxt = '·';
      c.vt = JP.t('load_more', JP.fmtNum(n.size - e.from));
      c.vcls = 's-more';
      c.vtitle = JP.t('load_more_title',
        JP.fmtNum(Math.min(Model.PAGE, n.size - e.from)), JP.fmtNum(n.size - e.from));
      c.tt = cm;
    } else if (n.expanded) {
      c.fcls = 'jv-fold clickable';
      c.ftxt = '▾';
      c.kt = hk ? JSON.stringify(n.key) : '';
      c.pt = (hk ? ': ' : '') + openBrace(n);
    } else {
      c.fcls = 'jv-fold clickable';
      c.ftxt = '▸';
      c.kt = hk ? JSON.stringify(n.key) : '';
      c.pt = (hk ? ': ' : '') + openBrace(n);
      c.vt = ' … ' + JP.fmtNum(n.size) + (n.kind === 'array' ? JP.t('unit_items') : JP.t('unit_keys')) + ' ';
      c.vcls = 's-preview';
      c.tt = closeBrace(n) + cm;
    }
    e.__cells = c;
    return c;
  }

  function applyRow(el, e, c) {
    var n = e.node;

    el.__fold.textContent = c.ftxt;
    el.__fold.className = c.fcls;
    // key：这一行到底有没有渲染 key 只看 kt。容器收尾行（「}」）和「加载更多」行的 kt 是空的，
    // 但节点本身仍有 key —— 绝不能拿 node.key 往这一行里写，否则会把整个 key 画到「}」后面
    paintCell(el.__key, c.kt, c.hk ? String(n.key) : null);

    el.__punct.textContent = c.pt;
    // value：类名要先落，paintCell 可能再往上叠 is-hit。
    // 容器的折叠摘要「 … 12 项 」不是任何节点的取值，只是计数提示 —— 它不在 matches 里，
    // 必须原样输出（搜 "12" 时若给它染色，会出现「计数 0/0 但有黄块」的不一致）
    el.__val.className = 'jv-val ' + c.vcls;
    el.__val.title = c.vtitle || '';        // 只有「加载更多」行带提示
    if (c.container) el.__val.textContent = c.vt;
    else paintCell(el.__val, c.vt, rawValueOf(n));
    el.__tail.textContent = c.tt;
    el.__tail.className = 'jv-tail' + (c.tt ? ' s-punct' : '');

    var idx = el.__i;
    el.__ln.textContent = String(idx + 1);
    el.classList.toggle('is-cur', idx === curIdx);
    el.style.paddingLeft = (lnW + e.depth * INDENT) + 'px';
  }

  // 叶子节点参与搜索的「值原文」（大整数要去掉 JPBIG_ 前缀，与显示内容一致）
  function rawValueOf(n) {
    var v = n.value;
    if (v === null) return 'null';
    if (typeof v === 'string') return v.indexOf('JPBIG_') === 0 ? v.slice(6) : v;
    return String(v);
  }

  /* 给某一列染色。disp 是屏幕上真正看得见的文本，raw 是参与匹配的原文。
     染色一律按 disp 的位置来：值是 JSON 字符串时，disp 里的引号已被 JSON.stringify
     转义成 \" ，跟原文已经不是同一串字符 —— 这时拿原文定位找不到精确落点，老代码就退化成
     「原文命中 → 整段加底色」，于是一整串 JSON 全黄，反而看不见命中的是哪几个字。
     搜索词本身几乎不会被转义，所以直接在 disp 上找，命中范围天然就是那几个字符。 */
  function paintCell(span, disp, raw) {
    span.classList.remove('is-hit');
    if (!disp) { span.textContent = ''; return; }
    if (!matcher) { span.textContent = disp; return; }

    if (disp.length > HIGHLIGHT_LIMIT) {
      // 极长值：整段 escape + 逐个包裹的代价远大于收益，只标「这一格命中了」
      if (raw != null && matcher.test(String(raw))) span.classList.add('is-hit');
      span.textContent = disp;
      return;
    }

    var html = matcher.mark(disp);
    if (html !== null) { span.innerHTML = html; return; }

    // disp 上找不到：命中内容跨了 \" \n 这类转义序列（只有搜特殊字符才会遇到），
    // 没法精确定位到哪几个字，退一步整段标记，至少「计数说命中，界面也有痕迹」
    if (raw != null && matcher.test(String(raw))) {
      span.innerHTML = '<mark class="jv-mark">' + JP.escapeHtml(disp) + '</mark>';
      return;
    }
    span.textContent = disp;
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

    if (isMore) { if (V.onMore) V.onMore(e, idx, !!ev.shiftKey); }
    else if (V.onToggle) V.onToggle(e, idx);
  }
})();
