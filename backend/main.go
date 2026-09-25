// JSON 格式化工具 —— 原生侧车（Go，纯标准库 + 官方 Go SDK）

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	dbxpluginsdk "github.com/acornlive/jsonpretty/dbx-plugin-sdk"
)

// 必须与 manifest.json 的 id / version 完全一致，否则宿主判定 Sidecar 身份不匹配并丢弃。
const (
	pluginID      = "chatawesome.cn.json-pretty"
	pluginVersion = "0.1.2"
)

type plugin struct{}

func badParams(format string, args ...any) *dbxpluginsdk.PluginError {
	return dbxpluginsdk.NewError(-32602, fmt.Sprintf(format, args...))
}

func failed(code int, err error) *dbxpluginsdk.PluginError {
	return dbxpluginsdk.NewError(code, err.Error())
}

func decodeParams(params json.RawMessage, out any) *dbxpluginsdk.PluginError {
	if len(params) > 0 {
		if err := json.Unmarshal(params, out); err != nil {
			return badParams("invalid params: %v", err)
		}
	}
	return nil
}

// ---------------- 请求分发 ----------------

func (p *plugin) Handle(
	_ dbxpluginsdk.RequestContext,
	method string,
	params json.RawMessage,
	_ *dbxpluginsdk.Emitter,
) (any, *dbxpluginsdk.PluginError) {
	switch method {

	case "jp/ping":
		return map[string]any{
			"ok": true, "plugin": pluginID, "version": resolveMetadata().Version,
			"dir": dataDir(), "maxContentBytes": maxContentBytes,
		}, nil

	case "jp/loadTree":
		d := loadDoc()
		return map[string]any{
			"ok":  true,
			"dir": dataDir(),
			"tree": map[string]any{
				"nodes":    d.Nodes,
				"activeId": d.ActiveID,
				"expanded": d.Expanded,
			},
			"prefs": d.Prefs,
		}, nil

	case "jp/createNode":
		var q struct {
			Type     string  `json:"type"`
			Name     string  `json:"name"`
			ParentID *string `json:"parentId"`
		}
		if e := decodeParams(params, &q); e != nil {
			return nil, e
		}
		res, err := opCreateNode(q.Type, q.Name, q.ParentID)
		if err != nil {
			return nil, failed(-32002, err)
		}
		return res, nil

	case "jp/renameNode":
		var q struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if e := decodeParams(params, &q); e != nil {
			return nil, e
		}
		res, err := opRenameNode(q.ID, q.Name)
		if err != nil {
			return nil, failed(-32002, err)
		}
		return res, nil

	case "jp/moveNode":
		var q struct {
			ID       string  `json:"id"`
			ParentID *string `json:"parentId"`
			Index    *int    `json:"index"`
		}
		if e := decodeParams(params, &q); e != nil {
			return nil, e
		}
		res, err := opMoveNode(q.ID, q.ParentID, q.Index)
		if err != nil {
			return nil, failed(-32002, err)
		}
		return res, nil

	case "jp/deleteNode":
		var q struct {
			ID string `json:"id"`
		}
		if e := decodeParams(params, &q); e != nil {
			return nil, e
		}
		res, err := opDeleteNode(q.ID)
		if err != nil {
			return nil, failed(-32002, err)
		}
		return res, nil

	case "jp/readFile":
		var q struct {
			ID string `json:"id"`
		}
		if e := decodeParams(params, &q); e != nil {
			return nil, e
		}
		res, err := opReadFile(q.ID)
		if err != nil {
			return nil, failed(-32004, err)
		}
		return res, nil

	case "jp/writeFile":
		var q struct {
			ID      string `json:"id"`
			Content string `json:"content"`
		}
		if e := decodeParams(params, &q); e != nil {
			return nil, e
		}
		res, err := opWriteFile(q.ID, q.Content)
		if err != nil {
			return nil, failed(-32005, err)
		}
		return res, nil

	case "jp/importFile":
		var q struct {
			Name     string  `json:"name"`
			Content  string  `json:"content"`
			ParentID *string `json:"parentId"`
		}
		if e := decodeParams(params, &q); e != nil {
			return nil, e
		}
		res, err := opImportFile(q.Name, q.Content, q.ParentID)
		if err != nil {
			return nil, failed(-32005, err)
		}
		return res, nil

	case "jp/setActive":
		var q struct {
			ID string `json:"id"`
		}
		if e := decodeParams(params, &q); e != nil {
			return nil, e
		}
		res, err := opSetActive(q.ID)
		if err != nil {
			return nil, failed(-32002, err)
		}
		return res, nil

	case "jp/setExpanded":
		var q struct {
			Expanded map[string]bool `json:"expanded"`
		}
		if e := decodeParams(params, &q); e != nil {
			return nil, e
		}
		res, err := opSetExpanded(q.Expanded)
		if err != nil {
			return nil, failed(-32002, err)
		}
		return res, nil

	case "jp/getPrefs":
		return map[string]any{"ok": true, "prefs": sanitizePrefs(loadDoc().Prefs)}, nil

	case "jp/setPrefs":
		var q struct {
			Prefs map[string]any `json:"prefs"`
		}
		if e := decodeParams(params, &q); e != nil {
			return nil, e
		}
		d := loadDoc()
		if d.Prefs == nil {
			d.Prefs = map[string]any{}
		}
		for k, v := range q.Prefs {
			if prefKeys[k] {
				d.Prefs[k] = v
			}
		}
		// 归一化后再写，避免把前端传来的坏值落盘
		d.Prefs = sanitizePrefs(d.Prefs)
		if err := saveDoc(d); err != nil {
			return nil, failed(-32012, fmt.Errorf("无法写入界面偏好：%v", err))
		}
		return map[string]any{"ok": true, "prefs": d.Prefs}, nil

	default:
		return nil, dbxpluginsdk.MethodNotFound(method)
	}
}

// resolveMetadata 构造启动时向宿主宣告的身份。
//
// 关键：包内 manifest.json 的版本优先于常量。宿主在两者不一致时会拒绝握手
// （Sidecar identity does not match manifest），而版本号随每次发版变化 ——
// 硬编码常量一旦忘记同步，侧车就会被整体丢弃，表现为「UI 里什么都存不了」。
func resolveMetadata() dbxpluginsdk.Metadata {
	caps := []string{"workspace"}
	fallback := dbxpluginsdk.Metadata{ID: pluginID, Version: pluginVersion, Capabilities: caps}
	exe, err := os.Executable()
	if err != nil {
		return fallback
	}
	dir := filepath.Dir(exe)
	for i := 0; i < 6; i++ {
		data, readErr := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if readErr == nil {
			var m struct {
				ID      string `json:"id"`
				Version string `json:"version"`
			}
			// 只有 id 与本插件一致的 manifest 才有权改写版本，避免误读宿主目录里的别的 manifest。
			if json.Unmarshal(data, &m) == nil && m.ID == pluginID && strings.TrimSpace(m.Version) != "" {
				fallback.Version = strings.TrimSpace(m.Version)
			}
			return fallback
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return fallback
}

func main() {
	_ = os.MkdirAll(dataDir(), 0o755)
	_ = os.MkdirAll(filesDir(), 0o755)

	metadata := resolveMetadata()
	server := dbxpluginsdk.NewServer(metadata, &plugin{})
	if err := server.Serve(); err != nil {
		fmt.Fprintf(os.Stderr, "[json-pretty] %v\n", err)
		os.Exit(1)
	}
}
