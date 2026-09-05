# Splat to Sculpt - 项目上下文

## 项目概述

Splat to Sculpt 是一个基于节点式画布的 3D 内容生成工作流应用。用户可以通过拖拽节点构建从视频上传、帧提取、Gaussian Splat 生成、Mesh 转换、模型清理、表面处理、ComfyUI 视频生成到视频预览的完整流程，也可以使用 Sticky Note 等辅助节点。点击右上角 Run 后，工作流只沿已连接的节点传递数据；处理完成的节点会把对应文件输出推送到下游，末端节点完成后工作流会自动停止。

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
├── public/                 # 静态资源、Assets 与工作流元数据
├── scripts/                # 构建与启动脚本
├── src/
│   ├── app/                # 页面路由与布局
│   │   ├── globals.css     # 全局样式（含 React Flow 覆写）
│   │   ├── layout.tsx      # 根布局（dark 模式）
│   │   └── page.tsx        # 首页（动态加载 FlowEditor）
│   ├── components/
│   │   ├── flow/           # 节点编辑器核心组件
│   │   │   ├── FlowEditor.tsx     # 主编辑器（ReactFlowProvider + WorkflowContext + 画布）
│   │   │   ├── Sidebar.tsx        # 左侧导航栏（Node Library + Assets + Workflows Library）
│   │   │   ├── TopBar.tsx         # 顶部控制栏（Save Workflow / Clear / Run / Stop + 进度显示）
│   │   │   ├── custom-nodes.tsx   # 自定义节点组件 + LightParams/MaterialParams 类型定义
│   │   │   ├── LightControls.tsx  # 灯光参数调整 UI 组件
│   │   │   ├── InteractiveModelViewer.tsx  # Three.js 交互式 3D 预览器（支持灯光参数）
│   │   │   ├── ModelViewer.tsx    # Three.js 3D 模型预览器（支持灯光参数）
│   │   │   ├── PLYViewer.tsx      # Three.js PLY / 点云预览器
│   │   │   └── SplatViewer.tsx    # Gaussian Splat / PLY 预览器
│   │   └── ui/             # Shadcn UI 组件库
│   ├── hooks/              # 自定义 Hooks（含 use-workflow-runner React 适配层）
│   ├── lib/
│   │   ├── node-config.ts  # 节点展示配置与常量（由 workflow registry 派生）
│   │   ├── utils.ts        # 通用工具函数 (cn)
│   │   ├── workflow/       # 工作流契约、节点注册表、图编译器、运行状态、调度器和 executors
│   │   └── workflow-context.ts # 工作流运行状态 React Context
│   └── server.ts           # 自定义服务端入口
├── next.config.ts
├── package.json
└── tsconfig.json
```

## 核心功能模块

### 工作流引擎

工作流采用"点击运行 → 自动编排"模式：

1. **中心注册表**：`src/lib/workflow/node-registry.ts` 是唯一节点契约来源，统一定义端口、默认数据、触发条件、完成条件、数据包读写、重置逻辑和 executor。
2. **图编译与迁移**：`graph-compiler.ts` 校验 DAG、端口兼容、重复输入、环和 dangling edges；`migrations.ts` 把旧保存工作流升级到当前 schema，并清理已删除节点/字段。
3. **运行状态管理**：`createWorkflowRunner()` 以 runId 为边界调度节点，统一处理启动顺序、进度 patch、输出传播、过期结果保护、取消和自动完成；`use-workflow-runner.ts` 只是 React Flow 适配层。
4. **交互节点暂停**：Surface Processing 是 `interactive` 节点；默认工作流运行到该节点会进入 `waiting-for-user`，用户点击 Apply 时通过 `runSingleNode(id)` 继续后续自动节点。
5. **停止/清空**：Stop 由 runner abort 所有当前节点 controller，并调用取消接口终止 Gaussian Splat 等长时间后端任务；Clear 会先 Stop，再清空上传文件、输出文件和节点状态，但保留节点布局与连线。
6. **节点触发条件**：
   - **Video Upload**：用户手动上传视频，上传完成后输出 `videoServerPath`，同时保存目标帧数
   - **Frame Extraction**：registry readiness 满足 `videoServerPath` 后由 runner 自动提取帧，输出 `frames`
   - **Gaussian Splat Gen**：接收 `frames` 或手动/上游 PLY；根据输入和设备走 True training 或 Fast Initializer。True training 输出 `splatUrl`，Fast Initializer/直接 PLY 输出 `sourcePlyUrl`，节点会让已有下游连线跟随当前模式切换输出句柄
   - **Mesh Gen**：registry readiness 满足 `modelUrl` 后由 runner 自动接收 splat/PLY/OBJ/GLB，转换或处理为下游可用的 GLB/OBJ/PLY；PLY/splat 重建后执行 `geometry_graph_surface` mesh face 分层，最多输出 8 个几何层
   - **Model Cleanup**：registry readiness 满足 `modelUrl` 且有上游连接后，由 runner 自动调用 Blender 清理/整理模型
   - **Surface Processing**：接收模型后可调材质/灯光；用户点击 Apply 触发 `runSingleNode(id)`，成功后把 `lightParams` 与层信息传到下游
   - **ComfyUI Video Gen**：registry readiness 满足 `modelUrl` 且有上游连接后，由 runner 把模型复制到自动检测到的本机 ComfyUI `input/3d`，提交内置 API workflow，轮询任务并下载输出视频
   - **Video Preview**：默认接收 ComfyUI 的 `videoUrl` 并直接播放；接收模型输入时仍可调用旋转视频 API 生成 360° 预览视频

### 节点注册表端口契约

端口映射不再通过单独的 `SOURCE_HANDLE_MAP` / `TARGET_HANDLE_MAP` 维护。每个节点的 `readOutput()` 和 `applyInput()` 都定义在 `WORKFLOW_NODE_REGISTRY` 中，runner 只通过这些契约传递 `WorkflowPacket`。新增或修改节点时必须同步更新 registry、compiler/runner 相关测试和默认 workflow 测试。

### 节点系统
节点库提供 9 种节点类型；Default Workflow 使用 8 个处理/输出节点和 3 个 Sticky Note：

```text
Sticky Note             Sticky Note        Sticky Note

Video Upload → Frame Extraction → Gaussian Splat Gen → Mesh Gen → Model Cleanup → Surface Processing → ComfyUI Video Gen → Video Preview
```

1. **Video Upload** - 上传视频、显示封面预览、设置 frame count；输出 `videoServerPath` 给 Frame Extraction
2. **Frame Extraction** - 按目标帧数提取图片帧，显示输出文件夹和帧数量；输出 `frames`
3. **Gaussian Splat Gen** - 接收 image frames 或直接上传/接收 PLY；显示设备类型、目标 PLY 类型、训练步数和真实进度；支持 auto / True training / Fast Initializer 路径，并按运行模式切换 `splat-output` 或 `mesh-output`
4. **Mesh Gen** - 接收 splat/PLY/OBJ/GLB，重建或整理为 GLB/OBJ/PLY；PLY/splat mesh 生成后执行 `geometry_graph_surface`，输出主模型、最多 8 个 layer GLB 和分层 metadata
5. **Model Cleanup** - 接收上游模型文件，调用 Blender 清理/整理模型，并透传 layerNames/layerGlbUrls
6. **Surface Processing** - 预览模型，按层调整材质参数和灯光参数；材质/颜色变化会写入 Blender 输出，并把 lightParams 与层信息传到下游
7. **ComfyUI Video Gen** - 接收 Surface Processing 输出模型，检测本机 ComfyUI 和 Seedance pack，提交 API workflow，并把生成视频传给 Video Preview
8. **Video Preview** - 接收视频时直接播放；接收模型时可调用旋转视频 API 生成 360° 视频
9. **Sticky Note** - 注释节点，只记录想法或流程说明，不参与运行和数据传输

### Mesh Gen 输入规则
- **Model handle**（必填）：接收 splat、PLY、OBJ 或 GLB，通过 `modelUrl` + `inputType` 字段存储
- **Gaussian Splat 输入**：来自 `gaussianSplat.splat-output` 的数据会被识别为 `inputType: 'splat'`，进入 splat/PLY → mesh/GLB 转换路径
- **普通模型输入**：非 splat 输入会根据 URL 后缀推断 `ply` / `obj` / `glb`，并沿用对应处理路径

### 灯光参数传递链
灯光参数（`LightParams`）从 Surface Processing 节点产生。其实际用途取决于下游路径：

```text
Surface Processing → Video Preview（直接模型路径，生成 360° rotation video）
Surface Processing → ComfyUI Video Gen → Video Preview（Default Workflow，播放 ComfyUI 成片）
```

- **LightParams 接口**：`ambientIntensity`、`mainLightIntensity`、`mainLightColor`、`mainLightAzimuth`、`mainLightElevation`、`fillLightIntensity`、`fillLightAzimuth`、`fillLightElevation`、`exposure`
- **前端预览**：ModelViewer / InteractiveModelViewer 接收 `lightParams` 并实时更新 Three.js 场景灯光
- **Blender 渲染**：`blender_material.py` 接收灯光参数控制场景灯光和材质输出
- **视频生成**：模型直接连接 Video Preview 时，`generate_rotation_video.py` / rotation video API 使用灯光参数控制渲染效果；ComfyUI 节点虽然接收模型元数据，但 Default Workflow 的成片外观由 ComfyUI 内置 workflow preset 控制

### 分层信息传递链
当前分层职责位于 Mesh Gen。PLY/splat 完成网格重建后，`geometry_graph_surface` 根据 face adjacency、法线角度和连通区域生成最多 8 个 layer GLB；这些信息沿后续模型处理链透传：

```text
Gaussian Splat Gen / PLY source → Mesh Gen → Model Cleanup → Surface Processing
```

- **layerNames**: 各层名称数组
- **layerGlbUrls**: 各层转换后的 GLB 路径数组
- **Assets 发布**: Mesh Gen 会把多个 layer GLB 合并成保留内部层节点/对象名称的 `merged.glb` 后登记到 Assets；独立 layer GLB 保持为临时处理文件
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
- 节点间连线使用可选中的自定义 edge；选中后高亮并显示删除按钮，也可按 Delete/Backspace 删除。只有有连线的节点才传输文件数据
- 节点右上角删除按钮；可上传预览框在已有文件时显示清除 X
- 画布缩放、平移、MiniMap、Controls；右下角 Controls 保留 fit 功能
- 顶栏包含 Save Workflow、Clear、Run / Stop
- Save Workflow 保存当前节点布局和连线到侧边栏 Workflows Library
- Clear 清空上传文件、生成输出和节点状态，但保留节点布局与连线
- Run 启动工作流自动编排；Stop 停止工作流并调用后端取消长任务
- 运行时显示已完成/总节点数，末端节点全部完成后自动停止

### 左侧导航
- 可折叠/展开
- **Node Library**：按类别展示 Video Upload、Frame Extraction、Gaussian Splat Gen、Mesh Gen、Model Cleanup、Surface Processing、ComfyUI Video Gen、Video Preview 和 Sticky Note
- **Assets**：展示已发布/临时资产，支持视频与模型缩略图
- **Workflows Library**：保存用户工作流，并内置不可删除的 Default Workflow

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
- Handle 的 `id` 属性用于多输入/多输出端口区分（如 Gaussian Splat 的 `splat-output` / `mesh-output`）
- Gaussian Splat Gen 与 Mesh Gen 的已有连线会按运行模式在 `splat-output`（True training）和 `mesh-output`（Fast Initializer/直接 PLY）之间自动切换
- Mesh Gen 源端口 id 为 `output`，目标端口 id 为 `model-input`

### 工作流开发规范
- 节点执行、端口、默认数据、触发条件和完成条件必须先注册到 `src/lib/workflow/node-registry.ts`
- 节点 API 调用和轮询逻辑放在 `src/lib/workflow/executors/`；React 节点组件不要各自实现工作流执行旁路
- Run / Stop / Clear 由 `createWorkflowRunner()` 和 `useWorkflowRunner()` 管理；节点按钮通过 `runSingleNode(id)` 触发单节点执行
- 数据传递只能通过 registry 的 `readOutput()` / `applyInput()` 和 runner 传播，避免在组件里手写下游节点更新
- 新增节点类型需补齐 registry 测试、graph compiler 测试、runner/默认工作流回归测试，并确保迁移逻辑不会恢复已删除 legacy 字段
