# Splat to Sculpt - 项目上下文

## 项目概述

Splat to Sculpt 是一个基于节点式画布的 3D 内容生成工作流应用。用户可以通过拖拽节点构建从视频上传、帧提取、Gaussian Splat 生成、Mesh 转换、模型清理、表面处理到视频预览的完整流程，也可以使用 Material Gen、Sticky Note 等辅助节点。点击右上角 Run 后，工作流只沿已连接的节点传递数据；处理完成的节点会把对应文件输出推送到下游，末端节点完成后工作流会自动停止。

### 版本技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4
- **节点画布**: @xyflow/react (React Flow v12)
- **3D预览**: Three.js + @react-three/fiber + @react-three/drei

## 目录结构

```
├── public/                 # 静态资源
├── scripts/                # 构建与启动脚本
├── src/
│   ├── app/                # 页面路由与布局
│   │   ├── globals.css     # 全局样式（含 React Flow 覆写）
│   │   ├── layout.tsx      # 根布局（dark 模式）
│   │   └── page.tsx        # 首页（动态加载 FlowEditor）
│   ├── components/
│   │   ├── flow/           # 节点编辑器核心组件
│   │   │   ├── FlowEditor.tsx     # 主编辑器（ReactFlowProvider + WorkflowContext + 画布）
│   │   │   ├── Sidebar.tsx        # 左侧导航栏（Node Library + Assets + Workflows Library + Model History）
│   │   │   ├── TopBar.tsx         # 顶部控制栏（Save Workflow / Clear / Run / Stop + 进度显示）
│   │   │   ├── custom-nodes.tsx   # 自定义节点组件 + LightParams/MaterialParams 类型定义
│   │   │   ├── LightControls.tsx  # 灯光参数调整 UI 组件
│   │   │   ├── InteractiveModelViewer.tsx  # Three.js 交互式 3D 预览器（支持灯光参数）
│   │   │   ├── ModelViewer.tsx    # Three.js 3D 模型预览器（支持灯光参数）
│   │   │   ├── PLYViewer.tsx      # Three.js PLY / 点云预览器
│   │   │   └── SplatViewer.tsx    # Gaussian Splat / PLY 预览器
│   │   └── ui/             # Shadcn UI 组件库
│   ├── hooks/              # 自定义 Hooks
│   ├── lib/
│   │   ├── node-config.ts  # 节点类型配置与常量
│   │   ├── utils.ts        # 通用工具函数 (cn)
│   │   ├── workflow-engine.ts  # 工作流引擎（端口映射、触发条件、统一数据推送、拓扑排序）
│   │   └── workflow-context.ts # 工作流运行状态 React Context
│   └── server.ts           # 自定义服务端入口
├── public/
│   └── model-history/      # 轻量模型历史数据 (history.json)
├── next.config.ts
├── package.json
└── tsconfig.json
```

## 核心功能模块

### 工作流引擎

工作流采用"点击运行 → 自动编排"模式：

1. **运行状态管理**：通过 `WorkflowContext` 提供 `workflowRunning`、`ephemeralSessionId` 和统一 `apiFetch`
2. **统一数据推送**：`FlowEditor` 中的 `useEffect` 监听节点完成状态，节点完成后通过 `computeDownstreamPushes()` 只向已连接的下游节点推送数据
3. **自动停止**：`FlowEditor` 会检测当前连通工作流的末端节点；末端节点全部完成后自动把 `workflowRunning` 设为 `false`
4. **停止/清空**：Stop 会调用取消接口终止 Gaussian Splat 等长时间后端任务；Clear 会清空上传文件、输出文件和节点状态，但保留节点布局与连线
5. **节点触发条件**：
   - **Video Upload**：用户手动上传视频，上传完成后输出 `videoServerPath`，同时保存目标帧数
   - **Frame Extraction**：`workflowRunning && videoServerPath` → 自动提取帧，输出 `frames`
   - **Gaussian Splat Gen**：接收 `frames` 或手动/上游 PLY；可根据设备走 CUDA/NerfStudio、MPS/CPU 快速 splat PLY 或 true-training 路径；输出 `splatUrl`，并保留 `sourcePlyUrl` 作为 mesh-output
   - **Material Gen**：`workflowRunning && textInput` → 调用 `/api/generate-texture` 生成 texture PNG
   - **Mesh Gen**：`workflowRunning && modelUrl` → 接收 splat/PLY/OBJ/GLB，转换或处理为下游可用的 GLB/OBJ/PLY 输出；PNG texture 仅在有连接时作为可选输入
   - **Model Cleanup**：`workflowRunning && modelUrl && 有上游连接` → 自动调用 Blender 清理/整理模型
   - **Surface Processing**：`workflowRunning && modelUrl && 有上游连接` → 接收模型后可调材质/灯光并自动或手动调用 Blender 材质处理
   - **Video Preview**：`workflowRunning && modelUrl && 有上游连接` → 自动调用旋转视频 API 生成 360° 预览视频

### 端口映射

```ts
// Source handles → output data field
SOURCE_HANDLE_MAP = {
  'videoUpload.output': 'videoServerPath',
  'frameExtraction.output': 'frames',
  'gaussianSplat.mesh-output': 'sourcePlyUrl',
  'gaussianSplat.splat-output': 'splatUrl',
  'material.texture-output': 'textureUrl',
  'modelOrganize.obj-output': 'outputUrl',
  'modelSurface.obj-output': 'outputModelUrl',
  'modelGeneration.output': 'outputUrl',
}

// Target handles → input data update function
TARGET_HANDLE_MAP = {
  'frameExtraction.input': (value, sourceNodeType, sourceNodeData) => {
    return { videoServerPath: value, targetFrameCount: sourceNodeData?.targetFrameCount };
  },
  'gaussianSplat.input': (value) => ({ framePaths: value }),
  'gaussianSplat.ply-input': (value, _sourceNodeType, sourceNodeData) => { result = { sourcePlyUrl: value }; forward layerFiles/layerNames; return result; },
  'modelGeneration.model-input': (value, sourceNodeType, sourceNodeData) => { infer inputType as splat/ply/obj/glb; forward gaussianCount/computeBackend/lightParams/layer metadata; return result; },
  'modelGeneration.texture': (value) => ({ textureUrl: value }),
  'modelOrganize.obj-input': (value, _sourceNodeType, sourceNodeData) => { result = { modelUrl: value }; forward layerFiles/layerNames/layerGlbUrls; return result; },
  'modelSurface.obj-input': (value, _sourceNodeType, sourceNodeData) => { result = { modelUrl: value }; forward layerFiles/layerNames/layerGlbUrls; return result; },
  'videoPreview.obj-input': (value, _sourceNodeType, sourceNodeData) => { result = { modelUrl: value }; forward lightParams; return result; },
}
```

### 节点系统
9 种预设节点，默认工作流拓扑：

```text
Sticky Note             Sticky Note        Sticky Note

Video Upload → Frame Extraction → Gaussian Splat Gen → Mesh Gen → Model Cleanup → Surface Processing → Mesh Gen
                                                                                         ↓
                                                                                  Video Preview

[Material Gen]（独立放置在 Surface Processing 上方，按需连接 texture 输出）
```

1. **Video Upload** - 上传视频、显示封面预览、设置 frame count；输出 `videoServerPath` 给 Frame Extraction
2. **Frame Extraction** - 按目标帧数提取图片帧，显示输出文件夹和帧数量；输出 `frames`
3. **Gaussian Splat Gen** - 接收 image frames 或直接上传/接收 PLY；显示设备类型、目标 PLY 类型、训练步数和真实进度；支持 auto / true-training 路径；输出 `splat-output` 给 Mesh Gen，并保留 `mesh-output` 兼容 PLY 源
4. **Mesh Gen** - 接收 splat/PLY/OBJ/GLB，转换或整理为 GLB/OBJ/PLY 输出；接收到 splat PLY 时负责转换成后续节点可处理的 GLB/model 文件
5. **Model Cleanup** - 接收上游模型文件，调用 Blender 清理/整理模型，并透传 layerFiles/layerNames/layerGlbUrls
6. **Surface Processing** - 预览模型，按层调整材质参数和灯光参数；材质/颜色变化会写入 Blender 输出，并把 lightParams 与层信息传到下游
7. **Mesh Gen（第二个）** - 接收表面处理后的模型，生成最终可下载/可预览的模型输出，并继续推送给 Video Preview
8. **Video Preview** - 接收模型文件，调用旋转视频 API 生成 360° 视频并预览播放
9. **Sticky Note** - 注释节点，只记录想法或流程说明，不参与运行和数据传输

### Mesh Gen 输入规则
- **Model handle**（必填）：接收 splat、PLY、OBJ 或 GLB，通过 `modelUrl` + `inputType` 字段存储
- **PNG handle**（可选）：接收材质纹理，通过 `textureUrl` 字段存储
  - 如果 PNG handle 没有上游连接，节点只需要 Model 输入即可触发
  - 如果 PNG handle 有上游连接，则需等待 Model + PNG 两个输入都有数据后才触发
- **Gaussian Splat 输入**：来自 `gaussianSplat.splat-output` 的数据会被识别为 `inputType: 'splat'`，进入 splat/PLY → mesh/GLB 转换路径
- **普通模型输入**：非 splat 输入会根据 URL 后缀推断 `ply` / `obj` / `glb`，并沿用对应处理路径

### 灯光参数传递链
灯光参数（`LightParams`）从 Surface Processing 节点产生，随模型数据推送到下游：

```text
Surface Processing → Mesh Gen（第二个） → Video Preview
```

- **LightParams 接口**：`ambientIntensity`、`mainLightIntensity`、`mainLightColor`、`mainLightAzimuth`、`mainLightElevation`、`fillLightIntensity`、`fillLightAzimuth`、`fillLightElevation`、`exposure`
- **前端预览**：ModelViewer / InteractiveModelViewer 接收 `lightParams` 并实时更新 Three.js 场景灯光
- **Blender 渲染**：`blender_material.py` 接收灯光参数控制场景灯光和材质输出
- **视频生成**：`generate_rotation_video.py` / rotation video API 使用灯光参数控制渲染效果

### 分层信息传递链
Gaussian Splat 或上游 PLY 可能携带层信息（`layerFiles` + `layerNames` + `layerGlbUrls`），这些信息会沿模型处理链透传：

```text
Gaussian Splat Gen / PLY source → Mesh Gen → Model Cleanup → Surface Processing → Mesh Gen
```

- **layerFiles**: 各层 PLY 文件的公共路径数组
- **layerNames**: 各层名称数组
- **layerGlbUrls**: 各层转换后的 GLB 路径数组
- **前端显示**: Surface Processing 通过层名标签和 layer metadata 帮助用户选择层级
- **层选择映射**: InteractiveModelViewer 优先使用 metadata 层名；必要时回退到 mesh 名称或颜色检测

### 顶点颜色与模型输出链
运行链路优先使用支持材质与颜色信息的 GLB/model 路径，OBJ 主要作为兼容格式：

```text
Gaussian Splat / PLY source
  → Mesh Gen / gs_to_mesh.py（splat/PLY 转 mesh，尽量保留颜色和层信息）
  → Model Cleanup / blender_organize.py（整理模型并输出 GLB/OBJ）
  → Surface Processing / blender_material.py（写入材质、颜色、灯光效果）
```

- **GLB 优先**: GLB 更适合保留颜色、材质和结构信息
- **OBJ 兼容**: OBJ 可用于部分处理流程，但不适合保存复杂顶点颜色和材质状态
- **预览器**: ModelViewer / InteractiveModelViewer / PLYViewer / SplatViewer 根据输入类型选择对应预览路径

### 画布交互
- 从左侧节点库拖拽添加节点
- 节点间连线（smoothstep 动画边），只有有连线的节点才传输文件数据
- 节点右上角删除按钮；可上传预览框在已有文件时显示清除 X
- 画布缩放、平移、MiniMap、Controls；右下角 Controls 保留 fit 功能
- 顶栏包含 Save Workflow、Clear、Run / Stop
- Save Workflow 保存当前节点布局和连线到侧边栏 Workflows Library
- Clear 清空上传文件、生成输出和节点状态，但保留节点布局与连线
- Run 启动工作流自动编排；Stop 停止工作流并调用后端取消长任务
- 运行时显示已完成/总节点数，末端节点全部完成后自动停止

### 左侧导航
- 可折叠/展开
- **Node Library**：按类别展示 Video Upload、Frame Extraction、Gaussian Splat Gen、Mesh Gen、Model Cleanup、Surface Processing、Material Gen、Video Preview、Sticky Note
- **Assets**：展示已发布/临时资产，支持视频与模型缩略图
- **Workflows Library**：保存用户工作流，并内置不可删除的 Default Workflow
- **Model History**：展示模型生成历史记录

## 包管理规范

**仅允许使用 pnpm** 作为包管理器，**严禁使用 npm 或 yarn**。

## 开发规范

### 编码规范
- 禁止隐式 `any` 和 `as any`；函数参数、返回值需明确类型
- 禁止在 JSX 渲染中使用 `Math.random()`、`Date.now()` 等不纯函数
- 清理未使用的变量和导入

### Hydration 防范
- Three.js 组件使用 `dynamic import + ssr: false`
- 避免在 JSX 中直接使用 `typeof window`

### React Flow 注意事项
- 自定义节点使用 `NodeProps<T>` 泛型
- 节点数据更新通过 `useReactFlow().setNodes`
- Handle 的 `id` 属性用于多输入/多输出端口区分（如 Gaussian Splat 的 `splat-output` / `mesh-output`，Mesh Gen 的 `model-input` / `texture`）
- Gaussian Splat Gen 默认使用 `splat-output` 连接到 Mesh Gen 的 `model-input`
- Mesh Gen 源端口 id 为 `output`，目标端口 id 为 `model-input` 和可选 `texture`

### 工作流开发规范
- 节点自动触发使用 `useWorkflow()` 获取 `workflowRunning` 状态
- 自动触发 `useEffect` 依赖 `workflowRunning` + 必要输入字段 + 当前 status
- 数据推送同时由节点内 `useEffect` 和 `FlowEditor` 统一推送机制处理（双重保障）
- 新增节点类型需在 `workflow-engine.ts` 的 `SOURCE_HANDLE_MAP`、`TARGET_HANDLE_MAP` 和 `getNodeTriggerInfo` 中注册
