# Claw-Fridge（虾爪冰箱）

基于 Git 的去中心化 OpenClaw 配置备份系统，本地运行。

## 文档
- **飞书文档 v4**: https://bytedance.feishu.cn/docx/DS8FdyPDpoCR4VxJK0jcjocQn1c

## 核心设计（v4）

### 概念
- **Ice Box（冰盒）**：一个备份配置单元，对应一台机器的备份

### 前置条件
- 必须先配置存储 Git 仓库，才能创建冰盒

### 两种备份方案
1. **Git 直接推送（推荐）**
   - OpenClaw 的 `.openclaw` 目录直接链接到存储 Git 仓库
   - Skill 协助配置分支、上游、定时同步
   - 分支名：`ice-box/{machine-id}`

2. **压缩包上传**
   - 打包 `.openclaw` 为 tar.gz，通过 HTTP 上传到 Claw-Fridge
   - 每个冰盒有唯一的上传 URL 和 token

### 路由结构
- `/` - 首页（Git 配置 + 冰盒列表 + 内嵌创建表单 + 内嵌详情）
- `/skill` - Skill 页面

## 开发进度

### 2026-03-13
- [x] 路由简化：删除 `/ice-boxes/new` 和 `/ice-boxes/[id]`，创建表单内嵌到首页
- [x] Git 身份配置：Mini / foyaltd@foxmail.com

## 技术栈
- Next.js 14+ (App Router)
- TypeScript
- Tailwind CSS
- isomorphic-git
- Zustand
