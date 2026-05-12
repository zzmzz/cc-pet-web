# Workspace API Contract

**Workspace**: `add-file-git-features`  
**Date**: 2026-05-12

所有接口均受现有 Bearer Token 认证保护。服务端必须校验当前 token 拥有路径中的 `connectionId`，并从该连接配置的 `workspacePath` 解析工作区根目录。

---

## Common Types

### WorkspaceMeta

| 字段 | 类型 | 说明 |
|------|------|------|
| connectionId | string | 当前连接 ID |
| configured | boolean | 是否配置有效工作区 |
| rootName | string | 工作区展示名称 |
| message | string? | 未配置或不可用时的说明 |

### FileEntry

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | 文件或目录名称 |
| path | string | 相对工作区根的路径 |
| kind | `"file" \| "directory"` | 项类型 |
| extension | string? | 文件扩展名 |
| size | number? | 文件大小 |
| modifiedAt | number? | 修改时间戳 |
| etag | string? | 文件版本标识，用于保存冲突检测 |
| inaccessible | boolean? | 是否不可访问 |
| gitStatus | string? | Git 状态短码 |

### ApiError

| 字段 | 类型 | 说明 |
|------|------|------|
| error | string | 机器可读错误码 |
| message | string | 用户可读说明 |

---

## Endpoints

### GET `/api/workspaces/{connectionId}`

返回连接绑定工作区元信息。

**Responses**:

- `200`: `WorkspaceMeta`
- `403`: token 无权访问该连接
- `404`: 连接不存在

### GET `/api/workspaces/{connectionId}/tree?path={relativePath}`

读取目录的直接子项。`path` 省略时表示工作区根目录。

**Responses**:

- `200`: `{ path, entries: FileEntry[] }`
- `400`: 路径非法或越界
- `403`: token 无权访问该连接
- `404`: 工作区、目录或连接不存在

### GET `/api/workspaces/{connectionId}/file?path={relativePath}`

读取文件内容或返回不可预览原因。

**Responses**:

- `200`: `{ path, name, previewable, encoding?, content?, size, modifiedAt, etag, reason? }`
- `400`: 路径非法、越界或目标不是文件
- `403`: token 无权访问该连接
- `404`: 文件不存在

### PUT `/api/workspaces/{connectionId}/file`

保存文本文件。

**Request Body**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 是 | 相对路径 |
| content | string | 是 | 新文件内容 |
| etag | string | 是 | 打开文件时返回的版本标识；服务端保存前比对，外部修改时拒绝覆盖 |

**Responses**:

- `200`: `{ ok: true, entry: FileEntry }`
- `400`: 路径非法、越界、目标不可写或内容不合法
- `403`: token 无权访问该连接
- `404`: 文件不存在，或文件版本已过期（`WORKSPACE_LIST_STALE`）

### POST `/api/workspaces/{connectionId}/items`

创建文件或目录。

**Request Body**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| parentPath | string | 否 | 父目录相对路径，默认根目录 |
| name | string | 是 | 新名称 |
| kind | `"file" \| "directory"` | 是 | 创建类型 |

**Responses**:

- `200`: `{ ok: true, entry: FileEntry }`
- `400`: 名称非法、路径越界或目标已存在
- `403`: token 无权访问该连接
- `404`: 父目录不存在

### PATCH `/api/workspaces/{connectionId}/items`

重命名文件或目录。

**Request Body**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 是 | 当前相对路径 |
| newName | string | 是 | 新名称 |

**Responses**:

- `200`: `{ ok: true, entry: FileEntry }`
- `400`: 名称非法、路径越界或目标已存在
- `403`: token 无权访问该连接
- `404`: 原项目不存在

### DELETE `/api/workspaces/{connectionId}/items`

删除文件或目录。

**Request Body**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 是 | 相对路径 |
| recursive | boolean | 否 | 是否允许删除非空目录 |

**Responses**:

- `200`: `{ ok: true }`
- `400`: 路径非法、路径越界或非空目录未确认递归删除
- `403`: token 无权访问该连接
- `404`: 项目不存在

### GET `/api/workspaces/{connectionId}/git/status`

返回工作区 Git 变更列表。

**Responses**:

- `200`: `{ gitAvailable, changes, message? }`
- `403`: token 无权访问该连接
- `404`: 连接或工作区不存在

### GET `/api/workspaces/{connectionId}/git/diff?path={relativePath}`

返回单个文件的工作区 diff。

**Responses**:

- `200`: `{ path, previewable, diff?, reason? }`
- `400`: 路径非法或越界
- `403`: token 无权访问该连接
- `404`: 文件或工作区不存在
