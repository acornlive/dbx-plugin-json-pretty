/* ============================================================
   model.js - JSON 数据模型（window.JP.Model）
   设计要点（针对大文件）：
   1) 懒建树：节点只在需要显示时才创建子节点，不预先递归整棵 JSON
   2) 子节点分页：单个容器一次最多渲染 PAGE 个子节点，其余用「加载更多」行
   3) 迭代遍历：统计与扁平化都用显式栈，避免深层级递归爆栈
   4) 扁平化只产出「可见行」，折叠的子树不进入行数组
   ============================================================ */
(function () {
  'use strict';
  var JP = window.JP;
  var Model = JP.Model = {};

  Model.MAX_CELL = 2000;       // 单个值显示的最大字符数（超出截断，双击复制仍是完整值）
  Model.PAGE = 500;            // 单个容器一次渲染的子节点上限

  var STATS_BUDGET = 300000;   // 统计遍历节点上限（超出则标记为截断）
  var EXPAND_BUDGET = 300000;  // 按层级展开时的遍历预算

  function isContainer(n) { return n.kind === 'object' || n.kind === 'array'; }
  Model.isContainer = isContainer;

  // 不生成临时数组地统计键数（避免大对象上的额外分配）
  function countKeys(o) {
    var n = 0;
    for (var k in o) n++;
    return n;
  }

  function createNode(value, key) {
    if (Array.isArray(value)) {
      return { kind: 'array', key: key, raw: value, size: value.length, expanded: false, children: null, limit: 0 };
    }
    if (value !== null && typeof value === 'object') {
      return { kind: 'object', key: key, raw: value, size: countKeys(value), expanded: false, children: null, keys: null, limit: 0 };
    }
    return {
      kind: value === null ? 'null' : typeof value,
      key: key, raw: value, value: value, children: null
    };
  }
  Model.createNode = createNode;

  // 构建子节点，最多到 upTo 个（默认全部）
  Model.ensureChildren = function (node, upTo) {
    var ch = node.children;
    if (!ch) ch = node.children = [];
    var want = (typeof upTo === 'number') ? Math.min(node.size, upTo) : node.size;
    if (ch.length >= want) return ch;
    var raw = node.raw;
    if (node.kind === 'array') {
      for (var i = ch.length; i < want; i++) ch.push(createNode(raw[i], null));
    } else {
      if (!node.keys) node.keys = Object.keys(raw);
      var ks = node.keys;
      for (var j = ch.length; j < want; j++) ch.push(createNode(raw[ks[j]], ks[j]));
    }
    return ch;
  };

  // 当前容器实际渲染多少个子节点
  Model.childLimit = function (node) {
    return Math.min(node.size, node.limit || Model.PAGE);
  };

  Model.serialize = function (node) {
    try { return JSON.stringify(node.raw, null, 2); } catch (e) { return String(node.raw); }
  };

  /* ============================================================
     统计：层级 / 键数 / 数组元素数 / 节点数（按层分布）
     ============================================================ */
  Model.collectStats = function (rootValue) {
    var depth = 0, keys = 0, items = 0, nodes = 0, truncated = false;
    var byDepth = [];        // 每层节点数（1-based）
    var byDepthCont = [];    // 每层容器数（对象/数组）
    var stack = [rootValue];
    var ds = [1];

    while (stack.length) {
      var v = stack.pop();
      var d = ds.pop();
      nodes++;
      if (d > depth) depth = d;
      byDepth[d] = (byDepth[d] || 0) + 1;
      if (nodes >= STATS_BUDGET) { truncated = true; break; }

      if (Array.isArray(v)) {
        items += v.length;
        byDepthCont[d] = (byDepthCont[d] || 0) + 1;
        for (var i = v.length - 1; i >= 0; i--) { stack.push(v[i]); ds.push(d + 1); }
      } else if (v !== null && typeof v === 'object') {
        byDepthCont[d] = (byDepthCont[d] || 0) + 1;
        for (var k in v) { keys++; stack.push(v[k]); ds.push(d + 1); }
      }
    }
    return {
      depth: depth, keys: keys, items: items, nodes: nodes,
      byDepth: byDepth, byDepthCont: byDepthCont, truncated: truncated
    };
  };

  /* ============================================================
     按层级展开：只构建真正需要显示的子节点
     ============================================================ */
  Model.setExpandedToDepth = function (node, depth, maxLevel) {
    var budget = EXPAND_BUDGET;
    (function walk(n, d) {
      if (!isContainer(n)) return;
      if (--budget < 0) return;
      n.expanded = d < maxLevel;
      if (!n.expanded) return;
      var lim = Model.childLimit(n);
      var ch = Model.ensureChildren(n, lim);
      for (var i = 0; i < ch.length && i < lim; i++) walk(ch[i], d + 1);
    })(node, depth);
  };

  /* ============================================================
     扁平化：展开树 -> 可见行数组
     行类型：leaf / open（容器起始行，折叠时即为收起行）/ close / more
     ============================================================ */
  var X_CLOSE = 1, X_MORE = 2;

  function mkClose(node) { return { __x: X_CLOSE, node: node }; }
  function mkMore(node, from) { return { __x: X_MORE, node: node, from: from }; }

  function leafChars(n) {
    var c = (n.key === null || n.key === undefined) ? 0 : (n.key.length + 4);
    if (n.kind === 'string') c += Math.min(n.value.length, Model.MAX_CELL) + 2;
    else if (n.kind === 'number') c += 20;
    else if (n.kind === 'boolean') c += 6;
    else c += 4;
    return c;
  }

  function openChars(n) {
    var c = (n.key === null || n.key === undefined) ? 0 : (n.key.length + 4);
    return c + (n.expanded ? 2 : 18);
  }

  // last：该节点是否是父容器的最后一个子节点（决定是否补逗号）
  function drain(stack, out) {
    while (stack.length) {
      var it = stack.pop();
      var n = it.n, d = it.d, last = it.last;
      var c = last ? 0 : 1;   // 逗号占位

      if (n.__x === X_CLOSE) {
        out.push({ node: n.node, depth: d, part: 'close', chars: 1 + c, comma: !last });
        continue;
      }
      if (n.__x === X_MORE) {
        out.push({ node: n.node, depth: d, part: 'more', from: n.from, chars: 28 + c, comma: !last });
        continue;
      }
      if (!isContainer(n)) {
        out.push({ node: n, depth: d, part: 'leaf', chars: leafChars(n) + c, comma: !last });
        continue;
      }

      // 展开的容器逗号落在收口行；折叠的容器逗号落在预览行末尾
      out.push({
        node: n, depth: d, part: 'open', chars: openChars(n) + c,
        comma: !n.expanded && !last
      });
      if (!n.expanded) continue;

      var lim = Model.childLimit(n);
      var ch = Model.ensureChildren(n, lim);
      var use = Math.min(lim, ch.length);

      stack.push({ n: mkClose(n), d: d, last: last });
      if (n.size > use) stack.push({ n: mkMore(n, use), d: d + 1, last: use === n.size - 1 });
      for (var i = use - 1; i >= 0; i--) {
        stack.push({ n: ch[i], d: d + 1, last: i === n.size - 1 });
      }
    }
    return out;
  }

  Model.flatten = function (root) {
    if (!root) return [];
    return drain([{ n: root, d: 0, last: true }], []);
  };
})();
