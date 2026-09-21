/* ============================================================
   JSON 格式化工具 - DBX 纯前端插件主逻辑
   - 通过 window.dbxPlugin 桥接宿主（官方 Host API 1）
   - 按 JSON 层级「按需渲染」：折叠的子树不生成 DOM
   - 左右面板可拖动（不持久化，每次按内置常量 FALLBACK_RATIO 的固定默认）
   - 不使用原生 alert/confirm/prompt，不使用 CDN
   ============================================================ */
(function () {
  'use strict';

  var dbx = (typeof window !== 'undefined' && window.dbxPlugin) ? window.dbxPlugin : null;

  // i18n：来自 i18n.js（window.t / window.locale）。回退到 key 本身，避免脚本缺失时报错。
  var t = (typeof window !== 'undefined' && typeof window.t === 'function') ? window.t : function (k) { return k; };
  var currentLocale = (typeof window !== 'undefined' && typeof window.locale === 'function') ? window.locale() : 'en';

  /* ---------- 常量 ---------- */
  var INDENT = 18;              // 每层缩进像素
  var MIN_COL = 180;            // 单侧最小宽度
  var FALLBACK_RATIO = 0.42;    // 左栏默认占比
  var FULL_EXPAND = Number.MAX_SAFE_INTEGER;    // 全展开标记

  /* ---------- 状态 ---------- */
  var state = {
    root: null,        // 当前 JSON 层级树根节点
    outputText: '',    // 完整格式化文本（用于复制，不随折叠变化）
    depth: 0,          // JSON 最大层级
    keys: 0,           // 键总数
    items: 0,          // 数组元素总数
    defaultExpandLevel: FULL_EXPAND  // 默认全展开
  };

  /* ---------- 元素引用 ---------- */
  var jsonInput, jsonOutput, inputCounter, splitEl, resizerEl, levelButtonsEl, ctxMenu, fileInput;

  function $(id) { return document.getElementById(id); }

  /* ---------- 启动 ---------- */
  function boot() {
    applyI18n();
    bindUI();
    initSplitter();
    bindTheme();
    bindLocale();
    // 左侧默认空，等待用户粘贴 / 导入 / 输入
  }

  /* ============================================================
     国际化：按语言渲染静态文本；随 DBX 语言切换实时更新
     ============================================================ */
  function applyI18n() {
    currentLocale = (typeof window.locale === 'function') ? window.locale() : currentLocale;
    document.documentElement.setAttribute('lang', currentLocale);

    // 文本节点
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    // 属性（title）
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    // 属性（placeholder）
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
  }

  // 语言切换：宿主通过 dbx-plugin-env / onEvent 广播 locale
  function bindLocale() {
    try {
      if (dbx && typeof dbx.onEvent === 'function') {
        dbx.onEvent(function (e) {
          if (e && (e.type === 'env' || e.type === 'locale')) applyEnvLocale(e);
        });
      }
    } catch (e) { /* 忽略 */ }
    try {
      window.addEventListener('dbx-plugin-env', function (ev) {
        if (ev && ev.detail) applyEnvLocale(ev.detail);
      });
    } catch (e) { /* 忽略 */ }
  }

  function applyEnvLocale(env) {
    var next = (env && env.locale) ||
               (env && env.env && env.env.locale) ||
               (window.dbxPlugin && window.dbxPlugin.locale);
    if (!next || next === currentLocale) return;
    applyI18n();
    // 动态文案同步刷新
    updateCounter();
    renderLevelButtons();
    if (state.root) renderTree();
  }

  if (dbx && dbx.ready && typeof dbx.ready.then === 'function') {
    dbx.ready.then(boot).catch(boot);
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bindUI() {
    jsonInput = $('jsonInput');
    jsonOutput = $('jsonOutput');
    inputCounter = $('inputCounter');
    splitEl = $('split');
    resizerEl = $('resizer');
    levelButtonsEl = $('levelButtons');
    ctxMenu = $('ctxMenu');
    fileInput = $('fileInput');

    // 导入按钮：「选择本地文件」在隔离 iframe 中仍是标准且可靠的入口
    // （拖拽依赖宿主原生通道，部分宿主下不生效，故两者并存）
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        readFileInto(f);
        fileInput.value = ''; // 允许重复选择同一文件
      });
    }

    jsonInput.addEventListener('input', function () {
      updateCounter();
      scheduleAuto();
    });

    // 统一事件委托：工具栏 / 层级按钮 / 结果区折叠箭头
    document.addEventListener('click', function (e) {
      var lvlBtn = e.target.closest('.lvl-btn');
      if (lvlBtn) { onLevelClick(parseInt(lvlBtn.dataset.level, 10)); return; }

      var btn = e.target.closest('button[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      if (ACTIONS[action]) ACTIONS[action]();
    });

    // 折叠/展开：结果区内的折叠箭头
    jsonOutput.addEventListener('click', function (e) {
      var toggle = e.target.closest('.fold-toggle.clickable');
      if (!toggle) return;
      ensureFormatted();
      var node = toggle.__node;
      if (node) { node.expanded = !node.expanded; renderTree(); }
    });

    // 双击复制：优先复制选中的文本；无选中则复制双击所在块的 JSON 值
    jsonOutput.addEventListener('dblclick', function (e) {
      var sel = (window.getSelection && window.getSelection());
      var text = (sel && !sel.isCollapsed) ? sel.toString() : '';
      if (!text) {
      var row = e.target.closest('.row');
      var node = row && row.__node;
      if (!node) { notify(t('sel_or_dbl')); return; }
      text = serializeNode(node);
    }
    if (!text) return;
    copyText(text).then(function () { notify(t('copied_sel')); })
                   .catch(function () { notify(t('copy_fail_manual')); });
    });

    updateCounter();

    bindContextMenu();
  }

  /* ============================================================
     左侧导入 .json 文件解析（「导入」按钮，纯前端 iframe 可靠入口）
     ============================================================ */

  function loadFromFile(name, content) {
    // 去掉可能存在的 UTF-8 BOM
    content = content.replace(/^\uFEFF/, '');
    jsonInput.value = content;
    updateCounter();
    try {
      var data = JSON.parse(content);
      state.outputText = JSON.stringify(data, null, 2);
      syncInputPretty(state.outputText);   // 左侧同步为格式化后的内容
      buildState(data);
      defaultExpand();
      renderTree();
      notify(t('loaded', name, state.depth, state.keys, state.items));
    } catch (e) {
      renderJsonError(e.message);
      notify(t('loaded_err', name, e.message));
    }
  }

  // 读取 File 对象并加载（供「导入」按钮与拖拽共用）
  function readFileInto(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var content = String(reader.result == null ? '' : reader.result);
      loadFromFile(file.name, content);
    };
    reader.onerror = function () { notify(t('file_read_fail', (reader.error && reader.error.message) || 'unknown')); };
    reader.readAsText(file);
  }

  function renderJsonError(msg) {
    state.root = null;
    state.outputText = '';
    jsonOutput.innerHTML = '<div class="row"><span class="error">' + escapeHtml(t('json_err', msg)) + '</span></div>';
  }

  /* ============================================================
     右键上下文菜单：复制所选 / 复制全部 / 全选
     —— 替代原工具栏「复制结果」。内容区本身可选中（白底/黑底均可）。
     ============================================================ */
  var ctxTarget = null; // 'input' | 'output'

  function bindContextMenu() {
    if (!ctxMenu) return;

    // 在输入区 / 结果区上右键弹出
    [jsonInput, jsonOutput].forEach(function (el) {
      el.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        ctxTarget = (el === jsonInput) ? 'input' : 'output';
        showCtxMenu(e.clientX, e.clientY);
      });
    });

    // 点击菜单项 / 点击别处 / 滚动 关闭
    ctxMenu.addEventListener('click', function (e) {
      var item = e.target.closest('.ctx-item');
      if (!item) return;
      handleCtx(item.dataset.act);
      hideCtxMenu();
    });
    document.addEventListener('click', function () { hideCtxMenu(); });
    window.addEventListener('scroll', function () { hideCtxMenu(); }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideCtxMenu(); });

    // 关闭工具栏下拉式「复制结果」残留后，这里也兜底：没有选中时「复制所选」改为复制全部
  }

  function showCtxMenu(x, y) {
    ctxMenu.hidden = false;
    var w = ctxMenu.offsetWidth || 150;
    var h = ctxMenu.offsetHeight || 120;
    var vw = window.innerWidth, vh = window.innerHeight;
    if (x + w > vw) x = vw - w - 8;
    if (y + h > vh) y = vh - h - 8;
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
  }

  function hideCtxMenu() { if (ctxMenu) ctxMenu.hidden = true; }

  function handleCtx(act) {
    if (act !== 'copy-sel') return;
    // 右键「复制」：有选区复制所选，否则复制全部
    var sel;
    if (ctxTarget === 'input') {
      sel = jsonInput.value.substring(jsonInput.selectionStart, jsonInput.selectionEnd);
    } else {
      sel = window.getSelection().toString();
    }
    if (sel && sel.trim()) {
      copyText(sel)
        .then(function () { notify(t('copied_sel_ok')); })
        .catch(function () { notify(t('copy_fail')); });
    } else {
      copyAll();
    }
  }

  // 复制全部（右侧「复制」按钮 / 右键无选区时降级）
  function copyAll() {
    var text = (ctxTarget === 'input') ? jsonInput.value : (state.outputText || jsonOutput.textContent);
    if (!text) { notify(t('no_copy')); return; }
    copyText(text)
      .then(function () { notify(t('copied_all')); })
      .catch(function () { notify(t('copy_fail_manual')); });
  }

  /* ---------- 复制所选/全部：通过右键菜单触发 ---------- */

  /* ============================================================
     左右可拖动分栏（固定默认：左栏占比 0.42，不持久化）
     ============================================================ */
  function initSplitter() {
    // 固定默认值（内联常量，不再依赖单独配置文件）
    var baseRatio = FALLBACK_RATIO;          // 0.42
    state.defaultExpandLevel = FULL_EXPAND;  // 首次格式化默认全部展开

    applyRatio(baseRatio);

    var dragging = false;

    function onMove(e) {
      if (!dragging) return;
      var rect = splitEl.getBoundingClientRect();
      var x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      var ratio = x / rect.width;
      applyRatio(clamp(ratio, MIN_COL / rect.width, 1 - MIN_COL / rect.width));
      e.preventDefault();
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    }

    function onDown(e) {
      dragging = true;
      document.body.classList.add('resizing');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
      e.preventDefault();
    }

    resizerEl.addEventListener('mousedown', onDown);
    resizerEl.addEventListener('touchstart', onDown, { passive: false });
  }

  var _ratio = FALLBACK_RATIO;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function applyRatio(ratio) {
    _ratio = clamp(ratio || FALLBACK_RATIO, 0.1, 0.9);
    splitEl.style.gridTemplateColumns =
      'minmax(0, ' + (_ratio * 100).toFixed(3) + 'fr) 8px minmax(0, ' + ((1 - _ratio) * 100).toFixed(3) + 'fr)';
  }

  /* ---------- 主题适配（官方：data-dbx-theme + dbx-plugin-env + --color-* tokens） ---------- */
  function bindTheme() {
    // 先按官方用 theme 初始化
    try {
      if (dbx && dbx.theme && dbx.theme.appearance) {
        document.documentElement.setAttribute('data-dbx-theme', dbx.theme.appearance);
      }
      if (dbx && dbx.theme && dbx.theme.tokens) applyTokens(dbx.theme.tokens);
    } catch (e) { /* 忽略 */ }

    try {
      if (dbx && typeof dbx.onEvent === 'function') {
        dbx.onEvent(function (e) {
          if (e && (e.type === 'env' || e.type === 'theme')) applyEnv(e);
        });
      }
    } catch (e) { /* 忽略 */ }

    try {
      window.addEventListener('dbx-plugin-env', function (ev) {
        if (ev && ev.detail) applyEnv(ev.detail);
      });
    } catch (e) { /* 忽略 */ }
  }

  function applyEnv(env) {
    var appearance = (env.theme && env.theme.appearance) || env.appearance;
    if (appearance) document.documentElement.setAttribute('data-dbx-theme', appearance);
    if (env.theme && env.theme.tokens) applyTokens(env.theme.tokens);
  }

  function applyTokens(tokens) {
    if (!tokens) return;
    var root = document.documentElement;
    for (var k in tokens) {
      if (tokens.hasOwnProperty(k)) root.style.setProperty(k, tokens[k]);
    }
  }

  /* ============================================================
     工具
     ============================================================ */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function updateCounter() {
    if (inputCounter) inputCounter.textContent = jsonInput.value.length + t('chars');
  }

  function copyText(text) {
    if (!text) return Promise.reject(new Error('empty'));
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
  }

  function flashBtn(btn, ok) {
    var old = btn.textContent;
    btn.textContent = ok ? t('copied_flash') : t('copy_fail');
    btn.classList.add(ok ? 'ok' : 'fail');
    setTimeout(function () {
      btn.textContent = old;
      btn.classList.remove('ok', 'fail');
    }, 1200);
  }

  // 反馈统一走宿主通知；宿主不支持时静默（不再有工具栏状态栏）
  function notify(msg) {
    if (!msg) return;
    if (dbx && typeof dbx.notify === 'function') {
      try {
        var r = dbx.notify(msg);
        if (r && typeof r.then === 'function') r.catch(function () {});
        return;
      } catch (e) { /* 宿主通知失败，忽略 */ }
    }
  }

  /* ============================================================
     构建层级树 & 层级统计
     ============================================================ */
  function buildNode(value, key) {
    if (Array.isArray(value)) {
      return {
        kind: 'array', key: key, expanded: true, size: value.length, raw: value,
        children: value.map(function (v, i) { return buildNode(v, null); })
      };
    }
    if (value && typeof value === 'object') {
      var ks = Object.keys(value);
      return {
        kind: 'object', key: key, expanded: true, size: ks.length, raw: value,
        children: ks.map(function (k) { return buildNode(value[k], k); })
      };
    }
    return {
      kind: value === null ? 'null' : typeof value,
      key: key, value: value
    };
  }

  function measure(node, depth, acc) {
    if (acc.depth < depth) acc.depth = depth;
    if (node.kind === 'object') { acc.keys += node.size; }
    if (node.kind === 'array') { acc.items += node.size; }
    if (node.children) {
      node.children.forEach(function (c) { measure(c, depth + 1, acc); });
    }
  }

  function setExpandedToDepth(node, depth, maxLevel) {
    if (!node.children) return;
    node.expanded = depth < maxLevel;
    node.children.forEach(function (c) { setExpandedToDepth(c, depth + 1, maxLevel); });
  }

  /* ============================================================
     按需渲染：仅展开的子树生成 DOM
     ============================================================ */
  function renderTree() {
    var root = state.root;
    jsonOutput.innerHTML = '';
    if (!root) return;
    var frag = document.createDocumentFragment();
    emitNode(root, 0, frag, true);
    jsonOutput.appendChild(frag);
  }

  function makeRow(depth) {
    var row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = (depth * INDENT) + 'px';
    return row;
  }

  function makeToggle(node) {
    var t = document.createElement('span');
    t.className = 'fold-toggle clickable';
    t.textContent = node.expanded ? '▾' : '▸';
    t.__node = node;
    return t;
  }

  function keyPrefix(node, isRoot) {
    if (node.key === null || typeof node.key === 'undefined') return '';
    return '<span class="key">' + escapeHtml(JSON.stringify(node.key)) + '</span><span class="punct">: </span>';
  }

  function leafHtml(node) {
    var v = node.value;
    if (node.kind === 'string') return '<span class="string">' + escapeHtml(JSON.stringify(v)) + '</span>';
    if (node.kind === 'number') return '<span class="number">' + escapeHtml(String(v)) + '</span>';
    if (node.kind === 'boolean') return '<span class="boolean">' + String(v) + '</span>';
    if (node.kind === 'null') return '<span class="null">null</span>';
    return escapeHtml(String(v));
  }

  function emitNode(node, depth, frag, isRoot) {
    if (!node.children) {
      var lr = makeRow(depth);
      lr.__node = node;
      var lt = document.createElement('span');
      lt.className = 'fold-toggle';
      lt.textContent = ' ';
      var lc = document.createElement('span');
      lc.innerHTML = keyPrefix(node, isRoot) + leafHtml(node);
      lr.appendChild(lt);
      lr.appendChild(lc);
      frag.appendChild(lr);
      return;
    }

    var open = node.kind === 'object' ? '{' : '[';
    var close = node.kind === 'object' ? '}' : ']';
    var row = makeRow(depth);
    row.__node = node;
    row.appendChild(makeToggle(node));
    var content = document.createElement('span');

    if (node.expanded) {
      content.innerHTML = keyPrefix(node, isRoot) + '<span class="punct">' + open + '</span>';
      row.appendChild(content);
      frag.appendChild(row);

      // 空容器直接同行收口
      if (node.size === 0) {
        var er = makeRow(depth);
        er.__node = node;
        var et = document.createElement('span');
        et.className = 'fold-toggle';
        et.textContent = ' ';
        var ec = document.createElement('span');
        ec.innerHTML = '<span class="punct">' + close + '</span>';
        er.appendChild(et);
        er.appendChild(ec);
        frag.appendChild(er);
        return;
      }

      node.children.forEach(function (c) { emitNode(c, depth + 1, frag, false); });

      var cr = makeRow(depth);
      cr.__node = node;
      var ct = document.createElement('span');
      ct.className = 'fold-toggle';
      ct.textContent = ' ';
      var cc = document.createElement('span');
      cc.innerHTML = '<span class="punct">' + close + '</span>';
      cr.appendChild(ct);
      cr.appendChild(cc);
      frag.appendChild(cr);
    } else {
      var unit = node.kind === 'array' ? t('unit_items') : t('unit_keys');
      content.innerHTML = keyPrefix(node, isRoot) +
        '<span class="punct">' + open + '</span>' +
        '<span class="preview"> … ' + node.size + unit + ' </span>' +
        '<span class="punct">' + close + '</span>';
      row.appendChild(content);
      frag.appendChild(row);
    }
  }

  /* ============================================================
     动态层级展开按钮（按 JSON 实际层级，最多 10 级）
     ============================================================ */
  var MAX_LEVEL_BUTTONS = 10;

  function renderLevelButtons() {
    if (!levelButtonsEl) return;
    levelButtonsEl.innerHTML = '';
    var max = Math.min(state.depth, MAX_LEVEL_BUTTONS);
    if (max <= 0) return;

    for (var lv = 1; lv <= max; lv++) {
      (function (lv) {
        var b = document.createElement('button');
        b.className = 'lvl-btn';
        b.type = 'button';
        b.dataset.level = String(lv);
        b.title = t('lvl_title', lv);
        b.textContent = t('lvl_n', lv);
        levelButtonsEl.appendChild(b);
      })(lv);
    }
    var all = document.createElement('button');
    all.className = 'lvl-btn';
    all.type = 'button';
    all.dataset.level = '0';
    all.title = t('lvl_all_title');
    all.textContent = t('lvl_all');
    levelButtonsEl.appendChild(all);
  }

  function onLevelClick(lv) {
    // 若当前不在格式化树状态（被压缩/转义等覆盖），先自动回到格式化
    ensureFormatted();
    if (!state.root) { notify(t('fmt_first')); return; }
    if (lv === 0) {
      if (state.root.children) setExpandedToDepth(state.root, 0, FULL_EXPAND);
      setActiveLevel(null);
      notify(t('expanded_all', state.depth));
    } else {
      if (state.root.children) setExpandedToDepth(state.root, 0, lv);
      setActiveLevel(lv);
      notify(t('expanded_to', lv));
    }
    renderTree();
  }

  // 确保当前处于格式化树状态；否则自动重新格式化
  function ensureFormatted() {
    if (state.root) return;
    if (!jsonInput.value.trim()) return;
    doFormat();
  }

  function setActiveLevel(lv) {
    if (!levelButtonsEl) return;
    var btns = levelButtonsEl.querySelectorAll('.lvl-btn');
    btns.forEach(function (b) {
      var bl = parseInt(b.dataset.level, 10);
      if (lv === null) b.classList.remove('active');
      else b.classList.toggle('active', bl === lv);
    });
  }

  /* ============================================================
     操作
     ============================================================ */
  function parseInput() {
    var raw = jsonInput.value.trim();
    if (!raw) throw new Error(t('input_empty'));
    return JSON.parse(raw);
  }

  function buildState(data) {
    state.root = buildNode(data, null);
    var acc = { depth: 0, keys: 0, items: 0 };
    measure(state.root, 0, acc);
    state.depth = acc.depth;
    state.keys = acc.keys;
    state.items = acc.items;
    renderLevelButtons();
  }

  // 首次格式化：默认全展开（可在 initSplitter 改 state.defaultExpandLevel 为具体层级）
  function defaultExpand() {
    if (!state.root || !state.root.children) return;
    var lv = (state.defaultExpandLevel >= 99) ? FULL_EXPAND : state.defaultExpandLevel;
    setExpandedToDepth(state.root, 0, lv);
    setActiveLevel(lv === FULL_EXPAND ? null : lv);
  }

  // manual=true 表示用户主动点「格式化」按钮：成功/失败都给出宿主通知；
  // 自动格式化（打字防抖触发）保持静默，错误仅渲染在结果区，避免打字时反复弹窗。
  function doFormat(manual) {
    try {
      var data = parseInput();
      state.outputText = JSON.stringify(data, null, 2);
      syncInputPretty(state.outputText);   // 左侧同步为格式化后的内容
      buildState(data);
      defaultExpand();
      renderTree();
      if (manual) notify(t('formatted'));
    } catch (e) {
      renderJsonError(e.message);
      if (manual) notify(t('json_err', e.message));
    }
  }

  /* ---------- 左侧同步为格式化文本（保持光标逻辑位置） ----------
     JSON 美化只插入空白、不改变非空白字符顺序，故用「光标前非空白字符数」
     做映射即可让光标大致停在同一逻辑位置，避免打字时跳位。          */
  function caretLogicalPos(text, pos) {
    var n = 0;
    for (var i = 0; i < pos && i < text.length; i++) {
      if (!/\s/.test(text.charAt(i))) n++;
    }
    return n;
  }

  function posFromLogical(text, n) {
    if (n <= 0) return 0;
    var c = 0;
    for (var i = 0; i < text.length; i++) {
      if (!/\s/.test(text.charAt(i))) {
        c++;
        if (c === n) return i + 1;
      }
    }
    return text.length;
  }

  function syncInputPretty(pretty) {
    if (jsonInput.value === pretty) return;   // 值相同则不动，避免光标重置
    var cur = jsonInput.value;
    var focused = (document.activeElement === jsonInput);
    var selStart = jsonInput.selectionStart;
    var selEnd = jsonInput.selectionEnd;
    var atEnd = (selEnd >= cur.length);
    var lStart = caretLogicalPos(cur, selStart);
    var lEnd = caretLogicalPos(cur, selEnd);

    jsonInput.value = pretty;
    updateCounter();

    if (focused) {
      var s = atEnd ? pretty.length : posFromLogical(pretty, lStart);
      var e = atEnd ? pretty.length : posFromLogical(pretty, lEnd);
      try { jsonInput.setSelectionRange(s, e); } catch (err) { /* 忽略 */ }
    }
  }

  function doCompress() {
    try {
      var data = parseInput();
      var mini = JSON.stringify(data);
      jsonOutput.innerHTML = '<div class="row"><span class="plaintext">' + escapeHtml(mini) + '</span></div>';
      state.outputText = mini;
      state.root = null;
      notify(t('compressed', mini.length));
    } catch (e) {
      notify(t('json_err', e.message));
    }
  }

  function doEscape() {
    var raw = jsonInput.value.trim();
    if (!raw) { notify(t('input_empty')); return; }
    var escaped = JSON.stringify(raw);
    jsonOutput.innerHTML = '<div class="row"><span class="plaintext">' + escapeHtml(escaped) + '</span></div>';
    state.outputText = escaped;
    state.root = null;
    notify(t('escaped'));
  }

  function doUnescape() {
    var raw = jsonInput.value.trim();
    if (!raw) { notify(t('input_empty')); return; }
    var result;
    try {
      result = JSON.parse(raw);
    } catch (e1) {
      try {
        result = JSON.parse('"' + raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
      } catch (e2) {
        notify(t('unescape_fail', e2.message));
        return;
      }
    }
    if (typeof result === 'string') {
      jsonInput.value = result;
      updateCounter();
      doFormat();
      notify(t('unescaped', state.depth));
    } else {
      jsonInput.value = JSON.stringify(result, null, 2);
      updateCounter();
      doFormat();
      notify(t('unescaped', state.depth));
    }
  }

  /* ---------- 操作映射 ---------- */
  var ACTIONS = {
    format: function () { doFormat(true); },
    compress: doCompress,
    escape: doEscape,
    unescape: doUnescape,
    collapse: function () {
      ensureFormatted();
      if (!state.root) { notify(t('fmt_first')); return; }
      if (state.root.children) setExpandedToDepth(state.root, 0, 0);
      setActiveLevel(null);
      renderTree();
      notify(t('collapsed_all'));
    },
    expand: function () {
      ensureFormatted();
      if (!state.root) { notify(t('fmt_first')); return; }
      if (state.root.children) setExpandedToDepth(state.root, 0, FULL_EXPAND);
      setActiveLevel(null);
      renderTree();
      notify(t('expanded_all', state.depth));
    },
    clear: function () {
      jsonInput.value = '';
      updateCounter();
      jsonOutput.innerHTML = '';
      state.root = null;
      state.outputText = '';
      if (levelButtonsEl) levelButtonsEl.innerHTML = '';
    },
    copy: function () {
      ctxTarget = 'output';
      var text = state.outputText || jsonOutput.textContent;
      if (!text) { notify(t('no_copy')); return; }
      var btn = document.querySelector('[data-action="copy"]');
      copyText(text)
        .then(function () { if (btn) flashBtn(btn, true); else notify(t('copied_all')); })
        .catch(function () { if (btn) flashBtn(btn, false); else notify(t('copy_fail_manual')); });
    },
    'copy-input': function () {
      var text = jsonInput.value;
      if (!text) { notify(t('no_copy')); return; }
      var btn = document.querySelector('[data-action="copy-input"]');
      copyText(text)
        .then(function () { if (btn) flashBtn(btn, true); else notify(t('copied_raw')); })
        .catch(function () { if (btn) flashBtn(btn, false); else notify(t('copy_fail')); });
    },
    save: doSave,
    import: function () {
      if (fileInput) fileInput.click();
      else notify(t('no_file_picker'));
    }
  };

  /* ---------- 导出 JSON：文件名默认为当前时间 ----------
     优先走宿主 window.dbxPlugin.saveFile({fileName, contentType}, bytes)（真落盘）；
     宿主不支持时回退浏览器下载（dev 宿主）。
     ------------------------------------------------------------ */
  function doSave() {
    var raw = jsonInput.value.trim();
    if (!raw) { notify(t('no_save')); return; }

    // 优先保存格式化后的完整文本；无法解析则保存原始文本
    var text = raw;
    var pretty = false;
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2) + '\n';
      pretty = true;
    } catch (e) { /* 保存原文 */ }

    var filename = defaultFileName();

    saveTextFile(filename, text).then(function (saved) {
      var tail = pretty ? '' : t('saved_raw_tail');
      var where = saved ? ' → ' + saved : '';
      notify(t('saved', filename + where) + tail);
    }).catch(function (err) {
      notify(t('save_fail', (err && err.message) || 'unknown'));
    });
  }

  // 保存文本文件；resolve(pathOrName) / reject(err)
  // 与官方参考一致：宿主 saveFile 优先，失败回退浏览器下载
  function saveTextFile(fileName, text) {
    var contentType = 'application/json;charset=utf-8';
    var bytes = new TextEncoder().encode(text);

    var hostSave = (dbx && typeof dbx.saveFile === 'function')
      ? dbx.saveFile({ fileName: fileName, contentType: contentType }, bytes)
      : null;

    return Promise.resolve(hostSave).then(function (result) {
      if (result && result.path) return result.path;
      // 宿主不可用或未返回路径 → 浏览器下载兜底
      return browserDownload(fileName, bytes, contentType);
    }).catch(function () {
      return browserDownload(fileName, bytes, contentType);
    });
  }

  // 浏览器原生下载（dev 宿主 / 无 saveFile 的宿主）
  function browserDownload(fileName, bytes, contentType) {
    var url = URL.createObjectURL(new Blob([bytes], { type: contentType || 'application/octet-stream' }));
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName || 'download';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    return fileName || null;
  }

  // 文件名默认：YYYYMMDD-HHmmss.json
  function defaultFileName() {
    var d = new Date();
    var p = function (v) { return ('0' + v).slice(-2); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.json';
  }

  /* ---------- 输入防抖重排 ---------- */
  var timer = null;
  function scheduleAuto() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      if (!jsonInput.value.trim()) {
        jsonOutput.innerHTML = '';
        state.root = null;
        state.outputText = '';
        if (levelButtonsEl) levelButtonsEl.innerHTML = '';
        return;
      }
      doFormat();
    }, 320);
  }
})();
