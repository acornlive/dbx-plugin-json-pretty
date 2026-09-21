# JSON 格式化工具 · DBX 插件

纯前端的 DBX 工作台插件：在 DBX 内格式化、压缩、折叠、转义 JSON。数据全部在本机处理，不上传网络。

## 功能

| 功能 | 说明 |
| --- | --- |
| 自动格式化 | 输入即自动以 2 空格缩进美化，左侧编辑区同步回填，右侧生成带高亮的可折叠树 |
| 格式化 | 手动重新美化，一键从压缩 / 转义结果回到格式化树 |
| 压缩 / 转义 / 去转义 | 输出单行 JSON，或与字符串字面量互相转换 |
| 折叠 / 展开 | 逐节点折叠；层级按钮按实际深度生成（最多 10 级 + 全部） |
| 复制 | 左 / 右标题「复制」按钮 + 右键菜单（所选或整段） |
| 导入 / 导出 | 「导入」选本地 `.json` 文件；「导出」经宿主落盘，文件名默认当前时间 |
| 国际化 | 跟随 DBX 语言（中 / 英）实时切换 |
| 分栏 / 主题 | 拖动分隔条调宽度，双击复位；自适应浅 / 深主题 |

## 目录结构

```text
dbx-plugin-json-pretty/
├── manifest.json          # 插件清单（身份 / 权限 / 入口 / 贡献点）
├── dbx-plugin.toml        # 打包与开发配置
├── assets/plugin.svg      # 插件图标
└── ui/                    # 沙箱工作台静态 UI
    ├── index.html
    ├── style.css
    ├── i18n.js            # 中 / 英国际化
    └── app.js
```

## 开发与打包

```bash

# 打包
npx dbx-plugin package . --output-dir dist
# 产物：dist/io.github.workbuddy.json-pretty-0.1.0-universal.dbxp
```


详见 DBX 官方文档：<https://dbxio.com/cn/docs/plugin-development>
