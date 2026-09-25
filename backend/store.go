package main

// 工作区存储模型
// -----------------------------------------------------------------------------
//   - 索引：<dataDir>/workspace.json（id / 类型 / 名称 / 父子关系 / 时间戳 + UI 状态）
//   - 正文：<dataDir>/files/<id>.json（每个文件一个独立文件）
//
// 为什么正文按 id 存而不是按「文件夹层级/名称.json」落盘：
//   1) 重命名、移动只改索引，不需要搬动磁盘文件，不会出现「改名失败留下半个文件」；
//   2) 名称里的非法字符（\ / : * ? 等）完全不参与路径拼接，没有路径穿越面；
//   3) 写一个文件不会重写整个索引，写入放大可控。
//
// 为什么正文不塞进 workspace.json：本工具面向大 JSON，单文件可能上 MB，
// 任何一次保存都重写整份索引会让写盘成本随文件数线性增长。

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

const docVersion = 2

// maxContentBytes：宿主对 invoke 参数有 2 MiB 硬上限（enforcePayloadLimit），
// 超出会在宿主侧直接拒绝，前端拿到的只是一个含糊的失败。这里在后端再守一道，
// 并把上限回报给前端，让它能提前提示而不是等到传输失败。
const maxContentBytes = 1900 * 1000

type Node struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"` // "folder" | "file"
	Name      string  `json:"name"`
	ParentID  *string `json:"parentId"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
	Size      int64   `json:"size,omitempty"`
}

type Doc struct {
	Version  int             `json:"version"`
	Nodes    []Node          `json:"nodes"`
	ActiveID string          `json:"activeId,omitempty"`
	Expanded map[string]bool `json:"expanded,omitempty"`
	Prefs    map[string]any  `json:"prefs,omitempty"`
}

func nowStr() string { return time.Now().Format(time.RFC3339) }

func newID() string { return fmt.Sprintf("n%d%x", time.Now().UnixNano(), rand.Uint32()) }

// id 会参与文件名拼接，必须严格白名单 —— 前端传来的 id 一律当不可信数据对待。
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func safeID(id string) bool { return idPattern.MatchString(id) }

// ---------------- 目录 ----------------

func dataDir() string {
	if d := strings.TrimSpace(os.Getenv("DBX_PLUGIN_DATA_DIR")); d != "" {
		return d
	}
	if d := strings.TrimSpace(os.Getenv("DBX_PLUGIN_SPACE")); d != "" {
		return d
	}
	if base, err := os.UserConfigDir(); err == nil && base != "" {
		return filepath.Join(base, "dbx", "plugins", pluginID)
	}
	return filepath.Join(".", "data")
}

func filesDir() string          { return filepath.Join(dataDir(), "files") }
func indexPath() string         { return filepath.Join(dataDir(), "workspace.json") }
func filePath(id string) string { return filepath.Join(filesDir(), id+".json") }

// ---------------- 索引读写 ----------------

func blankDoc() Doc {
	return Doc{Version: docVersion, Nodes: []Node{}, Expanded: map[string]bool{}, Prefs: map[string]any{}}
}

func loadDoc() Doc {
	b, err := os.ReadFile(indexPath())
	if err != nil {
		return blankDoc()
	}
	var d Doc
	if json.Unmarshal(b, &d) != nil {
		return blankDoc()
	}
	if d.Nodes == nil {
		d.Nodes = []Node{}
	}
	if d.Expanded == nil {
		d.Expanded = map[string]bool{}
	}
	if d.Prefs == nil {
		d.Prefs = map[string]any{}
	}
	return d
}

func saveDoc(d Doc) error {
	if d.Version == 0 {
		d.Version = docVersion
	}
	if d.Nodes == nil {
		d.Nodes = []Node{}
	}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(indexPath(), b)
}

// ---------------- 节点工具 ----------------

func findNode(d Doc, id string) (int, *Node) {
	for i := range d.Nodes {
		if d.Nodes[i].ID == id {
			return i, &d.Nodes[i]
		}
	}
	return -1, nil
}

func sameParent(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

// subtreeIDs 返回 rootID 及其全部后代的 id 集合。
func subtreeIDs(d Doc, rootID string) map[string]bool {
	inc := map[string]bool{rootID: true}
	changed := true
	round := 0
	for changed && round < 64 {
		changed = false
		round++
		for _, n := range d.Nodes {
			if n.ParentID != nil && inc[*n.ParentID] && !inc[n.ID] {
				inc[n.ID] = true
				changed = true
			}
		}
	}
	return inc
}

// isDescendant 判断 id 是否在 ancestorID 的子树内（含自身相等）。
func isDescendant(d Doc, ancestorID, id string) bool {
	byID := map[string]Node{}
	for _, n := range d.Nodes {
		byID[n.ID] = n
	}
	cur := id
	for guard := 0; guard < 256; guard++ {
		if cur == ancestorID {
			return true
		}
		n, ok := byID[cur]
		if !ok || n.ParentID == nil {
			return false
		}
		cur = *n.ParentID
	}
	return false
}

func sanitizeName(name string) string {
	s := strings.TrimSpace(name)
	if s == "" {
		s = "untitled"
	}
	repl := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "*", "_", "?", "_",
		"\"", "_", "<", "_", ">", "_", "|", "_")
	s = repl.Replace(s)
	s = strings.Trim(s, ". ")
	if s == "" {
		s = "untitled"
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

func defaultName(typ string) string {
	if typ == "folder" {
		return "新建文件夹"
	}
	return "新建文件.json"
}

// uniqueName 在同层里避开重名（大小写不敏感），追加 " (2)" 后缀。
func uniqueName(nodes []Node, parentID *string, name, excludeID string) string {
	used := map[string]bool{}
	for _, n := range nodes {
		if n.ID == excludeID {
			continue
		}
		if sameParent(n.ParentID, parentID) {
			used[strings.ToLower(n.Name)] = true
		}
	}
	if !used[strings.ToLower(name)] {
		return name
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 2; ; i++ {
		cand := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if !used[strings.ToLower(cand)] {
			return cand
		}
	}
}

// 注意：这里刻意【不】在首次运行时塞示例文件。
// 工作区默认是「用完即走」—— 只有用户在标题栏勾了「保存」才落盘，
// 所以初始状态就该是空的，别凭空造一个用户没要求过的文件出来。

// ---------------- 操作 ----------------

func opCreateNode(typ, name string, parentID *string) (any, error) {
	typ = strings.TrimSpace(typ)
	if typ != "folder" && typ != "file" {
		return nil, fmt.Errorf("type must be folder or file")
	}
	d := loadDoc()
	_ = os.MkdirAll(filesDir(), 0o755)

	if parentID != nil {
		if !safeID(*parentID) {
			return nil, fmt.Errorf("invalid parentId")
		}
		i, p := findNode(d, *parentID)
		if p == nil {
			return nil, fmt.Errorf("parent not found")
		}
		if d.Nodes[i].Type != "folder" {
			return nil, fmt.Errorf("parent is not a folder")
		}
		d.Expanded[*parentID] = true
	}

	nm := sanitizeName(name)
	if strings.TrimSpace(name) == "" {
		nm = defaultName(typ)
	}
	nm = uniqueName(d.Nodes, parentID, nm, "")

	id := newID()
	now := nowStr()
	node := Node{ID: id, Type: typ, Name: nm, ParentID: parentID, CreatedAt: now, UpdatedAt: now}
	if typ == "file" {
		if err := writeAtomic(filePath(id), []byte("")); err != nil {
			return nil, err
		}
		d.ActiveID = id
	}
	d.Nodes = append(d.Nodes, node)
	if err := saveDoc(d); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "node": node}, nil
}

func opRenameNode(id, name string) (any, error) {
	if !safeID(id) {
		return nil, fmt.Errorf("invalid id")
	}
	d := loadDoc()
	_, n := findNode(d, id)
	if n == nil {
		return nil, fmt.Errorf("node not found")
	}
	nm := sanitizeName(name)
	if strings.TrimSpace(name) == "" {
		nm = defaultName(n.Type)
	}
	n.Name = uniqueName(d.Nodes, n.ParentID, nm, id)
	n.UpdatedAt = nowStr()
	if err := saveDoc(d); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "node": *n}, nil
}

// opMoveNode 把节点移动到 parentID 下（nil = 根），index 为同层插入位置；
// index 为 nil 或越界时追加到末尾。
func opMoveNode(id string, parentID *string, index *int) (any, error) {
	if !safeID(id) {
		return nil, fmt.Errorf("invalid id")
	}
	d := loadDoc()
	_, n := findNode(d, id)
	if n == nil {
		return nil, fmt.Errorf("node not found")
	}
	if parentID != nil {
		if !safeID(*parentID) {
			return nil, fmt.Errorf("invalid parentId")
		}
		if *parentID == id {
			return nil, fmt.Errorf("cannot move a node into itself")
		}
		i, p := findNode(d, *parentID)
		if p == nil {
			return nil, fmt.Errorf("target folder not found")
		}
		if d.Nodes[i].Type != "folder" {
			return nil, fmt.Errorf("target is not a folder")
		}
		// 把文件夹拖进自己的子树会让整棵子树从树上脱落（环）。
		if isDescendant(d, id, *parentID) {
			return nil, fmt.Errorf("cannot move a folder into its own subtree")
		}
		d.Expanded[*parentID] = true
	}

	pos := -1
	for i := range d.Nodes {
		if d.Nodes[i].ID == id {
			pos = i
			break
		}
	}
	moved := d.Nodes[pos]
	moved.ParentID = parentID
	moved.UpdatedAt = nowStr()
	d.Nodes = append(d.Nodes[:pos], d.Nodes[pos+1:]...)

	moved.Name = uniqueName(d.Nodes, parentID, moved.Name, id)

	// 目标插入点：按新父节点下的同层顺序定位；空父节点则放到末尾。
	sib := []int{}
	for i := range d.Nodes {
		if sameParent(d.Nodes[i].ParentID, parentID) {
			sib = append(sib, i)
		}
	}
	insertAt := len(d.Nodes)
	if index != nil && *index >= 0 && *index < len(sib) {
		insertAt = sib[*index]
	} else if len(sib) > 0 {
		insertAt = sib[len(sib)-1] + 1
	}
	d.Nodes = append(d.Nodes, Node{})
	copy(d.Nodes[insertAt+1:], d.Nodes[insertAt:])
	d.Nodes[insertAt] = moved

	if err := saveDoc(d); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "node": moved}, nil
}

func opDeleteNode(id string) (any, error) {
	if !safeID(id) {
		return nil, fmt.Errorf("invalid id")
	}
	d := loadDoc()
	_, n := findNode(d, id)
	if n == nil {
		return nil, fmt.Errorf("node not found")
	}
	inc := subtreeIDs(d, id)
	kept := []Node{}
	deleted := []string{} // 全部被删节点（前端据此从树里摘掉整棵子树）
	files := []string{}   // 其中有正文需要一并删除的文件
	for _, x := range d.Nodes {
		if inc[x.ID] {
			deleted = append(deleted, x.ID)
			if x.Type == "file" {
				files = append(files, x.ID)
			}
			continue
		}
		kept = append(kept, x)
	}
	d.Nodes = kept
	if inc[d.ActiveID] {
		d.ActiveID = ""
	}
	for _, rid := range files {
		_ = os.Remove(filePath(rid))
	}
	if err := saveDoc(d); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "deletedIds": deleted}, nil
}

func opReadFile(id string) (any, error) {
	if !safeID(id) {
		return nil, fmt.Errorf("invalid id")
	}
	d := loadDoc()
	_, n := findNode(d, id)
	if n == nil {
		return nil, fmt.Errorf("file not found")
	}
	if n.Type != "file" {
		return nil, fmt.Errorf("node is not a file")
	}
	data, err := os.ReadFile(filePath(id))
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	return map[string]any{
		"ok": true, "id": n.ID, "name": n.Name,
		"content": string(data), "size": len(data),
	}, nil
}

func opWriteFile(id, content string) (any, error) {
	if !safeID(id) {
		return nil, fmt.Errorf("invalid id")
	}
	if len(content) > maxContentBytes {
		return nil, fmt.Errorf("content too large: %d bytes (limit %d)", len(content), maxContentBytes)
	}
	d := loadDoc()
	i, n := findNode(d, id)
	if n == nil {
		return nil, fmt.Errorf("file not found")
	}
	if d.Nodes[i].Type != "file" {
		return nil, fmt.Errorf("node is not a file")
	}
	if err := writeAtomic(filePath(id), []byte(content)); err != nil {
		return nil, err
	}
	d.Nodes[i].Size = int64(len(content))
	d.Nodes[i].UpdatedAt = nowStr()
	if err := saveDoc(d); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "id": id, "size": len(content), "updatedAt": d.Nodes[i].UpdatedAt}, nil
}

// opImportFile 用一段外部内容在工作区里新建一个文件（「导入」走这里）。
func opImportFile(name, content string, parentID *string) (any, error) {
	if len(content) > maxContentBytes {
		return nil, fmt.Errorf("content too large: %d bytes (limit %d)", len(content), maxContentBytes)
	}
	res, err := opCreateNode("file", name, parentID)
	if err != nil {
		return nil, err
	}
	m, ok := res.(map[string]any)
	node, ok2 := Node{}, false
	if ok {
		node, ok2 = m["node"].(Node)
	}
	if !ok2 || node.ID == "" {
		return nil, fmt.Errorf("unexpected create result")
	}
	if err := writeAtomic(filePath(node.ID), []byte(content)); err != nil {
		return nil, err
	}
	d := loadDoc()
	for i := range d.Nodes {
		if d.Nodes[i].ID == node.ID {
			d.Nodes[i].Size = int64(len(content))
			node = d.Nodes[i]
		}
	}
	if err := saveDoc(d); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "node": node}, nil
}

func opSetActive(id string) (any, error) {
	d := loadDoc()
	if id == "" {
		d.ActiveID = ""
		return map[string]any{"ok": true}, saveDoc(d)
	}
	if !safeID(id) {
		return nil, fmt.Errorf("invalid id")
	}
	_, n := findNode(d, id)
	if n == nil {
		return nil, fmt.Errorf("node not found")
	}
	d.ActiveID = id
	return map[string]any{"ok": true}, saveDoc(d)
}

func opSetExpanded(expanded map[string]bool) (any, error) {
	d := loadDoc()
	if d.Expanded == nil {
		d.Expanded = map[string]bool{}
	}
	for k, v := range expanded {
		if !safeID(k) {
			continue
		}
		d.Expanded[k] = v
	}
	return map[string]any{"ok": true}, saveDoc(d)
}

// ---------------- UI 偏好 ----------------

// saveEnabled 也走同一份偏好：默认「用完即走」，用户勾了才落盘。
// 它必须进白名单，否则 jp/setPrefs 会把这个键静默丢掉，刷新后开关又回到关闭。
var prefKeys = map[string]bool{
	"treeWidth":     true,
	"treeCollapsed": true,
	"splitRatio":    true,
	"saveEnabled":   true,
}

func prefInt(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return int(n), true
		}
	}
	return 0, false
}

func prefFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case json.Number:
		if f, err := t.Float64(); err == nil {
			return f, true
		}
	}
	return 0, false
}

// sanitizePrefs 只保留白名单键并钳到合理范围（坏值不该把界面卡死）。
// 数值必须同时认 float64 与 int：这个函数会被调用两次（读盘后一次、合并写入前一次），
// 第二次拿到的已经不是 JSON 解出来的 float64。
func sanitizePrefs(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		if !prefKeys[k] {
			continue
		}
		switch k {
		case "treeWidth":
			n, ok := prefInt(v)
			if !ok {
				continue
			}
			if n < 160 {
				n = 160
			}
			if n > 560 {
				n = 560
			}
			out[k] = n
		case "treeCollapsed", "saveEnabled":
			b, ok := v.(bool)
			if !ok {
				continue
			}
			out[k] = b
		case "splitRatio":
			f, ok := prefFloat(v)
			if !ok {
				continue
			}
			if f < 0.1 {
				f = 0.1
			}
			if f > 0.9 {
				f = 0.9
			}
			out[k] = f
		}
	}
	return out
}

// ---------------- 原子写 ----------------

var tmpSeq uint64

func writeAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// tmp 名必须唯一：同一目录可能被多个侧车实例同时写，共用一个固定名会让两个进程
	// 互相覆盖对方的半成品，甚至把半截内容 rename 成正式文件 —— 索引损坏的后果是整库丢失。
	tmp := fmt.Sprintf("%s.%d.%d.tmp", path, os.Getpid(), atomic.AddUint64(&tmpSeq, 1))
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
