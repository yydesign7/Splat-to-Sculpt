# Splat to Sculpt

中文 | [English](README.md)

Splat to Sculpt 是一个面向 3D 内容生成工作流的可视化网页应用。项目通过节点式画布串联视频上传、帧提取、Gaussian Splat 生成、Mesh 转换、模型清理、表面处理、资产管理与视频预览/导出等步骤，帮助用户从拍摄素材逐步生成可查看、可下载、可继续处理的 3D 模型和相关输出。

项目基于 Next.js 16、React、shadcn/ui、React Flow 与 Three.js 构建，后端脚本负责处理 Gaussian Splat 生成、PLY/GLB 转换、缩略图渲染、模型处理和旋转视频生成等任务。

## 功能特点

- 基于节点的 3D 生成工作流编辑器
- 视频上传与可配置帧提取
- Gaussian Splat 生成，并支持 CUDA、MPS、CPU 路径的自动设备检测
- 可选 true-training 路径，用于输出 3DGS-compatible splat PLY
- 从 splat/PLY 输入生成 Mesh，继续进入 GLB 后续工作流
- 模型清理、表面处理、资产库和模型历史记录
- 支持视频、PLY/splat、GLB/model 的预览
- 资产缩略图，帮助在侧边栏中识别文件内容
- 工作流库与不可删除的预设工作流
- Run/Stop 控制，并支持终止长时间运行的后端任务

## 快速开始

安装前端依赖：

```bash
pnpm install
```

如果需要运行 3D 生成相关脚本，安装 Python 处理依赖：

```bash
pnpm python-deps
```

启动开发服务器：

```bash
pnpm dev
```

启动后，在浏览器中打开 [http://localhost:5001](http://localhost:5001) 查看应用。

构建生产版本：

```bash
pnpm build
```

启动生产服务器：

```bash
pnpm start
```

## 常用脚本

```bash
pnpm dev          # 启动本地开发服务器
pnpm build        # 构建生产版本
pnpm start        # 启动生产服务器
pnpm ts-check     # 运行 TypeScript 类型检查
pnpm lint         # 运行 ESLint
pnpm python-deps  # 安装 Python 脚本依赖
```

## 项目结构

```text
src/
├── app/                 # Next.js App Router 页面与 API 路由
├── components/flow/     # 工作流画布、节点 UI、预览器和侧边栏
├── components/ui/       # shadcn/ui 基础组件
├── lib/                 # 工作流逻辑、任务状态、发布辅助函数
└── hooks/               # 共享 React hooks

scripts/
├── generate_gaussian_splat.py
├── train_gaussian_splat.py
├── gs_to_mesh.py
├── render_ply_thumbnail.py
└── 其他模型/视频处理脚本

public/
├── asset-library/       # 轻量资产库元数据
└── model-history/       # 轻量模型历史元数据
```

## 生成文件说明

运行时生成的资产不会提交到 Git。生成的视频、帧图片、PLY 文件、GLB 文件、贴图、COLMAP 场景、Blender 输出、本地环境和临时 `.data/` 文件都应保留在本地。

以下运行时目录已被忽略：

```text
.data/
scripts/.mamba-root/
public/asset-published/
public/videos/
public/frames/
public/colmap-scenes/
public/blender-output/
public/obj-processed/
public/rotation-videos/
public/textures/
```

大型测试资产建议通过 GitHub Releases、云盘或数据集托管平台分发，而不是直接提交到源码仓库。

## 技术栈

- Next.js 16 与 React 19
- TypeScript
- React Flow
- Three.js、React Three Fiber 与 Drei
- shadcn/ui 与 Radix UI
- Tailwind CSS v4
- 用于 Gaussian Splat、Mesh、缩略图和视频任务的 Python 处理脚本
- pnpm 包管理器

## 说明

本仓库只保留应用源码和必要处理脚本。本地生成资产和机器相关环境不会提交，因此全新克隆后资产库和模型历史记录会从空状态开始。
