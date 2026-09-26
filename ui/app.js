/* ============================================================
   JSON 格式化工具 - DBX 纯前端插件主逻辑
   - 通过 window.dbxPlugin 桥接宿主（官方 Host API 1）
   - 右侧结果区为虚拟滚动（见 view.js）：DOM 行数恒定，滚动与 JSON 大小无关
   - 大文件自动折叠 + 子节点分页（见 model.js），不一次性建全树
   - 不使用原生 alert/confirm/prompt，不使用 CDN
   ============================================================ */
(function () {
  'use strict';

  var JP = window.JP;
  var Model = JP.Model;
  var View = JP.View;
  var JPWS = window.JP.Workspace;   // 左侧工作区文件树（见 workspace.js）
  var t = JP.t;
  var $ = JP.$;
  var dbx = JP.dbx;

  /* ---------- 常量 ---------- */
  var MIN_COL = 180;            // 单侧最小宽度
  var FALLBACK_RATIO = 0.42;    // 左栏默认占比
  var FULL_EXPAND = Number.MAX_SAFE_INTEGER;
  var AUTO_LIMIT = 400000;      // 超过该字符数暂停自动格式化，改由点「格式化」触发
  var PLAIN_LIMIT = 200000;     // 纯文本模式显示上限（复制仍为完整内容）
  var TARGET_ROWS = 30000;      // 首次渲染的目标行数
  var HARD_ROWS = 200000;       // 「全部展开」的行数上限
  var MAX_LEVEL_BUTTONS = 10;

  /* ---------- 无损大整数处理 ---------- */
  var BIGINT_PREFIX = 'JPBIG_';

  function losslessParse(text) {
    // 将 >= 16 位的 JSON 整数包裹成字符串，避免 JSON.parse 精度丢失
    // 正则：匹配 ^ [ , : 之后的大整数，后面跟着 ] } , 或结尾（用前瞻，不消耗定界符）
    var wrapped = text.replace(
      /((?:^|[\[,:])\s*)(-?\d{16,})(?=\s*(?:[\]},]|$))/g,
      '$1"' + BIGINT_PREFIX + '$2"'
    );
    return JSON.parse(wrapped);
  }

  function losslessStringify(data, space) {
    var json = JSON.stringify(data, null, space);
    // 还原包裹的大整数："JPBIG_1234567890123456" → 1234567890123456
    return json.replace(new RegExp('"' + BIGINT_PREFIX + '(-?\\d+)"', 'g'), '$1');
  }

  /* ---------- 状态 ---------- */
  var state = {
    root: null,        // 当前 JSON 层级树根节点（子节点懒构建）
    outputText: '',    // 完整格式化文本（用于复制，不随折叠变化）
    stats: null,       // { depth, keys, items, nodes, byDepth, truncated }
    autoOff: false     // 是否已因内容过大暂停自动格式化
  };

  /* ---------- 元素引用 ---------- */
  var jsonInput, jsonOutput, inputCounter, splitEl, resizerEl, levelButtonsEl, ctxMenu;
  var jvCanvas, jvRows, jvPlain;
  var treePane, treeList, resizerTree;
  var wsToggleBtn, wsStateIcon, wsSaveToggle;
  var timer = null;
  var saveTimer = null;
  var ctxTarget = null;
  var dirty = false;        // 编辑区自上次载入/保存后是否被改过
  var saveWarned = false;   // 内容超限时只提示一次，避免每次输入都弹
  // 注意：这里不能用 FALLBACK_RATIO 初始化 —— 常量在下面用 var 声明，
  // 提升到顶部时值还是 undefined，初始化会拿到 undefined。故写字面量。
  var _ratio = 0.42;
  var _treeW = 220;
  var currentLocale = (typeof window.locale === 'function') ? window.locale() : 'en';

  /* ============================================================
     启动
     ============================================================ */
  function boot() {
    cacheEls();
    applyI18n();
    View.init({ host: jsonOutput, canvas: jvCanvas, rows: jvRows, plain: jvPlain });
    View.onToggle = onToggle;
    View.onMore = onMore;
    bindUI();
    initSplitter();
    bindTheme();
    bindLocale();
    updateCounter();
    // 工作区（左侧文件树）：就绪后自动载入上次打开的文件
    JPWS.init({
      list: treeList,
      pane: treePane,
      onOpen: onWorkspaceOpen,
      onLayout: syncLayoutFromPrefs,
      onFlush: flushSave
    });

    initFileDrop();
  }

  /* ---------------- 拖放导入 ---------------- */

  function initFileDrop() {
    var ft = (window.dbxPlugin && window.dbxPlugin.fileTransfer) || null;
    var overlay = document.getElementById('dropOverlay');
    if (!overlay) return;

    // DBX 桌面宿主：使用 fileTransfer API
    if (ft) {
      ft.onDragState(function (active) {
        overlay.hidden = !active;
      });

      ft.onDrop(function (files) {
        overlay.hidden = true;
        if (!files || !files.length) return;
        importDroppedFiles(files, ft);
      });
      return;
    }

    // Web 宿主回退：原生 HTML5 拖放
    var dragCount = 0;

    document.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragCount++;
      if (overlay) overlay.hidden = false;
    });

    document.addEventListener('dragover', function (e) {
      e.preventDefault();
    });

    document.addEventListener('dragleave', function () {
      dragCount--;
      if (dragCount <= 0) {
        dragCount = 0;
        if (overlay) overlay.hidden = true;
      }
    });

    document.addEventListener('drop', function (e) {
      e.preventDefault();
      dragCount = 0;
      if (overlay) overlay.hidden = true;
      var dtFiles = e.dataTransfer && e.dataTransfer.files;
      if (!dtFiles || !dtFiles.length) return;
      for (var i = 0; i < dtFiles.length; i++) {
        readFileInto(dtFiles[i]);
      }
    });
  }

  // DBX 桌面：逐块读取拖入的文件句柄
  function importDroppedFiles(files, ft) {
    var queue = Array.prototype.slice.call(files || []);
    if (!queue.length) return;

    function next() {
      var f = queue.shift();
      if (!f) return;
      readDroppedFile(f, ft)
        .catch(function (e) {
          JP.notify(JP.t('ws_import_fail', (e && e.message) || 'unknown'));
        })
        .then(next);
    }
    next();
  }

  // 通用分块导入：readChunkFn(offset, chunkSize) → Promise<{dataBase64, length, eof}>
  // onFinish() 在所有分块发送完后、endWrite 前被调用（用于 fileTransfer.cancel 等收尾）
  function importFileChunked(name, readChunkFn, onFinish) {
    var CHUNK = 256 * 1024;
    var contentParts = [];
    var nodeId = '';
    var offset = 0;

    // 1) 创建工作区节点
    return JPWS.invoke('jp/createNode', {
      type: 'file',
      name: name,
      parentId: JPWS.currentFolder() || null
    }).then(function (r) {
      var node = r && r.node;
      if (!node) throw new Error('创建文件失败');
      nodeId = node.id;
      // 2) 开始分块写入
      return JPWS.invoke('jp/beginWrite', { id: nodeId });
    }).then(function () {
      // 3) 逐块读取并推给后端
      function readNext() {
        return readChunkFn(offset, CHUNK).then(function (chunk) {
          var p = Promise.resolve();
          if (chunk.dataBase64) {
            var binary = atob(chunk.dataBase64);
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            contentParts.push(new TextDecoder('utf-8').decode(bytes));
            p = JPWS.invoke('jp/appendChunk', { id: nodeId, content: chunk.dataBase64 });
          }
          if (chunk.eof) { return p; }
          return p.then(function () {
            offset += chunk.length;
            return readNext();
          });
        });
      }
      return readNext();
    }).then(function () {
      // 收尾（fileTransfer.cancel 等）
      return onFinish ? onFinish() : Promise.resolve();
    }).then(function () {
      // 4) 结束写入并落盘
      return JPWS.invoke('jp/endWrite', { id: nodeId });
    }).then(function () {
      // 5) 加载到编辑区并刷新工作区树
      var content = contentParts.join('');
      return JPWS.finishChunkedImport(nodeId, name, content);
    }).catch(function (e) {
      if (nodeId) {
        JPWS.invoke('jp/deleteNode', { id: nodeId }).catch(function () {});
      }
      throw e;
    });
  }

  // 桌端拖放：复用通用分块、用 fileTransfer.read 做 chunk 源
  function readDroppedFile(file, ft) {
    return importFileChunked(file.name || 'untitled.json',
      function (offset, size) {
        return ft.read(file.handleId, offset, size);
      },
      function () {
        return ft.cancel(file.handleId);
      }
    );
  }

  // 导入按钮用：File.slice() + FileReader.readAsDataURL 模拟分块读
  function readBlobChunked(file) {
    return importFileChunked(file.name,
      function (offset, size) {
        return new Promise(function (resolve, reject) {
          var slice = file.slice(offset, offset + size);
          var reader = new FileReader();
          reader.onload = function () {
            var dataUrl = String(reader.result || '');
            var comma = dataUrl.indexOf(',');
            var b64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
            resolve({ dataBase64: b64, length: slice.size, eof: offset + size >= file.size });
          };
          reader.onerror = function () {
            reject(new Error((reader.error && reader.error.message) || '读取文件失败'));
          };
          reader.readAsDataURL(slice);
        });
      }
    );
  }

  // 工作区把某个文件的内容交给编辑区
  function onWorkspaceOpen(node, content) {
    dirty = false;
    saveWarned = false;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    jsonInput.value = content || '';
    updateCounter();
    if (jsonInput.value.trim()) doFormat(false, false);
    else clearAll();
  }

  function cacheEls() {
    jsonInput = $('jsonInput');
    jsonOutput = $('jsonOutput');
    inputCounter = $('inputCounter');
    splitEl = $('split');
    resizerEl = $('resizer');
    levelButtonsEl = $('levelButtons');
    ctxMenu = $('ctxMenu');
    jvCanvas = $('jvCanvas');
    jvRows = $('jvRows');
    jvPlain = $('jvPlain');
    treePane = $('treePane');
    treeList = $('treeList');
    resizerTree = $('resizerTree');
    wsToggleBtn = $('wsToggleBtn');
    wsStateIcon = $('wsStateIcon');
    wsSaveToggle = $('wsSaveToggle');
  }

  if (dbx && dbx.ready && typeof dbx.ready.then === 'function') {
    dbx.ready.then(boot).catch(boot);
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ============================================================
     国际化
     ============================================================ */
  function applyI18n() {
    currentLocale = (typeof window.locale === 'function') ? window.locale() : currentLocale;
    document.documentElement.setAttribute('lang', currentLocale);

    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
  }

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
    updateCounter();
    renderLevelButtons();
    View.refresh();
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bindUI() {
    jsonInput.addEventListener('input', function () {
      dirty = true;
      updateCounter();
      scheduleAuto();
      scheduleSave();
    });

    // 统一事件委托：工具栏 / 层级按钮
    document.addEventListener('click', function (e) {
      var lvlBtn = e.target.closest && e.target.closest('.lvl-btn');
      if (lvlBtn) { onLevelClick(parseInt(lvlBtn.dataset.level, 10)); return; }

      var btn = e.target.closest && e.target.closest('button[data-action]');
      if (!btn) return;
      if (ACTIONS[btn.dataset.action]) ACTIONS[btn.dataset.action]();
    });

    // 双击复制：优先复制选中的文本；无选中则复制双击所在行的 JSON 值
    jsonOutput.addEventListener('dblclick', function (e) {
      var sel = window.getSelection && window.getSelection();
      var text = (sel && !sel.isCollapsed) ? sel.toString() : '';
      if (!text) {
        var rowEl = e.target.closest ? e.target.closest('.jv-row') : null;
        var entry = rowEl ? View.entryAt(rowEl.__i) : null;
        if (!entry) { JP.notify(t('sel_or_dbl')); return; }
        text = Model.serialize(entry.node);
      }
      if (!text) return;
      JP.copyText(text)
        .then(function () { JP.notify(t('copied_sel')); })
        .catch(function () { JP.notify(t('copy_fail_manual')); });
    });

    // 「保存」开关：默认关闭（用完即走）。开启后导入 / 粘贴的内容都会落盘。
    if (wsSaveToggle) {
      wsSaveToggle.addEventListener('change', function () {
        JPWS.setSaveEnabled(wsSaveToggle.checked);
        // 刚开启：把编辑区里已有的内容也存下来，让开关立刻生效而不是等下次输入
        if (wsSaveToggle.checked) { dirty = true; scheduleSave(); }
      });
    }

    bindContextMenu();

    // 关页面前把最后一次编辑写回工作区
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushSave();
    });
  }

  /* ============================================================
     导入文件
     ============================================================ */
  function loadFromFile(name, content) {
    content = content.replace(/^\uFEFF/, '');

    // 不管工作区是否可用，太大先拦
    var maxBytes = JPWS.MAX_SAVE_BYTES();
    var fileBytes = typeof TextEncoder !== 'undefined'
      ? (function () { try { return new TextEncoder().encode(content).length; } catch (e) { return content.length; } })()
      : content.length;
    if (fileBytes > maxBytes) {
      JP.notify(JP.t('ws_too_large', Math.round(fileBytes / 1024), Math.round(maxBytes / 1024)));
      return;
    }

    // 开了「保存」：导入 = 在工作区当前目录下新建一个文件并打开，之后编辑自动存回去
    if (JPWS.available() && JPWS.saveEnabled()) {
      var base = name.replace(/\.[^.]+$/, '') || name;
      JPWS.importFile(base + '.json', content, JPWS.currentFolder()).then(function (node) {
        if (!node) return;
        var st = state.stats || { depth: 0, keys: 0, items: 0 };
        JP.notify(t('loaded', node.name, st.depth, JP.fmtNum(st.keys), JP.fmtNum(st.items)));
      });
      return;
    }

    // 无侧车（不在 DBX 工作台 / 侧车没起来）：退回原行为，只填进编辑区
    jsonInput.value = content;
    updateCounter();
    var data;
    try {
      data = losslessParse(content);
    } catch (e) {
      state.root = null;
      state.stats = null;
      state.outputText = '';
      View.setPlain(t('json_err', e.message), true);
      JP.notify(t('loaded_err', name, e.message));
      return;
    }
    doFormat(false, true, data);
    JP.notify(t('loaded', name,
      state.stats ? state.stats.depth : 0,
      state.stats ? JP.fmtNum(state.stats.keys) : 0,
      state.stats ? JP.fmtNum(state.stats.items) : 0));
  }

  function readFileInto(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var content = String(reader.result == null ? '' : reader.result);
      loadFromFile(file.name, content);
    };
    reader.onerror = function () {
      JP.notify(t('file_read_fail', (reader.error && reader.error.message) || 'unknown'));
    };
    reader.readAsText(file);
  }

  /* ============================================================
     右键上下文菜单
     ============================================================ */
  function bindContextMenu() {
    if (!ctxMenu) return;

    [jsonInput, jsonOutput].forEach(function (el) {
      el.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        ctxTarget = (el === jsonInput) ? 'input' : 'output';
        showCtxMenu(e.clientX, e.clientY);
      });
    });

    ctxMenu.addEventListener('click', function (e) {
      var item = e.target.closest('.ctx-item');
      if (!item) return;
      handleCtx(item.dataset.act);
      hideCtxMenu();
    });
    document.addEventListener('click', function () { hideCtxMenu(); });
    window.addEventListener('scroll', function () { hideCtxMenu(); }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideCtxMenu(); });
  }

  function showCtxMenu(x, y) {
    ctxMenu.hidden = false;
    // 粘贴 / 清空 只在左侧编辑区（textarea）可用，右侧查看区不提供
    var pasteBtn = ctxMenu.querySelector('[data-act="paste"]');
    if (pasteBtn) pasteBtn.hidden = (ctxTarget !== 'input');
    var clearBtn = ctxMenu.querySelector('[data-act="clear-input"]');
    if (clearBtn) clearBtn.hidden = (ctxTarget !== 'input');
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
    if (act === 'paste') { doPaste(); return; }
    if (act === 'clear-input') { ACTIONS.clear(); return; }
    if (act !== 'copy-sel') return;
    var sel;
    if (ctxTarget === 'input') {
      sel = jsonInput.value.substring(jsonInput.selectionStart, jsonInput.selectionEnd);
    } else {
      sel = window.getSelection().toString();
    }
    if (sel && sel.trim()) {
      JP.copyText(sel)
        .then(function () { JP.notify(t('copied_sel_ok')); })
        .catch(function () { JP.notify(t('copy_fail')); });
    } else {
      copyAll();
    }
  }

  function copyAll() {
    var text = (ctxTarget === 'input') ? jsonInput.value : (state.outputText || jsonOutput.textContent);
    if (!text) { JP.notify(t('no_copy')); return; }
    JP.copyText(text)
      .then(function () { JP.notify(t('copied_all')); })
      .catch(function () { JP.notify(t('copy_fail_manual')); });
  }

  function doPaste() {
    var dbx = JP.dbx;
    // 宿主读：需要 capabilities.clipboardRead（host.clipboard:read 权限）
    if (dbx && (dbx.capabilities || {}).clipboardRead && dbx.clipboard && typeof dbx.clipboard.readText === 'function') {
      dbx.clipboard.readText().then(function (text) {
        if (text) insertAtCursor(text);
      }).catch(function () {
        // 被拒绝（缺权限 / Web 宿主无原生剪贴板）→ 回落到键盘粘贴
        pasteFallback();
      });
      return;
    }
    pasteFallback();
  }

  function pasteFallback() {
    // 浏览器原生 clipboard（沙箱内通常不可用，仅兜底）
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      navigator.clipboard.readText().then(function (text) {
        if (text) insertAtCursor(text);
      }).catch(function () {});
      return;
    }
    // 键盘粘贴路径
    jsonInput.focus();
    try { document.execCommand('paste'); } catch (e) {}
  }

  function insertAtCursor(text) {
    var start = jsonInput.selectionStart;
    var end = jsonInput.selectionEnd;
    var before = jsonInput.value.substring(0, start);
    var after = jsonInput.value.substring(end);
    jsonInput.value = before + text + after;
    var newPos = start + text.length;
    jsonInput.setSelectionRange(newPos, newPos);
    dirty = true;
    scheduleRender();
    jsonInput.focus();
  }

  /* ============================================================
     左右可拖动分栏
     ============================================================ */
  function initSplitter() {
    applyLayout();
    bindTreeResizer();

    var dragging = false;

    function onMove(e) {
      if (!dragging) return;
      var rect = splitEl.getBoundingClientRect();
      var x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      var left = JPWS.collapsed() ? 0 : (_treeW + 6);
      var w = Math.max(1, rect.width - left);
      _ratio = JP.clamp((x - left) / w, MIN_COL / w, 1 - MIN_COL / w);
      applyLayout();
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
      JPWS.setSplitRatio(_ratio);
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

  // 工作区宽度拖柄
  function bindTreeResizer() {
    var dragging = false;

    function onMove(e) {
      if (!dragging) return;
      var rect = splitEl.getBoundingClientRect();
      var x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      _treeW = JP.clamp(x, 160, 560);
      applyLayout();
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
      JPWS.setTreeWidth(_treeW);
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

    resizerTree.addEventListener('mousedown', onDown);
    resizerTree.addEventListener('touchstart', onDown, { passive: false });
  }

  // 三栏：工作区 | 拖柄 | 原文 || 拖柄 || 结果
  // 收起时工作区整块隐藏（不留窄栏），右侧拿到全部宽度。
  function applyLayout() {
    var r = JP.clamp(_ratio, 0.1, 0.9);
    var main = 'minmax(0, ' + (r * 100).toFixed(3) + 'fr) 8px minmax(0, ' + ((1 - r) * 100).toFixed(3) + 'fr)';
    var collapsed = JPWS.collapsed();

    treePane.hidden = collapsed;
    resizerTree.hidden = collapsed;

    // 注意：display:none 的 grid 子项不参与排布 —— 收起时列数必须真的少两列，
    // 否则剩下的 3 个可见项会依次占前 3 列，左右两栏被挤成 1fr + 8px。
    splitEl.style.gridTemplateColumns = collapsed
      ? main
      : (_treeW + 'px 6px ' + main);

    syncWsToggle();
    View.refresh();
  }

  // 工具栏「工作区」按钮：« = 当前展开（点了收起） / » = 当前收起（点了展开）
  var _lastWsIconState = null;
  function syncWsToggle() {
    var collapsed = JPWS.collapsed();
    if (collapsed === _lastWsIconState) return;
    _lastWsIconState = collapsed;
    if (wsToggleBtn) {
      wsToggleBtn.classList.toggle('is-collapsed', collapsed);
      wsToggleBtn.title = collapsed ? t('ws_expand_title') : t('ws_collapse_title');
    }
    if (wsStateIcon) wsStateIcon.textContent = collapsed ? '》' : '《';
  }

  // 工作区就绪 / 收起状态变化后，用后端保存的偏好重算布局
  function syncLayoutFromPrefs() {
    var r = JPWS.splitRatio();
    _ratio = (typeof r === 'number') ? JP.clamp(r, 0.1, 0.9) : FALLBACK_RATIO;
    _treeW = JPWS.treeWidth();
    if (wsSaveToggle) wsSaveToggle.checked = JPWS.saveEnabled();
    applyLayout();
  }

  /* ============================================================
     主题适配
     ============================================================ */
  function bindTheme() {
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
     格式化 / 渲染
     ============================================================ */
  function parseInput() {
    var raw = jsonInput.value.trim();
    if (!raw) throw new Error(t('input_empty'));
    return losslessParse(raw);
  }

  /**
   * @param {boolean} manual   用户主动触发（点按钮）：成功/失败都通知
   * @param {boolean} announce 是否播报「已自动折叠」提示
   * @param {*}       data     已解析好的数据（导入文件时复用，避免二次 parse）
   */
  function doFormat(manual, announce, data) {
    var raw = jsonInput.value.trim();
    if (!raw) { clearAll(); return; }

    var d = data;
    if (d === undefined) {
      try { d = parseInput(); }
      catch (e) {
        state.root = null;
        state.stats = null;
        state.outputText = '';
        View.setPlain(t('json_err', e.message), true);
        if (manual) JP.notify(t('json_err', e.message));
        return;
      }
    }

    state.outputText = losslessStringify(d, 2);
    state.stats = Model.collectStats(d);
    state.root = Model.createNode(d, null);
    renderLevelButtons();

    var lv = levelForRows(state.stats, TARGET_ROWS);
    applyLevel(lv, true);

    if (manual) {
      syncInputPretty(state.outputText);
      JP.notify(t('formatted'));
    }
    if (announce && lv !== FULL_EXPAND) {
      JP.notify(t('big_auto', JP.fmtNum(state.stats.nodes), lv));
    }
  }

  /**
   * 估算「展开到第 L 层」会产出多少行，挑一个不超过 target 的最深层。
   * 估算要考虑子节点分页：单个容器最多渲染 Model.PAGE 个子节点。
   */
  function levelForRows(st, target) {
    if (!st || !st.depth) return FULL_EXPAND;

    var total = 0;
    var level = 0;
    var renderedCont = 0;   // 上一层实际渲染出来的容器数

    for (var d = 1; d <= st.depth; d++) {
      var nodesHere = st.byDepth[d] || 0;
      var contHere = st.byDepthCont[d] || 0;
      var shown, extra;

      if (d === 1) {
        shown = 1;
        extra = 0;
      } else {
        var prev = st.byDepth[d - 1] || 1;
        var perContainer = Math.min(Model.PAGE, Math.max(1, Math.round(nodesHere / prev)));
        shown = Math.min(nodesHere, renderedCont * perContainer);
        extra = renderedCont * 2;         // 「加载更多」行 + 收口行
      }

      if (total + shown + extra > target) break;
      total += shown + extra;
      level = d - 1;
      renderedCont = nodesHere > 0
        ? Math.min(contHere, Math.round(contHere * shown / nodesHere))
        : 0;
    }

    if (!st.truncated && level >= st.depth - 1) return FULL_EXPAND;
    return level < 1 ? 1 : level;
  }

  function applyLevel(lv, quiet) {
    if (!state.root) return;
    Model.setExpandedToDepth(state.root, 0, lv);
    View.setTree(Model.flatten(state.root));
    setActiveLevel(lv === FULL_EXPAND ? null : lv);
    if (!quiet) {
      if (lv === FULL_EXPAND) JP.notify(t('expanded_all', state.stats ? state.stats.depth : 0));
      else JP.notify(t('expanded_to', lv));
    }
  }

  function rebuild() {
    if (!state.root) return;
    View.setTree(Model.flatten(state.root));
  }

  // 点击折叠箭头
  function onToggle(e) {
    var n = e.node;
    if (!Model.isContainer(n)) return;
    n.expanded = !n.expanded;
    if (n.expanded) Model.ensureChildren(n, Model.childLimit(n));
    rebuild();
  }

  // 点击「加载更多」：把该容器的子节点上限再翻一页
  function onMore(e) {
    var n = e.node;
    n.limit = (n.limit || Model.PAGE) + Model.PAGE;
    rebuild();
  }

  function clearAll() {
    state.root = null;
    state.stats = null;
    state.outputText = '';
    View.clear();
    if (levelButtonsEl) levelButtonsEl.innerHTML = '';
  }

  /* ============================================================
     层级展开按钮
     ============================================================ */
  function renderLevelButtons() {
    if (!levelButtonsEl) return;
    levelButtonsEl.innerHTML = '';
    if (!state.stats) return;
    var max = Math.min(state.stats.depth, MAX_LEVEL_BUTTONS);
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
    ensureFormatted();
    if (!state.root) { JP.notify(t('fmt_first')); return; }
    if (lv === 0) expandAll();
    else applyLevel(lv, false);
  }

  function expandAll() {
    if (!state.root) { JP.notify(t('fmt_first')); return; }
    var lv = levelForRows(state.stats, HARD_ROWS);
    if (lv === FULL_EXPAND) {
      applyLevel(FULL_EXPAND, false);
    } else {
      applyLevel(lv, true);
      JP.notify(t('expand_limited', lv));
    }
  }

  function ensureFormatted() {
    if (state.root) return;
    if (!jsonInput.value.trim()) return;
    doFormat(false, false);
  }

  function setActiveLevel(lv) {
    if (!levelButtonsEl) return;
    levelButtonsEl.querySelectorAll('.lvl-btn').forEach(function (b) {
      var bl = parseInt(b.dataset.level, 10);
      if (lv === null) b.classList.remove('active');
      else b.classList.toggle('active', bl === lv);
    });
  }

  /* ============================================================
     左侧同步为格式化文本（仅手动格式化时执行）
     JSON 美化只插入空白、不改变非空白字符顺序，故用「光标前非空白字符数」
     做映射即可让光标大致停在同一逻辑位置。
     ============================================================ */
  function syncInputPretty(pretty) {
    if (jsonInput.value === pretty) return;
    var cur = jsonInput.value;
    var focused = (document.activeElement === jsonInput);
    var selStart = jsonInput.selectionStart;
    var selEnd = jsonInput.selectionEnd;
    var atEnd = (selEnd >= cur.length);
    var lStart = JP.caretLogicalPos(cur, selStart);
    var lEnd = JP.caretLogicalPos(cur, selEnd);

    jsonInput.value = pretty;
    updateCounter();

    if (focused) {
      var s = atEnd ? pretty.length : JP.posFromLogical(pretty, lStart);
      var e = atEnd ? pretty.length : JP.posFromLogical(pretty, lEnd);
      try { jsonInput.setSelectionRange(s, e); } catch (err) { /* 忽略 */ }
    }
  }

  /* ============================================================
     纯文本模式（压缩 / 转义 / 错误）
     ============================================================ */
  function clipPlain(text) {
    if (text.length > PLAIN_LIMIT) return text.slice(0, PLAIN_LIMIT) + t('plain_trunc', JP.fmtNum(PLAIN_LIMIT));
    return text;
  }

  /* ============================================================
     操作
     ============================================================ */
  function doCompress() {
    var data;
    try { data = parseInput(); }
    catch (e) { JP.notify(t('json_err', e.message)); return; }
    var mini = losslessStringify(data);
    state.root = null;
    state.outputText = mini;
    View.setPlain(clipPlain(mini), false);
    JP.notify(t('compressed', JP.fmtNum(mini.length)));
  }

  function doEscape() {
    var raw = jsonInput.value.trim();
    if (!raw) { JP.notify(t('input_empty')); return; }
    var escaped = JSON.stringify(raw);
    state.root = null;
    state.outputText = escaped;
    View.setPlain(clipPlain(escaped), false);
    JP.notify(t('escaped'));
  }

  function doUnescape() {
    var raw = jsonInput.value.trim();
    if (!raw) { JP.notify(t('input_empty')); return; }
    var result;
    try {
      result = losslessParse(raw);
    } catch (e1) {
      try {
        result = JSON.parse('"' + raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
      } catch (e2) {
        JP.notify(t('unescape_fail', e2.message));
        return;
      }
    }
    jsonInput.value = (typeof result === 'string') ? result : losslessStringify(result, 2);
    updateCounter();
    doFormat(false, false, result);
    JP.notify(t('unescaped', state.stats ? state.stats.depth : 0));
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

  var ACTIONS = {
    format: function () { doFormat(true, true); },
    compress: doCompress,
    escape: doEscape,
    unescape: doUnescape,
    collapse: function () {
      ensureFormatted();
      if (!state.root) { JP.notify(t('fmt_first')); return; }
      applyLevel(0, true);
      setActiveLevel(null);
      JP.notify(t('collapsed_all'));
    },
    expand: function () {
      ensureFormatted();
      if (!state.root) { JP.notify(t('fmt_first')); return; }
      expandAll();
    },
    // 「清空」只清编辑区与结果区，不写回工作区文件 —— 避免一次误点把文件内容抹掉，
    // 重新点一下树里的文件即可恢复。
    clear: function () {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      dirty = false;
      jsonInput.value = '';
      updateCounter();
      clearAll();
    },
    copy: function () {
      ctxTarget = 'output';
      var text = state.outputText || jsonOutput.textContent;
      if (!text) { JP.notify(t('no_copy')); return; }
      var btn = document.querySelector('[data-action="copy"]');
      JP.copyText(text)
        .then(function () { if (btn) flashBtn(btn, true); else JP.notify(t('copied_all')); })
        .catch(function () { if (btn) flashBtn(btn, false); else JP.notify(t('copy_fail_manual')); });
    },
    'copy-input': function () {
      var text = jsonInput.value;
      if (!text) { JP.notify(t('no_copy')); return; }
      var btn = document.querySelector('[data-action="copy-input"]');
      JP.copyText(text)
        .then(function () { if (btn) flashBtn(btn, true); else JP.notify(t('copied_raw')); })
        .catch(function () { if (btn) flashBtn(btn, false); else JP.notify(t('copy_fail')); });
    },
    // ---- 工作区（左侧文件树）----
    'ws-toggle': function () { JPWS.toggleCollapsed(); }
  };

  /* ============================================================
     导出 JSON
     ============================================================ */
  function doSave() {
    var raw = jsonInput.value.trim();
    if (!raw) { JP.notify(t('no_save')); return; }

    var text = raw;
    var pretty = false;
    try {
      text = losslessStringify(losslessParse(raw), 2) + '\n';
      pretty = true;
    } catch (e) { /* 保存原文 */ }

    var filename = JP.defaultFileName();
    saveTextFile(filename, text).then(function (saved) {
      var tail = pretty ? '' : t('saved_raw_tail');
      var where = saved ? ' → ' + saved : '';
      JP.notify(t('saved', filename + where) + tail);
    }).catch(function (err) {
      JP.notify(t('save_fail', (err && err.message) || 'unknown'));
    });
  }

  function saveTextFile(fileName, text) {
    var contentType = 'application/json;charset=utf-8';
    var bytes = new TextEncoder().encode(text);
    var hostSave = (dbx && typeof dbx.saveFile === 'function')
      ? dbx.saveFile({ fileName: fileName, contentType: contentType }, bytes)
      : null;

    return Promise.resolve(hostSave).then(function (result) {
      if (result && result.path) return result.path;
      return browserDownload(fileName, bytes, contentType);
    }).catch(function () {
      return browserDownload(fileName, bytes, contentType);
    });
  }

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

  // 文件名统一走 JP.defaultFileName()（见 core.js）：导出、自动保存、新建文件共用一份生成规则

  /* ============================================================
     杂项
     ============================================================ */
  function updateCounter() {
    if (inputCounter) inputCounter.textContent = JP.fmtNum(jsonInput.value.length) + t('chars');
  }

  // 输入防抖自动格式化；内容过大时暂停，改由手动触发
  function scheduleAuto() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      var v = jsonInput.value;
      if (!v.trim()) { clearAll(); return; }
      if (v.length > AUTO_LIMIT) {
        if (!state.autoOff) {
          state.autoOff = true;
          JP.notify(t('auto_off', JP.fmtNum(AUTO_LIMIT)));
        }
        return;
      }
      state.autoOff = false;
      doFormat(false, false);
    }, 320);
  }

  /* ---------- 自动保存回工作区 ----------
     两道闸：1) 真的改过（dirty）；2) 「保存」开关是开的。
     没有目标文件时先建一个（不动编辑区），再把内容写进去。 */
  function scheduleSave() {
    if (!dirty) return;
    if (!JPWS.saveEnabled()) return;

    var bytes = JPWS.byteLength(jsonInput.value);
    if (bytes > JPWS.MAX_SAVE_BYTES()) {
      if (!saveWarned) {
        saveWarned = true;
        JP.notify(t('ws_too_large',
          Math.round(bytes / 1024),
          Math.round(JPWS.MAX_SAVE_BYTES() / 1024)));
      }
      return;
    }
    saveWarned = false;

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      if (!dirty || !JPWS.saveEnabled()) return;
      var text = jsonInput.value;
      if (!text.trim()) return;
      JPWS.ensureFile(JP.defaultFileName()).then(function (node) {
        if (!node) return;
        return JPWS.writeFile(node.id, text).then(function (ok) {
          if (ok) dirty = false;
        });
      });
    }, 600);
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty || !JPWS.saveEnabled()) return;
    var text = jsonInput.value;
    if (!text.trim()) return;
    var cur = JPWS.activeId();
    if (cur) { JPWS.writeFile(cur, text); return; }
    JPWS.ensureFile(JP.defaultFileName()).then(function (node) {
      if (node) JPWS.writeFile(node.id, text);
    });
  }
})();
