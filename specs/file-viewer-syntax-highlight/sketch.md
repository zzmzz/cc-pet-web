**Workspace**: `file-viewer-syntax-highlight`
**Created**: 2026-05-13
**Input**: 用户描述: "我希望文本文件预览编辑时有语法高亮"

---

## 目标

为 FileViewer 组件增加语法高亮预览模式：默认以只读高亮视图展示文件内容，点击"编辑"按钮切换到 textarea 编辑模式。

## 推荐方案

利用项目已有的 `react-syntax-highlighter`（Prism + oneDark 主题，与 MessageList 中代码块一致），在 FileViewer 中实现预览/编辑双模式切换：

- **预览模式（默认）**：用 `SyntaxHighlighter` 渲染文件内容，根据文件扩展名推断语言
- **编辑模式**：点击"编辑"按钮后切换为现有的 textarea
- 切回预览模式时保留编辑内容（draftContent）

语言推断：从 `activeFile.name` 提取扩展名，映射到 Prism 语言标识符。

## 改动点

1. **`packages/web/src/components/workspace/FileViewer.tsx`** — 主要改动文件
   - 新增 `editing` 状态（默认 false）
   - 引入 `SyntaxHighlighter` 和 `oneDark`（复用 MessageList 中的导入方式）
   - 新增扩展名 → 语言映射辅助函数 `getLanguageFromFilename`
   - 预览模式：渲染 `<SyntaxHighlighter language={lang} style={oneDark}>{draftContent}</SyntaxHighlighter>`
   - 编辑模式：保留现有 `<textarea>` 逻辑
   - header 区域增加"编辑"/"预览"切换按钮
   - 保存成功后自动切回预览模式

2. **无新依赖** — `react-syntax-highlighter` 和 `@types/react-syntax-highlighter` 已在 `packages/web/package.json` 中

## 验证方式

- 启动 dev 服务器，在 workspace 文件树中点击一个 `.ts`/`.py`/`.json` 等文件
- 确认默认展示语法高亮的只读视图
- 点击"编辑"按钮，确认切换到可编辑 textarea
- 修改内容后点击"保存"，确认保存成功并切回高亮预览
- 打开无扩展名或未知类型文件，确认 fallback 为纯文本高亮（无报错）
