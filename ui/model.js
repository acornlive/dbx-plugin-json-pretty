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
    // 无损大整数：losslessParse 将其包裹为 "JPBIG_xxxx"，还原为数字类型展示
    if (typeof value === 'string' && value.indexOf('JPBIG_') === 0) {
      return {
        kind: 'number',
        key: key,
        raw: value,                         // 保留完整字符串供序列化还原
        value: value.slice(6),              // 截掉前缀显示原始数字
        children: null
      };
    }
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
    if (Model.unpaged) return node.size;
    return Math.min(node.size, node.limit || Model.PAGE);
  };

  /* ============================================================
     嵌套解析：把「值是 JSON 文本的字符串」递归变成真的对象 / 数组
     典型场景：接口返回的 body / payload 是一坨转义过的 JSON 字符串，里面还套着一层。
     关掉开关要能原样还原，所以每次替换都记下「所在容器 + 键 + 原字符串」。
     ============================================================ */
  Model.deepParse = false;   // 开关状态
  Model.parseText = null;    // app.js 注入 losslessParse（保持无损大整数口径一致）
  var deepReverts = [];
  var DEEP_MAX = 12;         // 递归深度上限，防病态输入

  // 只看「像 JSON 对象/数组」的字符串：把 "123" / "true" 这种标量也转了反而添乱
  function tryNested(str) {
    if (typeof str !== 'string') return str;
    var len = str.length, i = 0;
    while (i < len && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 10 ||
                       str.charCodeAt(i) === 13 || str.charCodeAt(i) === 9)) i++;
    if (i >= len) return str;
    var c0 = str.charCodeAt(i);
    if (c0 !== 123 && c0 !== 91) return str;              // 只认 { 或 [ 开头
    var v;
    try { v = Model.parseText ? Model.parseText(str) : JSON.parse(str); }
    catch (e) { return str; }                             // 不是合法 JSON：原样留着当普通字符串
    return (v !== null && typeof v === 'object') ? v : str;
  }

  // 原地替换（不复制对象图，大文件省一份内存和时间），返回顶层值
  Model.deepResolve = function (root) {
    deepReverts = [];
    if (root === null || typeof root !== 'object') return root;
    var stack = [{ v: root, d: 0 }];
    while (stack.length) {
      var it = stack.pop();
      var v = it.v;
      if (v === null || typeof v !== 'object' || it.d >= DEEP_MAX) continue;
      var arr = Array.isArray(v);
      var list = arr ? null : Object.keys(v);
      var n = arr ? v.length : list.length;
      for (var i = 0; i < n; i++) {
        var key = arr ? i : list[i];
        var e = v[key];
        if (typeof e === 'string') {
          var nv = tryNested(e);
          if (nv !== e) {
            v[key] = nv;
            deepReverts.push({ c: v, k: key, s: e });
            e = nv;
          }
        }
        if (e !== null && typeof e === 'object') stack.push({ v: e, d: it.d + 1 });
      }
    }
    return root;
  };

  // 还原成解析前的样子（同一份对象图上才能这么做）
  Model.deepRevert = function () {
    for (var i = deepReverts.length - 1; i >= 0; i--) {
      var r = deepReverts[i];
      r.c[r.k] = r.s;
    }
    var count = deepReverts.length;
    deepReverts = [];
    return count;
  };

  Model.serialize = function (node) {
    try {
      var json = JSON.stringify(node.raw, null, 2);
      // 还原大整数标记
      return json.replace(/"JPBIG_(-?\d+)"/g, '$1');
    } catch (e) { return String(node.raw); }
  };

  /* 行 hover 复制按钮用的 payload：这一行所代表节点的「完整值」，pretty + 带 key 包裹。
     entry.part 说明这行是节点的哪一部分：
       leaf / open -> 有值可复制；close（} ]）和 more（「还有 N 项」）没有，返回空串（不显示按钮）
     有 key 的行（"k": [、"k": "v"）包成 {"k": <完整值>}，这样单独粘贴出去也是合法 JSON；
     根节点 / 数组元素没有 key，直接输出值本身。
     注意 node.raw 是原始引用：折叠的和被分页截断的那部分一样在里面，复制永远是完整的整棵子树。 */
  // 这一行值不值得给复制按钮（轻量判断，hover 时每次都跑，不 stringify）
  Model.rowCopyable = function (entry) {
    if (!entry || !entry.node) return false;
    return entry.part !== 'close' && entry.part !== 'more';
  };

  Model.rowCopyText = function (entry) {
    if (!Model.rowCopyable(entry)) return '';
    var n = entry.node;
    if (n.key === null || n.key === undefined) return Model.serialize(n);
    try {
      var holder = {};
      holder[n.key] = n.raw;
      return JSON.stringify(holder, null, 2).replace(/"JPBIG_(-?\d+)"/g, '$1');
    } catch (e) {
      return Model.serialize(n);   // key 不合法等极端情况，退回「只复制值」
    }
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
    // 值现在整段渲染（超长由结果区自动换行），这里按完整长度估 Flatten 后的宽度
    if (n.kind === 'string') c += n.value.length + 2;
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
