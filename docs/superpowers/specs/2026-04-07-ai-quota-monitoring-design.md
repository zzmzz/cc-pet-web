# AI用量监控系统设计文档

## 1. 项目概述

### 1.1 项目目标
构建一个AI用量监控系统，实现对 `https://ai-quota.fintopia.tech/users/27` 页面数据的每小时自动抓取，并在cc-pet-web项目的设置页面中新增独立标签页展示AI用量情况。

### 1.2 需求背景
用户需要实时监控AI配额使用情况，通过可视化的界面了解当前用量和历史趋势，以便更好地管理AI资源。

## 2. 系统架构设计

### 2.1 整体架构
采用前后端分离架构，在现有的cc-pet-web项目基础上扩展功能：
- 后端：服务器定时抓取服务 + API接口 + 数据存储
- 前端：设置面板中的新标签页 + 数据可视化

### 2.2 技术栈
- 现有的cc-pet-web技术栈（React, TypeScript, Fastify, SQLite等）
- HTTP客户端用于外部API抓取
- 图表库用于数据可视化（如Chart.js或类似库）

## 3. 详细设计

### 3.1 后端设计

#### 3.1.1 定时抓取服务 (`packages/server/src/quota-scraper.ts`)
```typescript
// 核心功能：
// 1. 使用提供的cookie（remember_token）进行身份验证
// 2. 每小时发起GET请求到 https://ai-quota.fintopia.tech/users/27
// 3. 解析HTML响应，提取用量相关数据
// 4. 将数据存储到数据库中
```

#### 3.1.2 数据库模型
在现有的SQLite数据库中新增表：
```sql
CREATE TABLE ai_quota_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  usage_data TEXT NOT NULL, -- JSON格式存储具体的用量数据
  raw_content TEXT         -- 可选：存储原始页面内容用于调试
);
```

#### 3.1.3 API接口 (`packages/server/src/api/quota.ts`)
- `GET /api/quota/current`: 获取最新的用量数据
- `GET /api/quota/history`: 获取历史用量数据（支持日期范围查询）
- `GET /api/quota/stats`: 获取统计摘要（如最大值、最小值、平均值等）

### 3.2 前端设计

#### 3.2.1 设置面板扩展 (`packages/web/src/components/SettingsPanel.tsx`)
在现有设置面板中添加新的标签页：
- 使用React Tabs组件实现标签切换
- 新增 "AI用量" 标签页
- 在标签页中集成用量数据显示组件

#### 3.2.2 用量显示组件 (`packages/web/src/components/AIVolumeDisplay.tsx`)
- 显示当前用量百分比
- 显示配额上限和剩余量
- 显示上次更新时间

#### 3.2.3 历史图表组件 (`packages/web/src/components/QuotaChart.tsx`)
- 使用折线图展示历史用量趋势
- 支持时间范围选择（今日、本周、本月等）
- 提供数据导出功能（可选）

## 4. 安全设计

### 4.1 认证安全
- cookie信息存储在服务器配置中，不在前端暴露
- 所有API端点受现有身份验证机制保护
- 实现适当的错误处理，避免泄露敏感信息

### 4.2 数据安全
- 数据传输使用HTTPS
- 实现适当的访问控制和速率限制
- 日志中不记录敏感认证信息

## 5. 错误处理与监控

### 5.1 抓取失败处理
- 网络错误重试机制
- 身份验证失败提醒
- 页面结构变化检测

### 5.2 监控告警
- 抓取成功率监控
- 用量临界值告警（如用量超过80%）
- 服务器健康状态检查

## 6. 部署与配置

### 6.1 环境变量
- `QUOTA_SCRAPER_COOKIE`: 存储认证cookie信息
- `QUOTA_SCRAPE_INTERVAL`: 设置抓取间隔（默认3600秒即1小时）

### 6.2 配置验证
- 首次启动时验证认证信息有效性
- 定期测试外部API连通性

## 7. 测试策略

### 7.1 单元测试
- 抓取服务的单元测试
- API端点的功能测试
- 数据解析逻辑的验证

### 7.2 集成测试
- 端到端的数据流测试
- 前后端接口兼容性测试

## 8. 性能考虑

### 8.1 数据存储优化
- 定期清理过期的历史数据
- 实现数据压缩存储

### 8.2 网络优化
- 智能缓存机制减少不必要的外部请求
- 连接池管理提高性能

## 9. 维护与扩展

### 9.1 日志记录
- 详细的抓取日志便于问题排查
- API访问日志用于监控

### 9.2 功能扩展
- 支持多用户配额监控（未来扩展）
- 自定义监控频率设置
- 邮件/SMS告警功能（未来扩展）