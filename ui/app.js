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
  // 「全部展开」的行数上限：300k 行的虚拟列表实测 ~110ms 建成、内存与画图都可控，
  // 主要约束是行容器总高度（行数 × 22px）不能逼近浏览器的元素高度上限（Chrome 约 3350 万 px）
  var HARD_ROWS = 400000;
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
    data: null,        // 当前口径的整份数据（嵌套解析开关来回切要用）
    outputText: '',    // 完整格式化文本（用于复制，不随折叠变化）
    stats: null,       // { depth, keys, items, nodes, byDepth, truncated }
    autoOff: false     // 是否已因内容过大暂停自动格式化
  };

  /* ---------- 元素引用 ---------- */
  var jsonInput, jsonOutput, inputCounter, splitEl, resizerEl, levelButtonsEl, ctxMenu;
  var jvCanvas, jvRows, jvPlain;
  var treePane, treeList, resizerTree;
  var wsToggleBtn, wsStateIcon, wsSaveToggle;
  var searchBox, searchInput, searchCount, searchClear;
  var deepParseToggle;
  var rowCopyBtn = null, hoverRow = null;   // 行 hover 浮动复制按钮（全局只有一个实例）
  var selecting = false;                    // 鼠标按下拖选中：期间不出按钮
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
    Model.parseText = losslessParse;   // 模型层做嵌套解析时用同一套无损解析（保住大整数）
    View.init({ host: jsonOutput, canvas: jvCanvas, rows: jvRows, plain: jvPlain });
    View.onToggle = onToggle;
    View.onMore = onMore;
    bindUI();
    bindSearch();
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

    JP.showLoading();

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
      JP.hideLoading();
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
    // 嵌套解析是「这一个文件我想这么看」的临时口径，不该被下一个文件继承 —— 切文件一律拨回关闭
    setDeepParse(false);
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
    searchBox = $('searchBox');
    searchInput = $('searchInput');
    searchCount = $('searchCount');
    searchClear = $('searchClear');
    deepParseToggle = $('deepParseToggle');
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


    /* ---------- 行 hover 浮动复制按钮 ----------
       按钮挂进 hover 的那一行 DOM（.jv-row 自带 position: relative），left 由行的
       padding-left 推出，所以滚动 / 软换行 / 层级缩进都不用自己算坐标。
       代价：行 DOM 是虚拟滚动池化复用的，同一份 DOM 换个 __i 就代表另一条数据了 ——
       所以窗口一重排（View.onRender）或鼠标离开，必须立刻把按钮摘下来。 */
    jsonOutput.addEventListener('mousemove', function (e) {
      if (selecting) {
        // 正在拖着框选文本：不打扰。e.buttons 已归零说明是在窗口外松的手（收不到 mouseup），自愈
        if (e.buttons) return;
        selecting = false;
      }
      // 悬在按钮自己身上时，closest 命中的还是它所在的那一行
      var row = e.target.closest ? e.target.closest('.jv-row') : null;
      if (!row) { hideRowCopy(); return; }
      if (row === hoverRow) return;          // 同一行里移动只算一次
      hoverRow = row;
      showRowCopy(row);
    });
    jsonOutput.addEventListener('mouseleave', hideRowCopy);
    jsonOutput.addEventListener('mousedown', function (e) {
      // 按在按钮上不能把它摘掉：元素一离开 DOM，mouseup 就凑不出 click，复制永远不执行
      if (rowCopyBtn && rowCopyBtn.contains(e.target)) return;
      selecting = true;
      hideRowCopy();
    });
    window.addEventListener('mouseup', function () { selecting = false; });
    View.onRender = hideRowCopy;

    function ensureRowCopyBtn() {
      if (rowCopyBtn) return rowCopyBtn;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'row-copy';
      btn.tabIndex = -1;                                 // 不抢 Tab 焦点
      btn.setAttribute('data-i18n-title', 'row_copy');   // 切换语言时 applyI18n 会统一重刷 title
      btn.setAttribute('title', t('row_copy'));
      btn.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">'
        + '<path d="M5.6 2.6h7.2v8.6H5.6z" fill="none" stroke="currentColor" stroke-width="1.2"/>'
        + '<path d="M10.4 13.4H2.8V5.8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();     // 别冒泡到行的折叠 / 展开委托上去
        doCopyRow(hoverRow);
      });
      rowCopyBtn = btn;
      return btn;
    }

    function doCopyRow(row) {
      var entry = row ? View.entryAt(row.__i) : null;
      var text = entry ? (Model.rowCopyText(entry) || '') : '';
      if (!text) return;
      JP.copyText(text)
        .then(function () { JP.notify(t('copied_row')); })
        .catch(function () { JP.notify(t('copy_fail_manual')); });
    }

    function showRowCopy(row) {
      var entry = View.entryAt(row.__i);
      if (!Model.rowCopyable(entry)) return;      // 收口行 } ] 和「还有 N 项」不给按钮
      var btn = ensureRowCopyBtn();
      // 内容起点 = 行的 padding-left（行号槽 + 层级缩进），按钮贴在它左边：17 宽 + 2 间隙
      var indent = parseFloat(row.style.paddingLeft) || 0;
      btn.style.left = Math.max(0, indent - 19) + 'px';
      if (btn.parentNode !== row) row.appendChild(btn);
    }

    function hideRowCopy() {
      hoverRow = null;
      if (rowCopyBtn && rowCopyBtn.parentNode) rowCopyBtn.parentNode.removeChild(rowCopyBtn);
    }

    // 「保存」开关：默认关闭（用完即走）。开启后导入 / 粘贴的内容都会落盘。
    if (wsSaveToggle) {
      wsSaveToggle.addEventListener('change', function () {
        JPWS.setSaveEnabled(wsSaveToggle.checked);
        // 刚开启：把编辑区里已有的内容也存下来，让开关立刻生效而不是等下次输入
        if (wsSaveToggle.checked) { dirty = true; scheduleSave(); }
      });
    }

    // 「嵌套解析」开关：结果区里形如 "{\"a\":1}" 的字符串值递归展开成可折叠的树
    if (deepParseToggle) {
      deepParseToggle.addEventListener('change', function () {
        toggleDeepParse(deepParseToggle.checked);
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
      View.setPlain(jsonErrorReport(content, e.message), true);
      JP.notify(t('loaded_err', name, e.message));
      refreshMatches();
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
    JP.showLoading();
    var reader = new FileReader();
    reader.onload = function () {
      var content = String(reader.result == null ? '' : reader.result);
      loadFromFile(file.name, content);
    };
    reader.onerror = function () {
      JP.hideLoading();
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
    updateCounter();   // 立即更新计数，input 事件里也会调一次（幂等）
    scheduleAuto();    // 触发格式化
    scheduleSave();
    jsonInput.focus();
    // 大内容粘贴时显示 loading，等格式化完成后自动关闭
    if (text.length > 200000) JP.showLoading();
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
    if (!raw) { clearAll(); JP.hideLoading(); return; }

    var d = data;
    if (d === undefined) {
      try { d = parseInput(); }
      catch (e) {
        state.root = null;
        state.stats = null;
        state.outputText = '';
        // 用编辑区里的原始文本算出错位置（带上前后几行和 ^ 标记）
        var rep = jsonErrorReport(jsonInput.value, e.message);
        View.setPlain(rep, true);
        if (manual) {
          JP.notify(rep.split('\n')[0]);
          var at = scanJsonError(jsonInput.value);
          if (at >= 0) focusErrorOffset(at);
        }
        refreshMatches();
        JP.hideLoading();
        return;
      }
    }

    try {
      // 手动「格式化」要回填编辑区，回填的必须是原始口径的文本 —— 否则开了嵌套解析会把
      // 编辑区里一坨 JSON 字符串悄悄改写成嵌套对象，语义就变了
      var srcPretty = (manual && Model.deepParse) ? losslessStringify(d, 2) : null;
      state.data = d;                                  // 原始口径：嵌套解析开关来回切换要用它
      if (Model.deepParse) d = Model.deepResolve(d);   // 开着的：把值里的 JSON 字符串递归展开成真结构
      state.outputText = losslessStringify(d, 2);
      state.stats = Model.collectStats(d);
      state.root = Model.createNode(d, null);
      renderLevelButtons();

      var lv = levelForRows(state.stats, TARGET_ROWS);
      applyLevel(lv, true);

      if (manual) {
        syncInputPretty(srcPretty || state.outputText);
        JP.notify(t('formatted'));
      }
      if (announce && lv !== FULL_EXPAND) {
        JP.notify(t('big_auto', JP.fmtNum(state.stats.nodes), lv));
      }
      refreshMatches();
    } finally {
      JP.hideLoading();
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
    refreshMatches();
  }

  function rebuild() {
    if (!state.root) return;
    View.setTree(Model.flatten(state.root));
    // 展开状态可能变了，把搜索命中的标记重新钉到它现在的那一行
    if (revealedNode) View.setCurrentRow(View.indexOfNode(revealedNode));
  }

  /* ============================================================
     嵌套解析开关：把 body / payload 这类「值是 JSON 文本的字符串」递归展开成树
     ============================================================ */
  // 只改开关状态与外观，不动数据 —— 打开另一个文件时用它拨回关闭
  function setDeepParse(on) {
    Model.deepParse = !!on;
    if (deepParseToggle) deepParseToggle.checked = Model.deepParse;
  }

  function toggleDeepParse(on) {
    setDeepParse(on);
    // 还没格式化：状态先记着，下次格式化时自然生效
    if (!state.root || !state.data) return;

    JP.showLoading(t('deep_working'));
    // 让 loading 先画出来再开工：大文件里要把全树的字符串逐个 JSON.parse
    setTimeout(function () {
      try {
        if (Model.deepParse) Model.deepResolve(state.data);
        else Model.deepRevert();
        rebuildForDeep();
      } finally {
        JP.hideLoading();
      }
    }, 30);
  }

  // 同一份数据换了呈现口径：重建树与统计，但尽量保住用户手动展开的那些节点
  function rebuildForDeep() {
    var snap = snapshotExpansion();
    state.outputText = losslessStringify(state.data, 2);
    state.stats = Model.collectStats(state.data);
    state.root = Model.createNode(state.data, null);
    renderLevelButtons();

    // 开了开关、内容又够小：和首次格式化一个口径，直接全展开。
    // 不能只靠 restore —— 它贴回的是旧口径的展开状态，新解析出来的那几层在旧树里
    // 根本不存在（那时还是一整个字符串），于是小 JSON「一键格式化是全展开的，
    // 再开个嵌套解析反而折叠起来了」，很别扭。
    // 大内容仍走 restore：保住用户原本的浏览位置，也避免一次铺开几十万行。
    if (Model.deepParse && levelForRows(state.stats, TARGET_ROWS) === FULL_EXPAND) {
      applyLevel(FULL_EXPAND, true);
      revealedNode = null;          // 旧节点已经不在树里了
      JP.notify(t('deep_on'));
      return;
    }

    restoreExpansion(snap);
    View.setTree(Model.flatten(state.root));
    setActiveLevel(null);
    revealedNode = null;          // 旧节点已经不在树里了
    refreshMatches();
    JP.notify(Model.deepParse ? t('deep_on') : t('deep_off'));
  }

  function childPath(parent, c, i) {
    return parent + '\u0001' + ((c.key === null || c.key === undefined) ? i : c.key);
  }

  // 记下旧树里每个容器的展开状态与分页上限（只走已经建过子节点的子树）
  function snapshotExpansion() {
    var map = Object.create(null);
    if (!state.root) return map;
    var stack = [{ n: state.root, p: '' }];
    while (stack.length) {
      var it = stack.pop();
      var n = it.n;
      if (!Model.isContainer(n)) continue;
      if (n.expanded || n.limit) map[it.p] = { expanded: !!n.expanded, limit: n.limit || 0 };
      var ch = n.children;
      if (!ch) continue;          // 懒加载：没建过子节点的子树本来就该是折叠的
      for (var i = 0; i < ch.length; i++) stack.push({ n: ch[i], p: childPath(it.p, ch[i], i) });
    }
    return map;
  }

  // 按路径把展开状态贴回新树（路径 = key / 下标序列，同一种数据口径下是稳定的）
  function restoreExpansion(map) {
    if (!state.root) return;
    var stack = [{ n: state.root, p: '' }];
    while (stack.length) {
      var it = stack.pop();
      var n = it.n;
      if (!Model.isContainer(n)) continue;
      var s = map[it.p];
      if (s) {
        n.expanded = s.expanded;
        if (s.limit) n.limit = s.limit;
      }
      if (!n.expanded) continue;
      var ch = Model.ensureChildren(n, Model.childLimit(n));
      for (var i = 0; i < ch.length; i++) stack.push({ n: ch[i], p: childPath(it.p, ch[i], i) });
    }
  }

  // 点击折叠箭头
  function onToggle(e) {
    var n = e.node;
    if (!Model.isContainer(n)) return;
    n.expanded = !n.expanded;
    if (n.expanded) Model.ensureChildren(n, Model.childLimit(n));
    rebuild();
  }

  // 点击「加载更多」：默认再翻一页；Shift 点击把该容器剩余子节点一次取完
  // （十万个元素的数组，靠一页 500 要点两百次才翻到底）
  function onMore(e, idx, shift) {
    var n = e.node;
    var next = shift ? n.size : (n.limit || Model.PAGE) + Model.PAGE;
    n.limit = Math.min(next, n.size);
    rebuild();
  }

  function clearAll() {
    state.root = null;
    state.stats = null;
    state.data = null;
    state.outputText = '';
    View.clear();
    revealedNode = null;
    if (levelButtonsEl) levelButtonsEl.innerHTML = '';
    JP.hideLoading();
  }

  /* ============================================================
     JSON 解析错误：给出行列位置和出错片段
     ============================================================ */
  // V8 新版的 JSON.parse 报错已不再带 "at position N"，而且 losslessParse 会把
  // 大整数改写成字符串（字符下标整体右移）—— 所以位置一律靠自己扫一遍「原始输入」
  // 来定位，保证和编辑区里看到的文本一一对齐。返回 -1 表示没扫出语法错误
  // （例如嵌套过深抛出的是 RangeError，语法本身没问题）。
  function scanJsonError(s) {
    var i = 0;
    var n = s.length;

    function ws() {
      while (i < n) {
        var c = s.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) i++;
        else break;
      }
    }
    function lit(word) {
      if (s.slice(i, i + word.length) === word) { i += word.length; return true; }
      return false;
    }
    function str() {                       // 进入时 s[i] === '"'
      i++;
      while (i < n) {
        var c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '"') { i++; return -1; }
        if (c === '\n' || c === '\r') return i;   // 字符串里不能直接换行
        i++;
      }
      return i;                            // 引号没闭合
    }
    function num() {
      if (s[i] === '-') i++;
      if (i >= n) return i;
      if (s[i] === '0') { i++; }
      else if (s[i] >= '1' && s[i] <= '9') { while (i < n && s[i] >= '0' && s[i] <= '9') i++; }
      else return i;
      if (i < n && s[i] === '.') {
        i++;
        if (!(i < n && s[i] >= '0' && s[i] <= '9')) return i;
        while (i < n && s[i] >= '0' && s[i] <= '9') i++;
      }
      if (i < n && (s[i] === 'e' || s[i] === 'E')) {
        i++;
        if (i < n && (s[i] === '+' || s[i] === '-')) i++;
        if (!(i < n && s[i] >= '0' && s[i] <= '9')) return i;
        while (i < n && s[i] >= '0' && s[i] <= '9') i++;
      }
      return -1;
    }
    function val(depth) {
      if (depth > 1000) return -1;         // 太深不下判断，交给 JSON.parse 自己报错
      ws();
      if (i >= n) return i;
      var c = s[i];

      if (c === '{') {
        i++;
        ws();
        if (i < n && s[i] === '}') { i++; return -1; }
        for (;;) {
          ws();
          if (i >= n) return i;
          if (s[i] !== '"') return i;       // key 必须是字符串
          var bad = str();
          if (bad >= 0) return bad;
          ws();
          if (i >= n) return i;
          if (s[i] !== ':') return i;
          i++;
          bad = val(depth + 1);
          if (bad >= 0) return bad;
          ws();
          if (i >= n) return i;
          if (s[i] === ',') { i++; continue; }
          if (s[i] === '}') { i++; return -1; }
          return i;                         // 既不是 , 也不是 } —— 缺分隔符/多余内容
        }
      }

      if (c === '[') {
        i++;
        ws();
        if (i < n && s[i] === ']') { i++; return -1; }
        for (;;) {
          var bad2 = val(depth + 1);
          if (bad2 >= 0) return bad2;
          ws();
          if (i >= n) return i;
          if (s[i] === ',') { i++; continue; }
          if (s[i] === ']') { i++; return -1; }
          return i;
        }
      }

      if (c === '"') return str();
      if (c === '-' || (c >= '0' && c <= '9')) return num();
      if (lit('true') || lit('false') || lit('null')) return -1;
      return i;                             // 非法字符开头
    }

    var bad = val(0);
    if (bad >= 0) return bad;
    ws();
    if (i < n) return i;                    // 后面还有多余内容
    return -1;
  }

  // 字符下标 -> 行号列号（列从 1 开始）
  function lineColOf(text, idx) {
    var line = 1, lineStart = 0;
    for (var i = 0; i < idx; i++) {
      if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
    }
    return { line: line, col: idx - lineStart + 1 };
  }

  function padLeft(s, n) { while (String(s).length < n) s = ' ' + s; return String(s); }

  // 出错位置 + 前后几行 + 指到列上的 ^ 标记
  function jsonErrorReport(text, msg) {
    var idx = scanJsonError(text);
    if (idx < 0) return t('json_err', msg);

    var lc = lineColOf(text, idx);
    var lines = text.split('\n');
    var li = Math.min(lines.length - 1, lc.line - 1);
    var from = Math.max(0, li - 2);
    var to = Math.min(lines.length - 1, li + 2);
    var pad = String(to + 1).length;
    var out = [t('json_err_at', lc.line, lc.col, msg), ''];

    for (var i = from; i <= to; i++) {
      var isErr = (i === li);
      var line = lines[i];
      var startCol = 0;

      // 压缩成一行的 JSON 可能长达几十万字符，只显示出错点附近的一段
      if (line.length > 200) {
        if (isErr) startCol = Math.max(0, Math.min(line.length - 200, lc.col - 1 - 100));
        line = (startCol > 0 ? '…' : '') + line.substr(startCol, 200) +
          (line.length > startCol + 200 ? '…' : '');
      }
      out.push((isErr ? '> ' : '  ') + padLeft(i + 1, pad) + ' | ' + line);

      if (isErr) {
        var caretCol = lc.col - 1 - startCol + (startCol > 0 ? 1 : 0);
        if (caretCol < 0) caretCol = 0;
        var caret = '';
        for (var c = 0; c < caretCol; c++) caret += ' ';
        out.push('  ' + padLeft('', pad) + ' | ' + caret + '^ ' + t('json_err_here'));
      }
    }
    return out.join('\n');
  }

  // 把出错的字符在编辑区里选中并滚动过去
  function focusErrorOffset(offset) {
    try {
      jsonInput.focus();
      var end = Math.min(offset + 1, jsonInput.value.length);
      jsonInput.setSelectionRange(offset, end);
    } catch (e) { /* 不支持就跳过 */ }
  }

  /* ============================================================
     结果区搜索（按 key 名）
     - 搜的是整份数据，折叠 / 未渲染出来的部分也算，命中就自动展开到那一级
     - 命中顺序与右侧行顺序一致（先序遍历，出栈时记录），上下切换即视觉顺序
     ============================================================ */
  var MAX_SEARCH_MATCHES = 2000;   // 命中数上限，超出就停（超大文件不能卡住 UI）
  var SEARCH_BUDGET = 200000;      // 单次遍历的容器数上限

  var searchState = {
    open: false, term: '', regex: false, cs: false,   // cs: 区分大小写
    matches: [], cur: -1, truncated: false
  };
  var revealedNode = null;         // 当前命中对应的节点对象，重建平面行后据此重新定位
  var srchTimer = null;

  function toggleSearch() {
    if (searchState.open) closeSearch();
    else openSearch();
  }

  function openSearch() {
    if (!searchBox) return;
    searchState.open = true;
    searchBox.hidden = false;
    syncSearchToggles();
    if (searchInput) { searchInput.focus(); searchInput.select(); }
    syncSearchClear();
    if (searchState.term) runSearch();
    else updateSearchCount();
  }

  function closeSearch() {
    if (!searchBox) return;
    if (srchTimer) { clearTimeout(srchTimer); srchTimer = null; }
    searchBox.hidden = true;
    searchState.open = false;
    searchState.term = '';
    searchState.matches = [];
    searchState.cur = -1;
    searchState.truncated = false;
    revealedNode = null;
    View.setSearch(null);
    View.setCurrentRow(-1);
    if (searchInput) { searchInput.value = ''; searchInput.classList.remove('is-bad'); }
    syncSearchClear();
  }

  // 输入框右侧的 × 只在有内容时出现
  function syncSearchClear() {
    if (searchClear) searchClear.hidden = !searchInput || !searchInput.value;
  }

  // × 清空：只清搜索词，搜索框本身保持打开（区别于右上角的 × 关闭整个搜索）
  function clearSearchTerm() {
    if (!searchInput) return;
    if (srchTimer) { clearTimeout(srchTimer); srchTimer = null; }   // 撤掉排队中的那次搜索，否则旧词会立刻盖回来
    searchInput.value = '';
    searchInput.classList.remove('is-bad');
    syncSearchClear();
    runSearch();        // 空词会走「无匹配器」分支：清高亮 + 计数归零，不会弹提示
    searchInput.focus();
  }

  // 正则 / 大小写开关的按下状态
  function syncSearchToggles() {
    if (!searchBox) return;
    var re = searchBox.querySelector('[data-action="search-regex"]');
    var cs = searchBox.querySelector('[data-action="search-case"]');
    if (re) re.classList.toggle('is-on', searchState.regex);
    if (cs) cs.classList.toggle('is-on', searchState.cs);
  }

  // 参与搜索的「值」文本：与右侧行里显示的取值保持一致（大整数去掉 JPBIG_ 前缀）。
  // 容器没有值，返回 null。
  function valueText(v) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'object') return null;
    if (t === 'string') return v.indexOf('JPBIG_') === 0 ? v.slice(6) : v;
    return String(v);
  }

  // 遍历整份数据收集「key 或 value 命中」的行。
  // 每个容器一条栈记录（带游标），子节点按「先记命中、再深入子树」的顺序处理，
  // 于是命中顺序就是右上到右下的行顺序；路径用父指针串起来，避免层层 concat 新数组。
  function collectMatches(rootRaw, m, out) {
    var stack = [mkItem(rootRaw, null, null)];
    var visited = 0, truncated = false;

    function mkItem(v, p, k) {
      var isArr = Array.isArray(v);
      var isObj = !isArr && v !== null && typeof v === 'object';
      return {
        v: v, p: p, k: k,
        isArr: isArr,
        isObj: isObj,
        keys: isObj ? Object.keys(v) : null,
        i: 0
      };
    }

    while (stack.length) {
      if (out.length >= MAX_SEARCH_MATCHES || visited >= SEARCH_BUDGET) { truncated = true; break; }

      var top = stack[stack.length - 1];
      var cnt = top.isArr ? top.v.length : (top.keys ? top.keys.length : 0);
      if (top.i >= cnt) { stack.pop(); continue; }      // 这个容器走完了，回到上一层

      var j = top.i++;
      var k = top.isArr ? j : top.keys[j];
      var cv = top.v[k];

      var isCont = (cv !== null && typeof cv === 'object');

      // 数组元素是匿名的，只有对象里的 key 才可能被搜到
      var hitKey = top.isObj && m.test(String(k));
      // 容器没有取值，只有叶子节点参与值搜索
      var hitVal = !isCont && m.test(valueText(cv));
      if (hitKey || hitVal) out.push({ p: top, k: k });

      if (isCont) {
        visited++;
        stack.push(mkItem(cv, top, k));
      }
    }
    return truncated;
  }

  // 父指针链还原成「根 -> 目标」的路径
  function pathOf(item) {
    var arr = [];
    var c = item;
    while (c && c.k !== null && c.k !== undefined) { arr.push(c.k); c = c.p; }
    return arr.reverse();
  }

  // 沿路径逐级展开（必要时抬高分页上限），返回目标 key 所在的行下标；失败 -1
  function revealPath(path) {
    if (!state.root || !path) return -1;
    var node = state.root;
    for (var i = 0; i < path.length; i++) {
      if (!Model.isContainer(node)) return -1;

      var idx;
      if (node.kind === 'array') {
        idx = (typeof path[i] === 'number') ? path[i] : parseInt(path[i], 10);
      } else {
        if (!node.keys) node.keys = Object.keys(node.raw);
        idx = node.keys.indexOf(String(path[i]));
      }
      if (!(idx >= 0) || idx >= node.size) return -1;

      // 目标可能落在分页之外，或者整个容器还折叠着
      var need = idx + 1;
      if ((node.limit || Model.PAGE) < need) node.limit = need;
      node.expanded = true;
      var ch = Model.ensureChildren(node, node.limit);
      node = ch[idx];
      if (!node) return -1;
    }
    rebuild();
    revealedNode = node;
    return View.indexOfNode(node);
  }

  function updateSearchCount() {
    if (!searchCount) return;
    var n = searchState.matches.length;
    var cur = n ? (searchState.cur + 1) : 0;
    searchCount.textContent = cur + ' / ' + n + (searchState.truncated ? '+' : '');
    searchCount.classList.toggle('is-empty', !!searchState.term && n === 0);
  }

  // 当前搜索词对应的匹配器（key / value 共用）；正则写错时返回 null
  function currentMatcher() {
    return JP.makeMatcher(searchState.term, searchState.regex, !searchState.cs);
  }

  function runSearch() {
    if (!searchInput) return;
    var term = searchInput.value.trim();
    searchState.term = term;
    searchState.cur = -1;
    searchState.matches = [];
    searchState.truncated = false;
    revealedNode = null;

    var m = currentMatcher();
    View.setSearch(m);

    if (!m || !state.root) {
      View.setCurrentRow(-1);
      updateSearchCount();
      if (m && term) JP.notify(t('fmt_first'));
      if (!m && term) JP.notify(t('search_bad_re', term));
      searchInput.classList.toggle('is-bad', !!term && !m);
      return;
    }
    searchInput.classList.remove('is-bad');

    var hits = [];
    searchState.truncated = collectMatches(state.root.raw, m, hits);
    searchState.matches = hits.map(function (it) { return { path: pathOf(it) }; });

    if (searchState.matches.length) {
      JP.notify(searchState.truncated
        ? t('search_hits_more', JP.fmtNum(searchState.matches.length))
        : t('search_hits', JP.fmtNum(searchState.matches.length)));
      gotoMatch(0);
    } else {
      View.setCurrentRow(-1);
      updateSearchCount();
      JP.notify(t('search_none'));
    }
  }

  // 数据变了（重新格式化 / 切层级）：保住搜索词重算命中，但不自动跳转
  function refreshMatches() {
    if (!searchState.open || !searchState.term) return;
    var m = currentMatcher();
    View.setSearch(m);
    var hits = [];
    if (m && state.root) {
      searchState.truncated = collectMatches(state.root.raw, m, hits);
      searchState.matches = hits.map(function (it) { return { path: pathOf(it) }; });
    } else {
      searchState.matches = [];
      searchState.truncated = false;
    }
    searchState.cur = -1;
    revealedNode = null;
    View.setCurrentRow(-1);
    updateSearchCount();
  }

  function gotoMatch(i) {
    var ms = searchState.matches;
    if (!ms.length) return;
    if (i < 0) i = ms.length - 1;
    if (i >= ms.length) i = 0;

    var idx = revealPath(ms[i].path);
    if (idx < 0) { refreshMatches(); return; }

    searchState.cur = i;
    View.setCurrentRow(idx);
    View.scrollToIndex(idx);
    updateSearchCount();
  }

  function bindSearch() {
    if (!searchBox || !searchInput) return;

    searchInput.addEventListener('input', function () {
      syncSearchClear();
      if (srchTimer) clearTimeout(srchTimer);
      srchTimer = setTimeout(runSearch, 200);   // 大文件别每敲一个字就全量扫一遍
    });

    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (searchState.matches.length) gotoMatch(searchState.cur + (e.shiftKey ? -1 : 1));
        else runSearch();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSearch();
        jsonInput.focus();
      }
    });
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

  /* 真正「全部展开」（不受每容器 500 项分页限制）会产出多少行：
     每个叶子 1 行，每个容器 2 行（起始行 + 收口行）。 */
  function fullExpandRows(st) {
    if (!st) return 0;
    var cont = 0;
    var bdc = st.byDepthCont || [];
    for (var i = 0; i < bdc.length; i++) cont += bdc[i] || 0;
    return st.nodes + cont;
  }

  function expandAll() {
    if (!state.root) { JP.notify(t('fmt_first')); return; }

    // 行数在预算内时才解除分页 —— 否则「全部」这个按钮名不符实：
    // levelForRows 的估算本身就带着 500 页的假设（本例估算出来才 2007 行），
    // 于是它永远会判定「够小、可以全展开」，但展开后每个容器仍被 500 卡住。
    if (fullExpandRows(state.stats) <= HARD_ROWS) {
      Model.unpaged = true;
      try { applyLevel(FULL_EXPAND, false); } finally { Model.unpaged = false; }
      return;
    }
    applyLevel(FULL_EXPAND, true);
    JP.notify(t('expand_paged', JP.fmtNum(Model.PAGE)));
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
    // ---- 结果区搜索（key + value，支持正则）----
    search: function () { toggleSearch(); },
    'search-prev': function () { gotoMatch(searchState.cur - 1); },
    'search-next': function () { gotoMatch(searchState.cur + 1); },
    'search-close': function () { closeSearch(); },
    'search-clear': function () { clearSearchTerm(); },
    'search-regex': function () {
      searchState.regex = !searchState.regex;
      syncSearchToggles();
      runSearch();
    },
    'search-case': function () {
      searchState.cs = !searchState.cs;
      syncSearchToggles();
      runSearch();
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
        JP.hideLoading();
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
