package main

// 工作区存储模型
// -----------------------------------------------------------------------------
//   - 索引：<dataDir>/workspace.json（id / 类型 / 名称 / 父子关系 / 时间戳 + UI 状态）
//   - 正文：<dataDir>/files/<tree-path>（目录/文件名与工作区树完全一致）
//
// 为什么正文按树路径落盘而不是按 id 存：
//   "打开本地文件夹"功能要求用户能在文件管理器里找到实际文件，
//   用 UUID 命名会导致文件夹里一堆无意义文件名，完全无法对应。
//   树路径方案确保 files/ 目录结构与工作区所见一致。
//
// 为什么正文不塞进 workspace.json：本工具面向大 JSON，单文件可能上 MB，
// 任何一次保存都重写整份索引会让写盘成本随文件数线性增长。

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
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

func filesDir() string  { return filepath.Join(dataDir(), "jpfiles") }
func indexPath() string { return filepath.Join(dataDir(), "workspace.json") }

// nodePathParts 从节点沿 parentId 链回溯到根，返回路径段（用于拼接文件系统路径）。
// 返回的路径段已包含文件名（对文件）或目录名（对文件夹），各段经 sanitizeName 处理过。
func nodePathParts(nodes []Node, id string) []string {
	byID := make(map[string]Node, len(nodes))
	for _, n := range nodes {
		byID[n.ID] = n
	}
	var parts []string
	cur := id
	for guard := 0; guard < 256; guard++ {
		n, ok := byID[cur]
		if !ok {
			break
		}
		parts = append([]string{n.Name}, parts...)
		if n.ParentID == nil {
			break
		}
		cur = *n.ParentID
	}
	return parts
}

// filePath 根据工作区树结构计算节点在文件系统上的真实路径。
// 这样 files/ 下的目录/文件名与工作区所见完全一致，用户用"打开本地文件夹"能直接找到对应文件。
func filePath(nodes []Node, id string) string {
	parts := nodePathParts(nodes, id)
	if len(parts) == 0 {
		return filepath.Join(filesDir(), id)
	}
	return filepath.Join(filesDir(), filepath.Join(parts...))
}

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

	// 必须先把节点加进数组再调用 filePath —— 否则 nodePathParts 回溯不到新节点，
	// 会回退到 files/<id> 的旧格式路径，留下一个 UUID 命名的孤儿空文件。
	d.Nodes = append(d.Nodes, node)

	if typ == "file" {
		if err := writeAtomic(filePath(d.Nodes, id), []byte("")); err != nil {
			return nil, err
		}
		d.ActiveID = id
	} else {
		// 文件夹：创建对应的磁盘目录，让"打开本地文件夹"时能看到与树一致的结构
		_ = os.MkdirAll(filePath(d.Nodes, id), 0o755)
	}
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

	oldPath := filePath(d.Nodes, id)

	nm := sanitizeName(name)
	if strings.TrimSpace(name) == "" {
		nm = defaultName(n.Type)
	}
	n.Name = uniqueName(d.Nodes, n.ParentID, nm, id)
	n.UpdatedAt = nowStr()

	newPath := filePath(d.Nodes, id)
	if oldPath != newPath {
		// 旧路径可能不存在（新建未写入的文件），忽略错误
		if _, stErr := os.Stat(oldPath); stErr == nil {
			if err := os.MkdirAll(filepath.Dir(newPath), 0o755); err != nil {
				return nil, fmt.Errorf("rename: mkdir parent: %w", err)
			}
			if err := os.Rename(oldPath, newPath); err != nil {
				return nil, fmt.Errorf("rename: %w", err)
			}
		}
	}

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

	// 在修改节点结构前先保存旧路径（os.Rename 移动整个子树之前需要知道原位置）
	oldPath := filePath(d.Nodes, id)

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

	// 移动磁盘上的文件/目录：os.Rename 对目录会递归移动整棵子树
	newPath := filePath(d.Nodes, id)
	if oldPath != newPath {
		if _, stErr := os.Stat(oldPath); stErr == nil {
			if err := os.MkdirAll(filepath.Dir(newPath), 0o755); err != nil {
				return nil, fmt.Errorf("move: mkdir parent: %w", err)
			}
			if err := os.Rename(oldPath, newPath); err != nil {
				return nil, fmt.Errorf("move: %w", err)
			}
		}
	}

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

	// 在删除节点之前先记录磁盘路径 —— filePath 依赖 d.Nodes 回溯源链，
	// 一旦节点从数组里移除就无法回溯了。
	toRemove := map[string]bool{}
	for _, x := range d.Nodes {
		if inc[x.ID] {
			toRemove[filePath(d.Nodes, x.ID)] = true
		}
	}

	kept := []Node{}
	deleted := []string{}
	for _, x := range d.Nodes {
		if inc[x.ID] {
			deleted = append(deleted, x.ID)
			continue
		}
		kept = append(kept, x)
	}
	d.Nodes = kept
	if inc[d.ActiveID] {
		d.ActiveID = ""
	}

	// 先保存索引，再清理磁盘（即使清理失败，索引已指向新状态，不会丢数据）
	if err := saveDoc(d); err != nil {
		return nil, err
	}

	for p := range toRemove {
		_ = os.RemoveAll(p) // RemoveAll：文件直接删；空目录也顺带清理
	}

	return map[string]any{"ok": true, "deletedIds": deleted}, nil
}

func opReadFile(id string, maxBytes int) (any, error) {
	if !safeID(id) {
		return nil, fmt.Errorf("invalid id")
	}
	if maxBytes <= 0 {
		// 没传限制时用安全上限：宿主 RPC 传输层有 2 MiB 硬限额，
		// JSON 编码会让字符串膨胀（转义），取 1.5 MiB 留余量。
		maxBytes = 1500 * 1000
	}
	d := loadDoc()
	_, n := findNode(d, id)
	if n == nil {
		return nil, fmt.Errorf("file not found")
	}
	if n.Type != "file" {
		return nil, fmt.Errorf("node is not a file")
	}
	path := filePath(d.Nodes, id)
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	if info.Size() > int64(maxBytes) {
		return nil, fmt.Errorf("file too large: %d bytes (limit %d)", info.Size(), maxBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	return map[string]any{
		"ok": true, "id": n.ID, "name": n.Name,
		"content": string(data), "size": len(data),
	}, nil
}

// ---------------- 分块读取 ----------------
// 写入路径有分块机制（beginWrite/appendChunk/endWrite）能绕过宿主 2 MiB 传输限额，
// 但读取路径一直没有对应机制，大文件单次 RPC 返回整个内容会超时或被宿主拒收。
// opReadFileChunk 弥补这一点：前端按 offset + length 逐块拉取，每次只传一小段字符串。
func opReadFileChunk(id string, offset, length int) (any, error) {
	if !safeID(id) {
		return nil, fmt.Errorf("invalid id")
	}
	if offset < 0 || length <= 0 || length > maxChunkBytes*2 {
		return nil, fmt.Errorf("invalid offset/length")
	}
	d := loadDoc()
	_, n := findNode(d, id)
	if n == nil {
		return nil, fmt.Errorf("file not found")
	}
	if n.Type != "file" {
		return nil, fmt.Errorf("node is not a file")
	}

	path := filePath(d.Nodes, id)
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("stat: %w", err)
	}
	total := int(info.Size())
	if offset >= total {
		return map[string]any{
			"ok": true, "id": n.ID,
			"offset": offset, "length": 0, "total": total,
			"content": "",
		}, nil
	}

	readLen := length
	if offset+readLen > total {
		readLen = total - offset
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}
	defer f.Close()

	if _, err := f.Seek(int64(offset), 0); err != nil {
		return nil, fmt.Errorf("seek: %w", err)
	}

	buf := make([]byte, readLen)
	nread, err := f.Read(buf)
	if err != nil && err != io.EOF {
		return nil, fmt.Errorf("read: %w", err)
	}

	return map[string]any{
		"ok":      true,
		"id":      n.ID,
		"offset":  offset,
		"length":  nread,
		"total":   total,
		"content": string(buf[:nread]),
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
	if err := writeAtomic(filePath(d.Nodes, id), []byte(content)); err != nil {
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
	d := loadDoc()
	if err := writeAtomic(filePath(d.Nodes, node.ID), []byte(content)); err != nil {
		return nil, err
	}
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

// ---------------- 分块写入 ----------------
// 拖放导入走 fileTransfer.read() 流式读取，每个 chunk 单独一次 RPC 推给后端；
// 单次 invoke 参数不会超过 500 KB，远低于宿主 2 MiB 硬上限，多 GB 文件也能落盘。

const maxChunkBytes = 500 * 1024 // 解码后的原始字节上限（256 KB chunk 经 base64 膨化 ≈ 341 KB）

func opBeginWrite(id string) (any, error) {
	if !safeID(id) {
		return nil, fmt.Errorf("invalid id")
	}
	d := loadDoc()
	_, n := findNode(d, id)
	if n == nil {
		return nil, fmt.Errorf("node not found")
	}
	if n.Type != "file" {
		return nil, fmt.Errorf("not a file")
	}
	_ = os.Remove(tmpChunkPath(d.Nodes, id))
	return map[string]any{"ok": true}, nil
}

func opAppendChunk(id, b64 string) (any, error) {
	if !safeID(id) {
		return nil, fmt.Errorf("invalid id")
	}
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("invalid base64 chunk")
	}
	if len(decoded) > maxChunkBytes {
		return nil, fmt.Errorf("chunk too large: %d bytes (limit %d)", len(decoded), maxChunkBytes)
	}
	// 需要文档来解析路径（分块写入的文件可能刚创建，路径依赖树结构）
	d := loadDoc()
	if _, n := findNode(d, id); n == nil {
		return nil, fmt.Errorf("node not found")
	}
	tmpPath := tmpChunkPath(d.Nodes, id)
	f, err := os.OpenFile(tmpPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Write(decoded); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func opEndWrite(id string) (any, error) {
	if !safeID(id) {
		return nil, fmt.Errorf("invalid id")
	}
	d := loadDoc()
	i, n := findNode(d, id)
	if n == nil {
		return nil, fmt.Errorf("node not found")
	}
	if n.Type != "file" {
		return nil, fmt.Errorf("not a file")
	}
	tmpPath := tmpChunkPath(d.Nodes, id)
	stat, err := os.Stat(tmpPath)
	if err != nil {
		return nil, fmt.Errorf("no pending write for %s", id)
	}
	finalPath := filePath(d.Nodes, id)
	_ = os.Remove(finalPath)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return nil, err
	}
	d.Nodes[i].Size = stat.Size()
	d.Nodes[i].UpdatedAt = nowStr()
	if err := saveDoc(d); err != nil {
		fmt.Fprintf(os.Stderr, "[jp] saveDoc after endWrite failed: %v\n", err)
	}
	return map[string]any{"ok": true, "size": stat.Size(), "updatedAt": d.Nodes[i].UpdatedAt}, nil
}

func tmpChunkPath(nodes []Node, id string) string { return filePath(nodes, id) + ".chunk" }

// ---------------- 文件系统同步（启动时清理孤儿文件） ----------------
// syncFS 遍历 files/ 目录，删除不属于任何当前工作区节点的孤儿文件。
// 这些孤儿文件的来源：此前 opCreateNode 在节点未加入数组时调 filePath，
// 回退到 files/<id> 路径写了一个空文件；后续 deleteNode 按正确树路径删，
// 孤儿文件永远留在磁盘上。本函数在 main() 启动时调用一次。
func syncFS() {
	d := loadDoc()
	if len(d.Nodes) == 0 {
		return
	}

	// 收集所有预期存在的路径（含 .chunk 临时文件）
	expected := map[string]bool{}
	for _, n := range d.Nodes {
		expected[filePath(d.Nodes, n.ID)] = true
		if n.Type == "file" {
			expected[filePath(d.Nodes, n.ID)+".chunk"] = true
		}
	}

	entries, err := os.ReadDir(filesDir())
	if err != nil {
		return
	}

	for _, entry := range entries {
		name := entry.Name()
		if name == "." || name == ".." {
			continue
		}
		full := filepath.Join(filesDir(), name)
		if expected[full] {
			continue
		}
		// 文件夹保守处理：不删用户可能手动放进去的内容
		if entry.IsDir() {
			continue
		}
		_ = os.Remove(full)
	}
}

// ---------------- 在系统文件管理器中定位 ----------------

func opShowInFolder(id string) error {
	if !safeID(id) {
		return fmt.Errorf("invalid id")
	}
	d := loadDoc()
	_, n := findNode(d, id)
	if n == nil {
		return fmt.Errorf("node not found")
	}

	targetPath := filePath(d.Nodes, id)

	// 如果目标文件不存在（新建但还没写入），退回到 files 目录
	if _, err := os.Stat(targetPath); os.IsNotExist(err) {
		targetPath = filesDir()
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// /select, 参数让资源管理器打开所在目录并选中该文件
		cmd = exec.Command("explorer", "/select,", targetPath)
	case "darwin":
		cmd = exec.Command("open", "-R", targetPath)
	default:
		// Linux 等：能用 xdg-open 就打开目录，否则退回
		if _, err := exec.LookPath("xdg-open"); err == nil {
			dir := filepath.Dir(targetPath)
			if st, e := os.Stat(dir); e == nil && st.IsDir() {
				cmd = exec.Command("xdg-open", dir)
			} else {
				cmd = exec.Command("xdg-open", filesDir())
			}
		} else {
			return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
		}
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to open folder: %v", err)
	}
	return nil
}
