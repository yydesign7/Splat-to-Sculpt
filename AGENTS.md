# 3DGS Studio - 项目上下文

## 项目概述

3DGS Studio 是一个基于 ComfyUI 节点式布局的 3D 高斯泼溅（3DGS）模型生成工具。用户可以通过拖拽节点到画布上，按照视频上传 → 帧提取 → 点云生成 → 3DGS模型生成 → 模型整理 → 模型表面处理 → 3DGS模型生成的流程构建工作流，同时支持材质生成、视频预览等辅助节点。点击右上角"运行"按钮后，工作流自动编排：已接收到数据的节点自动开始处理，处理完成后自动传递数据到下游节点。

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
│   │   │   ├── Sidebar.tsx        # 左侧导航栏（节点库 + 模型历史）
│   │   │   ├── TopBar.tsx         # 顶部控制栏（运行/停止/重置/适应 + 进度显示）
│   │   │   ├── custom-nodes.tsx   # 8种自定义节点组件 + LightParams类型定义
│   │   │   ├── LightControls.tsx  # 灯光参数调整UI组件
│   │   │   ├── InteractiveModelViewer.tsx  # Three.js 交互式3D预览器（支持灯光参数）
│   │   │   ├── ModelViewer.tsx    # Three.js 3D模型预览器（支持灯光参数）
│   │   │   └── PLYViewer.tsx     # Three.js PLY点云预览器
│   │   └── ui/             # Shadcn UI 组件库
│   ├── hooks/              # 自定义 Hooks
│   ├── lib/
│   │   ├── node-config.ts  # 节点类型配置与常量
│   │   ├── utils.ts        # 通用工具函数 (cn)
│   │   ├── workflow-engine.ts  # 工作流引擎（端口映射、触发条件、统一数据推送、拓扑排序）
│   │   └── workflow-context.ts # 工作流运行状态 React Context
│   └── server.ts           # 自定义服务端入口
├── public/
│   └── model-history/      # 模型生成历史数据 (history.json)
├── next.config.ts
├── package.json
└── tsconfig.json
```

## 核心功能模块

### 工作流引擎

工作流采用"点击运行 → 自动编排"模式：

1. **运行状态管理**：通过 `WorkflowContext` 提供 `workflowRunning` 全局状态
2. **统一数据推送**：`FlowEditor` 中的 `useEffect` 监听节点变化，节点完成后自动通过 `computeDownstreamPushes()` 推送数据到下游
3. **自动触发**：每个节点内部 `useEffect` 检测 `workflowRunning && 输入就绪 && status === 'idle'` 时自动调用处理函数
4. **节点触发条件**：
   - **视频上传**：手动触发（用户上传文件）
   - **帧提取**：`workflowRunning && videoServerPath` → 自动提取
   - **点云生成**：被动触发（由上游帧提取节点推送 status: 'processing'）
   - **材质生成**：`workflowRunning && textInput` → 自动生成
   - **3DGS模型生成**：`workflowRunning && inputUrl` → 根据 `inputType` 自动选择 PLY 网格生成或 OBJ+PNG 处理；PNG handle 为可选输入，仅当有上游连接时才要求等待
   - **模型整理**：`workflowRunning && (glbUrl || objUrl)` → 自动调用Blender API整理模型，整理完成后推送modelUrl到下游
   - **模型表面处理**：被动接收 OBJ 数据，手动选择层级和参数后执行 Blender 渲染
   - **视频预览**：`workflowRunning && objUrl` → 自动调用旋转视频API生成360°旋转视频并预览

### 端口映射

```ts
// Source handles → output data field
SOURCE_HANDLE_MAP = {
  'videoUpload.output': 'videoServerPath',
  'frameExtraction.output': 'frames',
  'pointCloud.ply-output': 'plyUrl',
  'material.texture-output': 'textureUrl',
  'modelOrganize.obj-output': 'modelUrl',
  'modelSurface.obj-output': 'outputModelUrl',
  'modelGeneration.output': 'modelUrl',
}

// Target handles → input data update function
TARGET_HANDLE_MAP = {
  'frameExtraction.input': (value) => ({ videoServerPath: value }),
  'pointCloud.input': (value) => ({ framePaths: value }),
  'modelGeneration.model-input': (value, sourceNodeType, sourceNodeData) => { result = { modelUrl: value, inputType: isPly ? 'ply' : 'obj' }; forward layerFiles/layerNames; return result; },
  'modelGeneration.texture': (value) => ({ textureUrl: value }),
  'modelOrganize.obj-input': (value, _sourceNodeType, sourceNodeData) => { result = { modelUrl: value }; forward layerFiles/layerNames; return result; },
  'modelSurface.obj-input': (value, _sourceNodeType, sourceNodeData) => { result = { modelUrl: value }; forward layerFiles/layerNames; return result; },
  'videoPreview.obj-input': (value, _sourceNodeType, sourceNodeData) => { result = { modelUrl: value }; forward lightParams; return result; },
}
```

### 节点系统
8种预设节点，初始工作流拓扑：
```
视频上传 → 帧提取 → 点云生成 → 3DGS模型生成① → 模型整理 → 模型表面处理 → 3DGS模型生成②
                                                            ↓
                                                     视频预览

[材质生成]（独立，未连线，位于表面处理上方）
```

1. **视频上传节点** - 上传视频并自动提取封面帧作为预览
2. **帧提取节点** - 提取120帧图片，显示输出文件夹名，支持预览
3. **点云生成节点** - 将图片转换为点云数据；支持 Depth Fusion 和 Segmentation 开关；Segmentation 开启后显示层信息（层数 + 层名标签）
4. **材质生成节点** - 生成纹理材质数据（使用 coze-coding-dev-sdk SeeDream v5.0），独立节点未连线
5. **模型整理节点** - 接收上游模型文件（OBJ或GLB）后自动调用Blender API进行模型清理，透传 layerFiles/layerNames 到下游
6. **视频预览节点** - 接收上游OBJ模型，生成360°旋转视频并预览播放
7. **模型表面处理节点** - 3D模型预览，点击选择层级，Principled BSDF材质参数调整，灯光参数调整，Blender渲染回传；显示层名标签（优先使用 metadata 层名，回退到 3D 颜色检测）；灯光参数和 layerFiles/layerNames 随模型数据推送到下游
8. **3DGS模型生成节点** - 合并点云与纹理，支持 GLB/FBX/OBJ/PLY 3D模型预览 + 全屏 + 点击上传；透传上游灯光参数和 layerFiles/layerNames 到下游

### ModelGenerationNode 输入规则
- **Model handle**（必填）：接收 PLY 或 OBJ 格式的模型数据，通过 `inputUrl` + `inputType` 字段存储
- **PNG handle**（可选）：接收材质纹理，通过 `textureUrl` 字段存储
  - 如果 PNG handle 没有上游连接，节点只要有 Model 输入即可触发
  - 如果 PNG handle 有上游连接，则需等待 Model + PNG 两个输入都有数据后才触发

### 灯光参数传递链
灯光参数（`LightParams`）从模型表面处理节点产生，随模型数据推送到下游：
```
模型表面处理 → 3DGS模型生成② → 视频预览
```
- **LightParams 接口**：`ambientIntensity`(0-3), `mainLightIntensity`(0-10), `mainLightColor`(RGB), `fillLightIntensity`(0-5), `exposure`(0.1-3)
- **前端预览**：ModelViewer / InteractiveModelViewer 接收 `lightParams` 并实时更新 Three.js 场景灯光
- **Blender 渲染**：`blender_material.py` 的 `setup_render_scene()` 接收灯光参数控制场景灯光
- **视频生成**：`generate_rotation_video.py` 的 pyrender 场景使用灯光参数控制渲染灯光

### 分层信息传递链
点云分割产生的层信息（`layerFiles` + `layerNames`）从点云节点一路透传到下游：
```
点云生成 → 3DGS模型生成① → 模型整理 → 模型表面处理 → 3DGS模型生成②
```
- **layerFiles**: 各层 PLY 文件的公共路径数组
- **layerNames**: 各层名称数组（来自 `layers_meta.json`）
- **数据源**: `pointcloud_segment.py` 脚本输出的 `layers_meta.json`
- **前端显示**: PointCloudNode 的 Segmentation 开关下方显示层数和层名标签；SurfaceProcessingNode 的模型预览上方显示层名标签
- **层选择映射**: InteractiveModelViewer 接收 `metadataLayerNames` prop，构建 mesh.name → layerName 映射（`meshToLayerMapRef`），优先使用 metadata 层名而非顶点颜色检测或 mesh 内部名称

### 顶点颜色保留链
分割后的顶点颜色沿管线传递，但 OBJ 格式不原生支持顶点颜色：
```
pointcloud_segment.py (PLY, 带顶点颜色)
  → gs_to_mesh.py (Poisson 重建 + KDTree 颜色投影, 输出 GLB/OBJ)
  → blender_organize.py (GLB 导出时 export_colors=True 保留顶点颜色)
  → blender_material.py (GLB 导出时 export_colors=True)
```
- **关键**: OBJ 不支持顶点颜色，GLB 支持。管线优先使用 GLB 路径以保留颜色
- **gs_to_mesh.py**: Poisson 重建后使用 scipy KDTree 将点云颜色投影到网格顶点
- **InteractiveModelViewer**: 当 `metadataLayerNames` 存在时，优先使用 metadata 层名；降级使用顶点颜色检测；最后使用 mesh.name

### 画布交互
- 从左侧节点库拖拽添加节点
- 节点间连线（smoothstep 动画边）
- 节点右上角删除按钮
- 画布缩放、平移、MiniMap、Controls
- 适应视图、重置画布
- 点击"运行"按钮启动工作流自动编排，运行中可点击"停止"
- 运行时显示进度（已完成/总节点数）

### 左侧导航
- 可折叠/展开
- "节点库"子菜单（8种节点可拖拽）
- "模型生成历史"子菜单

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
- Handle 的 `id` 属性用于多输入端口区分（如 3DGS 节点的 model-input/texture）
- ModelGenerationNode 源端口 id 为 `output`，连线时需指定 `sourceHandle: 'output'`
- ModelGenerationNode 目标端口 id 为 `model-input`（合并了原 pointcloud 和 obj-input）和 `texture`

### 工作流开发规范
- 节点自动触发使用 `useWorkflow()` 获取 `workflowRunning` 状态
- 自动触发 `useEffect` 依赖 `workflowRunning` + 必要输入字段 + 当前 status
- 数据推送同时由节点内 `useEffect` 和 `FlowEditor` 统一推送机制处理（双重保障）
- 新增节点类型需在 `workflow-engine.ts` 的 `SOURCE_HANDLE_MAP`、`TARGET_HANDLE_MAP` 和 `getNodeTriggerInfo` 中注册
