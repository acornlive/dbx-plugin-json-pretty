/* ============================================================
   i18n.js - DBX 插件国际化（中文 / 英文）
   跟随宿主语言：window.dbxPlugin.locale（没有时回退浏览器语言，再回退 en）。
   暴露到全局：locale() / t(key, ...args) / __i18nNorm()
   ============================================================ */
(function () {
  'use strict';

  // 当前语言：宿主优先，其次浏览器，再回退英文
  // （用户参考实现：window.dbxPlugin?.locale || "en"）
  function locale() {
    if (window.dbxPlugin && window.dbxPlugin.locale) return window.dbxPlugin.locale;
    if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
    return 'en';
  }

  // 归一化到 zh / en（其他一律回退英文）
  function norm(l) {
    l = (l || '').toLowerCase();
    if (l.indexOf('zh') === 0) return 'zh';
    return 'en';
  }

  var DICT = {
    zh: {
      compress: '压缩',
      format: '格式化',
      formatted: '已格式化',
      escape: '转义',
      unescape: '去转义',
      collapse_all: '全部折叠',
      expand_all: '全部展开',
      clear: '清空',
      import: '导入',
      import_title: '选择本地 .json 文件导入',
      save: '导出',
      save_title: '导出为 JSON 文件（文件名默认为当前时间）',
      raw_data: '原始数据（可编辑）',
      counter: '0 字符',
      copy: '复制',
      copy_input_title: '复制原始数据',
      copy_output_title: '复制结果全部内容',
      placeholder: '在此粘贴 JSON，或点上方「导入」',
      resizer_title: '拖动调整左右宽度',
      result: '结果',
      expand_label: '展开',
      ctx_copy: '复制',
      chars: ' 字符',
      sel_or_dbl: '请先选择或双击 JSON 内容',
      copied_sel: '已复制所选内容到剪贴板 ✓',
      copied_sel_ok: '已复制所选内容 ✓',
      copied_flash: '已复制 ✓',
      copy_fail: '复制失败',
      copy_fail_manual: '复制失败，请手动选择',
      no_copy: '没有可复制的内容',
      copied_all: '已复制全部内容 ✓',
      copied_raw: '已复制原始数据 ✓',
      file_read_fail: '文件读取失败：{0}',
      loaded: '已加载 {0} · 层级 {1} · {2} 键 · {3} 项数组元素',
      loaded_err: '已加载 {0}，但 JSON 解析错误：{1}',
      json_err: 'JSON 错误：{0}',
      saved: '已保存 {0}',
      saved_raw_tail: '（内容非合法 JSON，已保存原文）',
      save_fail: '保存失败：{0}',
      no_save: '没有可保存的内容',
      no_file_picker: '当前环境不支持文件选择',
      fmt_first: '请先格式化 JSON',
      expanded_all: '已全部展开 · 共 {0} 层',
      expanded_to: '已展开到 {0} 级',
      unit_items: ' 项',
      unit_keys: ' 个键',
      compressed: '已压缩 · {0} 字符',
      escaped: '已转义为字符串字面量',
      input_empty: '输入为空',
      unescape_fail: '去转义失败：{0}',
      unescaped: '已去转义并格式化 · 层级 {0}',
      collapsed_all: '已全部折叠',
      lvl_title: '展开到第 {0} 层',
      lvl_all_title: '展开全部层级',
      lvl_all: '全部',
      lvl_n: '{0} 级'
    },
    en: {
      compress: 'Compress',
      format: 'Format',
      formatted: 'Formatted',
      escape: 'Escape',
      unescape: 'Unescape',
      collapse_all: 'Collapse all',
      expand_all: 'Expand all',
      clear: 'Clear',
      import: 'Import',
      import_title: 'Choose a local .json file to import',
      save: 'Export',
      save_title: 'Export as a JSON file (filename defaults to current time)',
      raw_data: 'Raw data (editable)',
      counter: '0 chars',
      copy: 'Copy',
      copy_input_title: 'Copy raw data',
      copy_output_title: 'Copy all result',
      placeholder: 'Paste JSON here, or click “Import” above',
      resizer_title: 'Drag to resize left/right',
      result: 'Result',
      expand_label: 'Expand',
      ctx_copy: 'Copy',
      chars: ' chars',
      sel_or_dbl: 'Select or double-click JSON content first',
      copied_sel: 'Copied selection to clipboard ✓',
      copied_sel_ok: 'Copied selection ✓',
      copied_flash: 'Copied ✓',
      copy_fail: 'Copy failed',
      copy_fail_manual: 'Copy failed, please select manually',
      no_copy: 'Nothing to copy',
      copied_all: 'Copied all ✓',
      copied_raw: 'Copied raw data ✓',
      file_read_fail: 'Failed to read file: {0}',
      loaded: 'Loaded {0} · depth {1} · {2} keys · {3} array items',
      loaded_err: 'Loaded {0}, but JSON parse error: {1}',
      json_err: 'JSON error: {0}',
      saved: 'Saved {0}',
      saved_raw_tail: '(content is not valid JSON; raw text saved)',
      save_fail: 'Save failed: {0}',
      no_save: 'Nothing to save',
      no_file_picker: 'File picker is not supported in this environment',
      fmt_first: 'Please format JSON first',
      expanded_all: 'Expanded all · {0} levels',
      expanded_to: 'Expanded to level {0}',
      unit_items: ' items',
      unit_keys: ' keys',
      compressed: 'Compressed · {0} chars',
      escaped: 'Escaped to string literal',
      input_empty: 'Input is empty',
      unescape_fail: 'Unescape failed: {0}',
      unescaped: 'Unescaped and formatted · depth {0}',
      collapsed_all: 'Collapsed all',
      lvl_title: 'Expand to level {0}',
      lvl_all_title: 'Expand all levels',
      lvl_all: 'All',
      lvl_n: 'Lv {0}'
    }
  };

  // t(key, ...args)：args 按 {0} {1} ... 顺序填入
  function t(key) {
    var lang = norm(locale());
    var table = DICT[lang] || DICT.en;
    var s = (key in table) ? table[key] : (key in DICT.en ? DICT.en[key] : key);
    var args = Array.prototype.slice.call(arguments, 1);
    if (args.length) {
      s = s.replace(/\{(\d+)\}/g, function (_, i) {
        return (args[+i] != null) ? args[+i] : '';
      });
    }
    return s;
  }

  window.locale = locale;
  window.t = t;
  window.__i18nNorm = norm;
})();
