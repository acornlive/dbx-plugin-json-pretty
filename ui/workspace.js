/* ============================================================
   workspace.js - 左侧工作区文件树（window.JP.Workspace，内部简称 JPWS）
   ============================================================
   职责边界：
     - 树的状态（节点 / 展开 / 当前文件）与后端同步，权威在 sidecar；
     - 本文件只管「树」这一件事：渲染、增删改、拖拽移动、收起、偏好持久化；
     - 具体把内容塞进编辑器、格式化，由 app.js 通过 onOpen 回调处理。

   为什么必须有后端：插件 UI 跑在 sandboxed iframe（opaque origin）里，
   localStorage / IndexedDB 都会抛 SecurityError，前端无法自己持久化。
   唯一可靠的落盘通道是 dbxPlugin.invoke(...) → Go 侧车 → 磁盘。
   ============================================================ */
(function () {
  'use strict';

  var JP = window.JP;
  // 对外仍挂在 window.JP.Workspace 下（和其它模块一样统一在 JP 命名空间里）；
  // 本文件内部用 JPWS 这个短名引用 —— WS 太容易和 WebSocket 之类撞名。
  var JPWS = window.JP.Workspace = {};

  var RPC_TIMEOUT = 30000;
  var PING_TIMEOUT = 8000;
  var PREFS_DEBOUNCE = 500;

  // 宿主对 invoke 参数有 2 MiB 硬上限（enforcePayloadLimit）。
  // 超过这个体积，保存请求会直接在宿主侧被拒，前端只拿到一个含糊的失败 ——
  // 所以前端先自己量一遍并明确提示，而不是等到传输失败。
  var MAX_SAVE_BYTES = 1900 * 1000;
  JPWS.MAX_SAVE_BYTES = function () { return MAX_SAVE_BYTES; };

  var ROOT = '#root';

  var state = {
    ready: false,
    available: false,
    error: '',
    dir: '',
    nodes: [],
    byId: {},
    kids: {},
    activeId: '',
    expanded: {},
    prefs: {},
    collapsed: false,
    saveEnabled: false   // 默认「用完即走」，不落盘；用户在工作区标题栏勾「保存」才开启
  };

  var els = null;
  var onOpen = function () {};
  var onLayout = function () {};
  var onFlush = function () {};   // 切换目标文件前，先把编辑区里未落盘的改动写回旧文件
  var menuEl = null;
  var moveEl = null;      // 「移动」的目标文件夹选择面板
  var prefsTimer = null;

  /* ---------------- 工具 ---------------- */

  function errText(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    if (e.message) return String(e.message);
    if (e.error) return String(e.error);
    try { return JSON.stringify(e).slice(0, 300); } catch (e2) { return String(e); }
  }

  function isContainer(n) { return !!n && n.type === 'folder'; }

  function byteLength(text) {
    if (typeof TextEncoder !== 'undefined') {
      try { return new TextEncoder().encode(text || '').length; } catch (e) { /* 回退 */ }
    }
    return (text || '').length;
  }
  JPWS.byteLength = byteLength;

  /* ---------------- 侧车 RPC ---------------- */

  function rpc(method, params, timeoutMs) {
    var dbx = JP.dbx;
    if (!dbx || typeof dbx.invoke !== 'function') {
      return Promise.reject(new Error('宿主未提供 dbxPlugin.invoke（当前不在插件工作台内）'));
    }
    var out;
    try {
      out = dbx.invoke(method, params || {}, { timeoutMs: timeoutMs || RPC_TIMEOUT });
    } catch (e) {
      return Promise.reject(new Error(method + ' 调用失败：' + errText(e)));
    }
    return Promise.resolve(out).then(function (res) {
      if (res && res.error && !res.ok) throw new Error(errText(res.error));
      // 宿主若把整个 JSON-RPC 信封透传回来，解一层
      if (res && res.result !== undefined && res.ok === undefined) return res.result;
      return res;
    });
  }
  JPWS.invoke = rpc;

  /* ---------------- 初始化 ---------------- */

  JPWS.init = function (opts) {
    opts = opts || {};
    els = { list: opts.list, pane: opts.pane };
    onOpen = opts.onOpen || onOpen;
    onLayout = opts.onLayout || onLayout;
    onFlush = opts.onFlush || onFlush;

    buildMenu();
    bindList();

    return rpc('jp/ping', {}, PING_TIMEOUT).then(function (p) {
      state.available = true;
      state.error = '';
      state.dir = (p && p.dir) || '';
      if (p && p.maxContentBytes) MAX_SAVE_BYTES = p.maxContentBytes;
      return rpc('jp/loadTree', {});
    }).then(function (r) {
      applyTree((r && r.tree) || {});
      state.prefs = (r && r.prefs) || {};
      state.collapsed = state.prefs.treeCollapsed === true;
      state.saveEnabled = state.prefs.saveEnabled === true;
      state.ready = true;
      // 启动既不载入内容，也就【没有】当前文件。
      // 后端记住的 activeId 只用于「用户点开树里某个文件」的还原，不能在这里继承 ——
      // 否则编辑区显示是空的，第一次粘贴却会写进上一次会话那个文件里（凭空覆盖历史数据）。
      state.activeId = '';
      render();
      onLayout();
      return { ok: true, activeId: '', content: '' };
    }).catch(function (e) {
      state.available = false;
      state.error = errText(e);
      state.ready = true;
      render();
      onLayout();
      return { ok: false, activeId: '', content: '', error: state.error };
    });
  };

  function applyTree(tree) {
    state.nodes = tree.nodes || [];
    state.activeId = tree.activeId || '';
    state.expanded = tree.expanded || {};
    rebuildIndex();
  }

  function rebuildIndex() {
    state.byId = {};
    state.kids = {};
    for (var i = 0; i < state.nodes.length; i++) {
      state.byId[state.nodes[i].id] = state.nodes[i];
    }
    // 顺序即后端数组顺序：不做排序，才能保留用户拖出来的排列
    for (var j = 0; j < state.nodes.length; j++) {
      var n = state.nodes[j];
      var k = n.parentId || ROOT;
      (state.kids[k] || (state.kids[k] = [])).push(n);
    }
  }

  // 任何变更后统一回读一次，避免本地与磁盘出现分歧（节点量很小，代价可忽略）
  function refresh() {
    return rpc('jp/loadTree', {}).then(function (r) {
      applyTree((r && r.tree) || {});
      render();
      return true;
    });
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    if (!els || !els.list) return;
    var frag = document.createDocumentFragment();

    if (!state.available) {
      var warn = document.createElement('div');
      warn.className = 'tree-empty';
      warn.textContent = JP.t('ws_offline', state.error);
      frag.appendChild(warn);
      els.list.innerHTML = '';
      els.list.appendChild(frag);
      return;
    }

    emitKids(ROOT, 0, frag);
    if (!state.nodes.length) {
      var empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = JP.t('ws_empty');
      frag.appendChild(empty);
    }
    els.list.innerHTML = '';
    els.list.appendChild(frag);
  }

  function emitKids(key, depth, frag) {
    var list = state.kids[key] || [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var row = document.createElement('div');
      row.className = 'tree-row' + (n.id === state.activeId ? ' active' : '');
      row.dataset.id = n.id;
      row.dataset.type = n.type;
      row.style.paddingLeft = (6 + depth * 14) + 'px';

      var arrow = document.createElement('span');
      arrow.className = 'tree-arrow';
      arrow.textContent = isContainer(n) ? (state.expanded[n.id] ? '▾' : '▸') : '';
      row.appendChild(arrow);

      if (!isContainer(n)) {
        var tag = document.createElement('span');
        tag.className = 'tree-tag';
        tag.textContent = '{}';
        row.appendChild(tag);
      }

      var name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = n.name;
      name.title = n.name;
      row.appendChild(name);

      frag.appendChild(row);

      if (isContainer(n) && state.expanded[n.id]) emitKids(n.id, depth + 1, frag);
    }
  }

  /* ---------------- 交互 ---------------- */

  function bindList() {
    if (!els || !els.list) return;
    var list = els.list;

    // 双击在派发 dblclick 之前会先派发两次 click。文件夹的处理因此要「等一等」：
    // 单击延迟 200ms 再展开/折叠，期间若收到 dblclick 就取消 ——
    // 这样双击文件夹 = 纯重命名，不会先把状态翻一遍。
    // 文件不受影响：单击立即打开（打开是幂等的，随后进入重命名也不冲突）。
    var clickTimer = null;
    var pendingId = '';
    var CLICK_DELAY = 200;

    list.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.tree-row') : null;
      if (!row) return;
      var id = row.dataset.id;
      var node = state.byId[id];
      if (!node) return;

      if (!isContainer(node)) { openNode(node); return; }

      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      pendingId = id;
      clickTimer = setTimeout(function () {
        clickTimer = null;
        var n = state.byId[pendingId];
        if (n && isContainer(n)) toggleExpand(n);
      }, CLICK_DELAY);
    });

    list.addEventListener('dblclick', function (e) {
      // 取消待执行的展开/折叠：这次交互是重命名，不是折叠状态切换
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

      var row = e.target.closest ? e.target.closest('.tree-row') : null;
      if (!row) return;
      var id = row.dataset.id;
      var node = state.byId[id];
      if (!node) return;

      // 关键：第一次 click 打开文件时会同步 render() 重建整行，
      // 此时 e.target 那一行已经从文档里摘掉了，直接对它插入输入框不会显示。
      // 必须按 id 重新取一次当前在树上的那一行。
      var live = els.list.querySelector('.tree-row[data-id="' + id + '"]');
      startRename(live || row, node);
    });

    list.addEventListener('contextmenu', function (e) {
      var row = e.target.closest ? e.target.closest('.tree-row') : null;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, row ? row.dataset.id : '');
    });

    /* 拖拽移动已移除。
       插件 UI 跑在 sandboxed iframe 里，宿主会拦掉 HTML5 原生 drag & drop
       （dragstart 派发不出来 / dataTransfer 被限制），拖放在宿主内根本不生效。
       宿主自己的拖放通道 window.dbxPlugin.fileTransfer.onDrop 只处理「从系统拖入文件」，
       且仅桌面端，做不了树内部的节点移动。所以改用右键菜单的「移动」。 */
  }

  /* ---------------- 移动：右键 -> 选目标文件夹 ---------------- */

  // 自身子树不能作为移动目标（会把整棵子树从树上摘下来成环）
  function subtreeIdSet(rootId) {
    var set = {};
    set[rootId] = true;
    var changed = true, round = 0;
    while (changed && round++ < 64) {
      changed = false;
      for (var i = 0; i < state.nodes.length; i++) {
        var n = state.nodes[i];
        if (n.parentId && set[n.parentId] && !set[n.id]) {
          set[n.id] = true;
          changed = true;
        }
      }
    }
    return set;
  }

  function emitFolderOptions(parentKey, depth, blocked, out) {
    var list = state.kids[parentKey] || [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!isContainer(n)) continue;
      if (blocked && blocked[n.id]) continue;
      var b = document.createElement('button');
      b.className = 'tree-move-item';
      b.type = 'button';
      b.dataset.targetId = n.id;
      b.style.paddingLeft = (8 + depth * 12) + 'px';
      b.textContent = n.name;
      out.appendChild(b);
      emitFolderOptions(n.id, depth + 1, blocked, out);
    }
  }

  function showMovePanel(x, y, id) {
    var node = state.byId[id];
    if (!node || !moveEl) return;

    moveEl.innerHTML = '';
    moveEl.dataset.id = id;

    var title = document.createElement('div');
    title.className = 'tree-move-title';
    title.textContent = JP.t('ws_move_title', node.name);
    moveEl.appendChild(title);

    var rootBtn = document.createElement('button');
    rootBtn.className = 'tree-move-item';
    rootBtn.type = 'button';
    rootBtn.dataset.targetId = '';        // 空串 = 根目录
    rootBtn.textContent = JP.t('ws_root');
    moveEl.appendChild(rootBtn);

    // 目标里绝不能出现「被移动的这个节点自己」：
    //   - 文件夹：整个自身子树都要排除 —— 移进自己的后代会让整棵子树从树上脱落成环
    //   - 文件：它本来就不在文件夹列表里，但仍显式排除一次，避免以后改列表逻辑时漏掉
    var blocked = {};
    blocked[id] = true;
    if (isContainer(node)) {
      var sub = subtreeIdSet(id);
      for (var k in sub) {
        if (Object.prototype.hasOwnProperty.call(sub, k)) blocked[k] = true;
      }
    }
    emitFolderOptions(ROOT, 0, blocked, moveEl);

    moveEl.hidden = false;
    placeFloating(moveEl, x, y);
  }

  function hideMove() { if (moveEl) moveEl.hidden = true; }

  function toggleExpand(node) {
    var next = !state.expanded[node.id];
    state.expanded[node.id] = next;
    render();
    rpc('jp/setExpanded', { expanded: expandPatch() }).catch(function () { /* 展开状态丢了不影响数据 */ });
  }

  // 只回传「非默认」的项，避免把整棵树的 false 都写进索引
  function expandPatch() {
    var out = {};
    for (var k in state.expanded) {
      if (Object.prototype.hasOwnProperty.call(state.expanded, k)) out[k] = !!state.expanded[k];
    }
    return out;
  }

  function openNode(node) {
    if (isContainer(node)) return;
    onFlush();   // 先把上一个文件的改动写回，再切走
    state.activeId = node.id;
    render();
    rpc('jp/setActive', { id: node.id }).catch(function () { /* 忽略 */ });
    rpc('jp/readFile', { id: node.id }).then(function (fr) {
      onOpen(node, (fr && fr.content) || '');
    }).catch(function (e) {
      JP.notify(JP.t('ws_read_fail', errText(e)));
    });
  }

  /* ---------------- 行内重命名 ---------------- */

  function startRename(row, node) {
    var nameEl = row.querySelector('.tree-name');
    if (!nameEl) return;

    var input = document.createElement('input');
    input.className = 'tree-rename';
    input.value = node.name;
    row.replaceChild(input, nameEl);
    input.focus();
    input.select();

    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var next = input.value;
      if (!commit || !next.trim() || next === node.name) {
        render();
        return;
      }
      rpc('jp/renameNode', { id: node.id, name: next })
        .then(function () { refresh(); })
        .catch(function (e) { JP.notify(JP.t('ws_rename_fail', errText(e))); render(); });
    }

    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
  }

  /* ---------------- 右键菜单 ---------------- */

  function buildMenu() {
    menuEl = document.createElement('div');
    menuEl.className = 'tree-menu';
    menuEl.hidden = true;
    // 「打开」不进菜单：单击文件就已经打开了，重复入口只会让菜单变长
    [
      { act: 'newfile', label: 'ws_new_file' },
      { act: 'newfolder', label: 'ws_new_folder' },
      { act: 'move', label: 'ws_move' },
      { act: 'rename', label: 'ws_rename' },
      { act: 'delete', label: 'ws_delete' }
    ].forEach(function (item) {
      var b = document.createElement('button');
      b.className = 'tree-menu-item';
      b.type = 'button';
      b.dataset.act = item.act;
      b.dataset.label = item.label;   // 切语言时按它重新取文案
      b.textContent = JP.t(item.label);
      menuEl.appendChild(b);
    });
    document.body.appendChild(menuEl);

    menuEl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.tree-menu-item') : null;
      if (!b) return;
      // 必须掐断冒泡：否则这次 click 一路冒到 document 上的「点任意处关闭浮层」，
      // 刚弹出的「移动」面板会被立刻关掉。
      if (e.stopPropagation) e.stopPropagation();
      var id = menuEl.dataset.targetId || '';
      var act = b.dataset.act;
      var at = { x: menuEl.offsetLeft, y: menuEl.offsetTop };
      hideMenu();
      // 「移动」要接着弹目标选择面板，其余动作直接执行
      if (act === 'move') showMovePanel(at.x, at.y, id);
      else runMenuAction(act, id);
    });

    // 目标文件夹选择面板
    moveEl = document.createElement('div');
    moveEl.className = 'tree-menu tree-move';
    moveEl.hidden = true;
    document.body.appendChild(moveEl);
    moveEl.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.tree-move-item') : null;
      if (!b) return;
      if (e.stopPropagation) e.stopPropagation();
      var id = moveEl.dataset.id || '';
      var targetId = b.dataset.targetId || '';   // 空串 = 根目录
      hideMove();
      JPWS.moveNode(id, targetId || null, null);
    });

    document.addEventListener('click', function () { hideMenu(); hideMove(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hideMenu(); hideMove(); }
    });
    window.addEventListener('resize', function () { hideMenu(); hideMove(); });
  }

  // 浮层定位：越过视口边界就往回收
  function placeFloating(el, x, y) {
    var w = el.offsetWidth || 140;
    var h = el.offsetHeight || 120;
    if (x + w > window.innerWidth) x = window.innerWidth - w - 8;
    if (y + h > window.innerHeight) y = window.innerHeight - h - 8;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  function showMenu(x, y, id) {
    menuEl.dataset.targetId = id;
    // 菜单文案随语言变化
    var items = menuEl.querySelectorAll('.tree-menu-item');
    for (var i = 0; i < items.length; i++) {
      items[i].textContent = JP.t(items[i].dataset.label);
    }
    var node = state.byId[id];
    for (var j = 0; j < items.length; j++) {
      var act = items[j].dataset.act;
      var visible = true;
      if (act === 'newfile' || act === 'newfolder') visible = !node || isContainer(node);
      if (act === 'move' || act === 'rename' || act === 'delete') visible = !!node;
      items[j].hidden = !visible;
    }
    menuEl.hidden = false;
    placeFloating(menuEl, x, y);
  }

  function hideMenu() { if (menuEl) menuEl.hidden = true; }

  function runMenuAction(act, id) {
    var node = state.byId[id];
    var parentId = node ? (isContainer(node) ? node.id : node.parentId) : null;
    // 新建文件直接用默认文件名（yyyymmddss.json），建完立刻进入重命名让用户改
    if (act === 'newfile') { JPWS.createNode('file', JP.defaultFileName(), parentId); return; }
    if (act === 'newfolder') { JPWS.createNode('folder', '', parentId); return; }
    if (act === 'rename' && node) {
      var row = els && els.list ? els.list.querySelector('.tree-row[data-id="' + node.id + '"]') : null;
      if (row) startRename(row, node);
      return;
    }
    if (act === 'delete' && node) { JPWS.deleteNode(node.id); return; }
  }

  /* ---------------- 对外操作 ---------------- */

  // activate：是否设为当前文件
  // openIt：是否把（空的）内容推给编辑区 —— 只对文件生效，建目录不该清空编辑器
  // renameIt：建完是否直接进入行内重命名，让用户立刻改名
  function createNodeRaw(type, name, parentId, activate, openIt, renameIt) {
    if (openIt || renameIt) onFlush();
    return rpc('jp/createNode', { type: type, name: name || '', parentId: parentId || null })
      .then(function (r) {
        var node = r && r.node;
        if (node && activate) state.activeId = node.id;
        return refresh().then(function () {
          if (node && openIt && node.type === 'file') onOpen(node, '');
          if (node && renameIt) {
            // refresh() 重建过整棵树，必须按 id 重新取当前在树上的那一行
            var row = els.list.querySelector('.tree-row[data-id="' + node.id + '"]');
            if (row) startRename(row, node);
          }
          return node;
        });
      })
      .catch(function (e) { JP.notify(JP.t('ws_create_fail', errText(e))); return null; });
  }

  JPWS.createNode = function (type, name, parentId) {
    return createNodeRaw(type, name, parentId, true, true, true);
  };

  // 自动保存用：建好文件并设为当前，但【不】动编辑区 ——
  // 否则用户正在编辑的内容会被 onOpen 的空内容冲掉。
  JPWS.ensureFile = function (name) {
    if (state.activeId && state.byId[state.activeId]) return Promise.resolve(state.byId[state.activeId]);
    return createNodeRaw('file', name, null, true, false, false);
  };

  JPWS.renameNode = function (id, name) {
    return rpc('jp/renameNode', { id: id, name: name })
      .then(function () { return refresh(); })
      .catch(function (e) { JP.notify(JP.t('ws_rename_fail', errText(e))); return null; });
  };

  JPWS.moveNode = function (id, parentId, index) {
    return rpc('jp/moveNode', { id: id, parentId: parentId || null, index: index })
      .then(function () { return refresh(); })
      .catch(function (e) { JP.notify(JP.t('ws_move_fail', errText(e))); return null; });
  };

  JPWS.deleteNode = function (id) {
    var node = state.byId[id];
    if (!node) return Promise.resolve(null);
    return rpc('jp/deleteNode', { id: id }).then(function () {
      if (state.activeId === id || isAncestorOf(id, state.activeId)) {
        state.activeId = '';
        onOpen(null, '');
      }
      JP.notify(JP.t('ws_deleted', node.name));
      return refresh();
    }).catch(function (e) { JP.notify(JP.t('ws_delete_fail', errText(e))); return null; });
  };

  function isAncestorOf(ancestorId, id) {
    if (!ancestorId || !id) return false;
    var cur = state.byId[id];
    var guard = 0;
    while (cur && guard++ < 256) {
      if (cur.parentId === ancestorId) return true;
      cur = cur.parentId ? state.byId[cur.parentId] : null;
    }
    return false;
  }

  JPWS.readFile = function (id) {
    return rpc('jp/readFile', { id: id }).then(function (r) { return (r && r.content) || ''; });
  };

  JPWS.writeFile = function (id, content) {
    if (!id) return Promise.resolve(false);
    if (byteLength(content) > MAX_SAVE_BYTES) {
      JP.notify(JP.t('ws_too_large', Math.round(byteLength(content) / 1024), Math.round(MAX_SAVE_BYTES / 1024)));
      return Promise.resolve(false);
    }
    return rpc('jp/writeFile', { id: id, content: content })
      .then(function () { return true; })
      .catch(function (e) { JP.notify(JP.t('ws_save_fail', errText(e))); return false; });
  };

  // 「导入」：本地 .json 在工作区里建一个新文件并打开
  JPWS.importFile = function (name, content, parentId) {
    if (byteLength(content) > MAX_SAVE_BYTES) {
      JP.notify(JP.t('ws_too_large', Math.round(byteLength(content) / 1024), Math.round(MAX_SAVE_BYTES / 1024)));
      return Promise.resolve(null);
    }
    onFlush();   // 导入会切换当前文件，先把旧文件的改动收尾
    return rpc('jp/importFile', { name: name, content: content, parentId: parentId || null })
      .then(function (r) {
        var node = r && r.node;
        if (node) {
          state.activeId = node.id;
          onOpen(node, content);
        }
        return refresh().then(function () { return node; });
      })
      .catch(function (e) { JP.notify(JP.t('ws_import_fail', errText(e))); return null; });
  };

  JPWS.setActive = function (id) {
    state.activeId = id || '';
    render();
    return rpc('jp/setActive', { id: id || '' }).catch(function () { /* 忽略 */ });
  };

  /* ---------------- 收起 / 偏好 ---------------- */

  JPWS.collapsed = function () { return state.collapsed; };

  // 收起态不是「整块消失」，而是缩成一条带展开按钮的窄栏 —— 具体样式/宽度由
  // app.js 的 applyLayout() 负责，这里只维护状态并通知布局重算。
  JPWS.setCollapsed = function (v) {
    state.collapsed = !!v;
    onLayout();
    savePrefs({ treeCollapsed: state.collapsed });
  };

  JPWS.toggleCollapsed = function () { JPWS.setCollapsed(!state.collapsed); };

  /* ---------------- 保存开关 ---------------- */

  // 只有开启时才落盘；关闭 = 用完即走。
  // 注意：关闭只代表「之后不再写入」，已经存下来的文件不会被删，
  // 用户要清得自己在树里右键删除 —— 避免因拨一下开关就不可逆地销毁数据。
  JPWS.saveEnabled = function () { return state.saveEnabled; };

  JPWS.setSaveEnabled = function (v) {
    state.saveEnabled = !!v;
    savePrefs({ saveEnabled: state.saveEnabled });
  };

  JPWS.treeWidth = function () {
    var w = state.prefs.treeWidth;
    return (typeof w === 'number' && w > 0) ? w : 220;
  };
  JPWS.setTreeWidth = function (w) {
    savePrefs({ treeWidth: Math.round(w) });
  };
  JPWS.splitRatio = function () {
    var r = state.prefs.splitRatio;
    return (typeof r === 'number' && r > 0) ? r : null;
  };
  JPWS.setSplitRatio = function (r) { savePrefs({ splitRatio: r }); };

  function savePrefs(patch) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) state.prefs[k] = patch[k];
    }
    if (prefsTimer) clearTimeout(prefsTimer);
    prefsTimer = setTimeout(function () {
      prefsTimer = null;
      rpc('jp/setPrefs', { prefs: state.prefs }).catch(function () { /* 偏好丢了不影响数据 */ });
    }, PREFS_DEBOUNCE);
  }

  /* ---------------- 查询 ---------------- */

  JPWS.ready = function () { return state.ready; };
  JPWS.available = function () { return state.available; };
  JPWS.error = function () { return state.error; };
  JPWS.dir = function () { return state.dir; };
  JPWS.activeId = function () { return state.activeId; };
  JPWS.activeNode = function () { return state.byId[state.activeId] || null; };
  JPWS.node = function (id) { return state.byId[id] || null; };

  // 当前所处文件夹：用于决定「新建 / 导入」落在哪一层
  JPWS.currentFolder = function () {
    var n = JPWS.activeNode();
    if (!n) return null;
    return isContainer(n) ? n.id : (n.parentId || null);
  };

  JPWS.reRender = render;
})();
