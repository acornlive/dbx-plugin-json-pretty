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
      import_title: '选择本地 .json 文件导入（最大 2 MB）',
      drop_hint: '释放鼠标以导入 JSON 文件',
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
      ctx_paste: '粘贴',
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
      load_more: '⋯ 还有 {0} 项，点击加载更多',
      ws_title: '工作区',
      ws_expand_title: '展开工作区',
      ws_save: '保存',
      ws_save_title: '开启后：导入或粘贴的 JSON 会自动保存到工作区；关闭则用完即走，不落盘',
      ws_new_file: '＋文件',
      ws_new_file_title: '新建 JSON 文件',
      ws_new_folder: '＋目录',
      ws_new_folder_title: '新建文件夹',
      ws_collapse_title: '收起工作区，给右侧留出更多空间',
      tree_resizer_title: '拖动调整工作区宽度',
      ws_move: '移动',
      ws_move_title: '把「{0}」移动到：',
      ws_root: '（根目录）',
      ws_rename: '重命名',
      ws_delete: '删除',
      ws_show_in_folder: '打开本地文件夹',
      ws_show_in_folder_fail: '打开失败：{0}',
      ws_empty: '还没有文件。右键可新建，或点上方「＋文件」。',
      ws_offline: '工作区不可用：{0}',
      ws_read_fail: '读取文件失败：{0}',
      ws_save_fail: '保存失败：{0}',
      ws_create_fail: '新建失败：{0}',
      ws_rename_fail: '重命名失败：{0}',
      ws_move_fail: '移动失败：{0}',
      ws_delete_fail: '删除失败：{0}',
      ws_import_fail: '导入失败：{0}',
      ws_deleted: '已删除 {0}',
      ws_too_large: '内容 {0} KB 超过单次传输上限 {1} KB，未保存到工作区',
      big_auto: '内容较大（{0} 个节点），已自动折叠到第 {1} 层',
      expand_limited: '内容过大，「全部展开」已限制到第 {0} 层',
      auto_off: '内容超过 {0} 字符，已暂停自动格式化，请点「格式化」',
      plain_trunc: '\n\n…（内容过长，仅显示前 {0} 字符；复制仍为完整内容）',
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
      import_title: 'Choose a local .json file to import (max 2 MB)',
      drop_hint: 'Drop JSON files here to import',
      save: 'Export',
      save_title: 'Export as a JSON file (filename defaults to current time)',
      raw_data: 'Raw data (editable)',
      counter: '0 chars',
      copy: 'Copy',
      copy_input_title: 'Copy raw data',
      copy_output_title: 'Copy all result',
      placeholder: 'Paste JSON here, or click "Import" above',
      resizer_title: 'Drag to resize left/right',
      result: 'Result',
      expand_label: 'Expand',
      ctx_copy: 'Copy',
      ctx_paste: 'Paste',
      
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
      load_more: '⋯ {0} more, click to load',
      ws_title: 'Workspace',
      ws_expand_title: 'Expand the workspace',
      ws_save: 'Save',
      ws_save_title: 'On: imported or pasted JSON is saved to the workspace. Off: nothing is persisted',
      ws_new_file: '＋File',
      ws_new_file_title: 'New JSON file',
      ws_new_folder: '＋Folder',
      ws_new_folder_title: 'New folder',
      ws_collapse_title: 'Collapse the workspace to give the editor more room',
      tree_resizer_title: 'Drag to resize the workspace',
      ws_move: 'Move',
      ws_move_title: 'Move "{0}" to:',
      ws_root: '(Root)',
      ws_rename: 'Rename',
      ws_delete: 'Delete',
      ws_show_in_folder: 'Open Folder',
      ws_show_in_folder_fail: 'Failed to open: {0}',
      ws_empty: 'No files yet. Right-click to create one, or click "＋File" above.',
      ws_offline: 'Workspace unavailable: {0}',
      ws_read_fail: 'Failed to read file: {0}',
      ws_save_fail: 'Save failed: {0}',
      ws_create_fail: 'Create failed: {0}',
      ws_rename_fail: 'Rename failed: {0}',
      ws_move_fail: 'Move failed: {0}',
      ws_delete_fail: 'Delete failed: {0}',
      ws_import_fail: 'Import failed: {0}',
      ws_deleted: 'Deleted {0}',
      ws_too_large: 'Content is {0} KB, over the {1} KB transfer limit — not saved to the workspace',
      big_auto: 'Large content ({0} nodes): auto-collapsed to level {1}',
      expand_limited: 'Content too large: "Expand all" limited to level {0}',
      auto_off: 'Content over {0} chars: auto-format paused, click "Format"',
      plain_trunc: '\n\n… (too long, showing first {0} chars; copy still returns full)',
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
