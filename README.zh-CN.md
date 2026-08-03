# Splat to Sculpt

中文 | [English](README.md)

Splat to Sculpt 是一个本地优先的节点式网页工作流应用，用于把拍摄视频或点云输入转换成可编辑的 3D 资产和展示视频。它在一个浏览器画布中串联视频抽帧、COLMAP 重建、Gaussian Splat 生成、Mesh 转换、Blender 处理、资产管理、ComfyUI 视频生成和预览/导出。

项目基于 Next.js 16、React 19、TypeScript、React Flow、Three.js 和 shadcn/ui 构建。较重的重建和渲染任务通过本地 FFmpeg、COLMAP、Blender、Python 脚本以及可选的 ComfyUI 执行。

## 当前默认工作流

内置默认工作流为：

```text
Video Upload
  -> Frame Extraction
  -> Gaussian Splat Gen
  -> Mesh Gen
  -> Model Cleanup
  -> Surface Processing
  -> ComfyUI Video Gen
  -> Video Preview
```

用户也可以从侧边栏把 Assets 拖入兼容节点，保存自定义工作流，停止长时间任务，清空预览，并复用 Assets 面板中的模型和视频。

## 主要功能

- 基于节点的可视化工作流编辑器，支持点击选中和删除连线。
- 通过 FFmpeg 上传视频并抽取指定数量的帧。
- 支持 COLMAP sparse reconstruction、dense matching、stereo fusion 和 foreground mask。
- Gaussian Splat Gen 支持 CUDA / MPS / CPU 自动路径选择，并保留可选 true-training 模式。
- 支持直接上传 PLY，走 fast initializer 工作流。
- Mesh Gen 支持从 PLY、splat 或模型输入转换出下游可用模型。
- Mesh 重建后执行 `geometry_graph_surface` 几何分层，并限制为更实用的层数。
- 输出单层 GLB 供编辑，同时可把同一模型的 layer GLB 合并成一个带分层对象名的 GLB 发布到 Assets。
- Model Cleanup 和 Surface Processing 通过本地 Blender 处理模型。
- ComfyUI Video Gen 可把最终模型传给 ComfyUI，生成多视角图片和视频。
- Seedance ComfyUI 部署包检测和安装辅助，用于所需 custom nodes 和 workflow。
- Sidebar Assets 展示上传视频、splat、Mesh Gen 模型、合并分层 GLB 和渲染视频。
- 为模型和视频生成缩略图，方便在侧边栏中识别。
- 基于 session 的临时文件存储和自动清理。

## 快速开始

项目只使用 `pnpm`，不要使用 `npm` 或 `yarn`。

可以先运行对应系统的安装检查脚本。脚本会安装锁定的 pnpm 依赖、检查缺少的本地工具，但不会擅自安装大型外部应用或 AI 模型。

macOS：

```bash
bash scripts/setup-macos.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1
```

macOS 添加 `--install-python`、Windows 添加 `-InstallPython` 可同时安装 Python 处理依赖。添加 `--check-only` 或 `-CheckOnly` 可以只检查环境，不安装项目依赖。

也可以继续使用手动安装方式：

安装依赖：

```bash
pnpm install
```

如果需要运行重建、Mesh、缩略图或视频相关脚本，安装 Python 处理依赖：

```bash
pnpm python-deps
```

启动开发服务器：

```bash
pnpm dev
```

启动后打开 [http://localhost:5001](http://localhost:5001)。

构建并启动生产版本：

```bash
pnpm build
pnpm start
```

## 本地工具要求

只查看基础网页 UI 时，Node.js 和 pnpm 即可。完整重建工作流还需要本地工具：

- FFmpeg：视频信息读取和帧提取。
- COLMAP：相机位姿、稀疏重建、稠密匹配和 stereo fusion。
- `scripts/requirements-python.txt` 中列出的 Python 包。
- Blender：模型清理、表面/材质处理、预览渲染和旋转视频渲染。
- ComfyUI：可选，用于最后的模型到视频生成。

开发脚本会优先使用已经配置好的 Python 环境和本地工具路径。也可以用环境变量覆盖：

```bash
PYTHON_BIN=/path/to/python
NS_TRAIN_BIN=/path/to/ns-train
NS_EXPORT_BIN=/path/to/ns-export
COMFYUI_BASE_URL=http://127.0.0.1:8000
COMFYUI_3D_INPUT_DIR=/path/to/ComfyUI/input/3d
```

## ComfyUI 接入

ComfyUI Video Gen 节点会连接本地 ComfyUI 服务，默认地址为：

```text
http://127.0.0.1:8000
```

运行时后端会：

1. 检查 ComfyUI 是否在线。
2. 通过 `/system_stats` 自动检测 ComfyUI 的 input、output、`input/3d`、custom nodes 和 workflows 目录。
3. 把最终模型复制到 ComfyUI 的 `input/3d`。
4. 根据项目内置 API workflow preset 构建 prompt。
5. 通过 `/prompt` 提交任务。
6. 轮询 `/history/{prompt_id}`。
7. 通过 `/view` 下载生成视频。
8. 把视频返回网页并发布到 Assets。

项目内置 Seedance 部署包：

```text
vendor/comfyui/seedance2/
```

其中包含 ComfyUI Video Gen preset 所需的 custom nodes 和 workflow 文件。网页可以检查部署包是否已安装，并把文件复制到自动检测到的 ComfyUI 目录中。

## Blender 接入

项目会以 background 模式调用本地 Blender，用于：

- Model Cleanup。
- Surface Processing 的材质和灯光输出。
- 分层模型处理。
- 静态预览图渲染。
- Video Preview 接收模型时生成旋转视频。

如果本机没有 Blender，依赖 Blender 的节点会显示清晰错误；前面的上传、抽帧、点云和 Mesh 等步骤仍可继续使用。

## Assets 与临时文件

项目把临时 workflow 文件和可复用 Assets 分开保存：

- 临时 session 文件写入 `.data/ephemeral/{sessionId}/`。
- 发布后的正式资产复制到 `public/asset-published/{assetId}/`。
- Assets 元数据保存在 `public/asset-library/assets.json`。

Sidebar Assets 只显示适合长期复用的文件，例如上传视频、Gaussian splat PLY、Mesh Gen 模型输出、合并分层 GLB、ComfyUI 视频和旋转预览视频。中间帧、mask、COLMAP workspace、单独 layer GLB 和 metadata 默认只作为临时文件保存。

清理规则：

- 后端启动时，删除超过 3 天的临时 session 文件夹。
- 后端正常退出时，尝试清空 `.data/ephemeral`。
- 已发布到 Assets 的文件不会被 ephemeral 清理影响。

## Mesh 与分层发布规则

Mesh Gen 会把生成的 `glb`、`obj` 和 `fbx` 模型输出登记到 Assets。如果 Mesh Gen 产生了 `layerGlbUrls`，项目会先把这些 layer GLB 合并成一个 `merged.glb`，并把 layer 名称保留为 GLB 内部的 node/object 名称，然后只把这个合并后的分层 GLB 发布到 Assets。单独的 layer GLB 仍然作为 Surface Processing 的中间编辑文件保留。

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
├── lib/                 # 工作流逻辑、任务状态和发布辅助函数
└── hooks/               # 共享 React hooks

scripts/
├── setup-macos.sh
├── setup-windows.ps1
├── generate_gaussian_splat.py
├── train_gaussian_splat.py
├── gs_to_mesh.py
├── merge_glbs.py
├── render_ply_thumbnail.py
├── render_model_thumbnail.py
└── 其他模型、视频和重建处理脚本

vendor/
└── comfyui/seedance2/   # 可选 ComfyUI Seedance 部署包

public/
├── asset-library/       # 轻量 Assets 元数据
├── model-history/       # 轻量模型历史元数据
└── workflow-library/    # 保存的 workflow 元数据
```

## 生成文件说明

运行时资产和本地生成结果不应提交到 Git。已忽略的路径包括：

```text
.data/
public/asset-published/
public/videos/
public/frames/
public/uploads/
public/colmap-scenes/
public/blender-output/
public/obj-processed/
public/rotation-videos/
public/textures/
scripts/.mamba-root/
```

全新克隆后，本地 Assets 和模型历史会从空状态开始。大型演示资产建议通过 GitHub Releases、云盘或数据集托管平台分发，不要直接放入源码仓库。

## 验证

常用检查：

```bash
pnpm ts-check
pnpm lint
```

特定功能测试可以用 `tsx` 运行，例如：

```bash
pnpm exec tsx --test src/lib/mesh-asset-publish-policy.test.ts
pnpm exec tsx --test src/lib/ephemeral-cleanup.test.ts
```
