# 首屏聚焦与 ComfyUI 状态分离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. 本计划已于 2026-09-06 执行完成；验收记录见文末。

**Goal:** 默认页面打开时呈现可读、无遮挡的上传起点；缺少 ComfyUI 时显示中性的配置提示，连接探测不再修改任务运行状态。

**Architecture:** 视角由一次性的 viewport request 驱动，读取实际可见画布区域并定位入口节点。ComfyUI 连接与能力检测放入独立 hook，运行状态仍归 executor / runner；健康检查结果不写入运行字段。两部分可以独立实现和验收。

**Tech Stack:** 项目现有 Next.js 16、React 19、TypeScript 5、@xyflow/react 12、node:test + tsx；仅使用 pnpm，不新增依赖。

**Spec:** 本文“已确认的需求与实现决策”，根据本任务中用户要求“计划具体如何实现首屏聚焦起点、服务状态与运行状态分离”及前一轮方案整理。以下默认值已实现。

## Global Constraints

- 仅允许使用 pnpm 作为包管理器，严禁使用 npm 或 yarn。
- 禁止隐式 `any` 和 `as any`；函数参数、返回值需明确类型。
- 禁止在 JSX 渲染中使用 `Math.random()`、`Date.now()` 等不纯函数。
- 节点执行、端口、默认数据、触发条件和完成条件必须先注册到 `src/lib/workflow/node-registry.ts`。
- 节点 API 调用和轮询逻辑放在 `src/lib/workflow/executors/`；React 节点组件不要各自实现工作流执行旁路。连接探测属于 UI 服务可用性检查，不执行生成任务。
- 数据传递只能通过 registry 的 `readOutput()` / `applyInput()` 和 runner 传播。
- 本次不新增节点或修改端口；保留 8 个处理节点和 3 个 Sticky Note、现有位置、连线及保存时清理运行数据的规则。
- 本次保留 Sidebar 浮层布局；首屏定位必须扣除其真实遮挡区域。侧栏改为 flex 占位可以独立实施，定位算法仍应适用。
- 不动工作区中已有的报告、图片处理脚本和其他未提交文件。

## 已确认的需求与实现决策

### A. 首屏聚焦起点

- 首次打开默认工作流、用户主动载入 Default Workflow：聚焦 Video Upload。以 90% 为目标缩放，上传节点距可见画布左边缘 32px、顶部 48px。
- 根据剩余宽度自然露出后续节点，不以“完整放入三个节点”为缩小条件。只有单个起点节点都放不下时，才允许低于 85%；窄屏优先保持上传入口可操作。
- Sticky Note 不参与首次定位；用户点击右下角 Fit 时仍可查看整个工作流，包括便签。
- 普通已保存工作流继续全图 Fit，避免载入后把用户自己的布局误当默认模板；本次不扩展 viewport 持久化。
- Clear、运行状态更新、节点预览加载、普通增删节点都不触发自动重新定位。Clear 重挂载画布时恢复 Clear 前的 viewport。
- 用户开始拖动画布或缩放后，取消尚未执行的自动定位。Resize 和侧栏切换不触发全图 Fit，也不重置用户缩放。
- 空画布不定位；初始化取消或快速切换工作流时，旧请求不得覆盖新视角。

### B. 服务状态与运行状态分离

运行字段保留现有契约：`comfyStatus: idle | processing | done | error`、`errorMessage`、`progressText`、`promptId`、`videoUrl`。服务字段由 hook 在当前节点实例中维护，不保存为工作流运行数据。

| 情境 | 服务提示 | 任务状态 |
| --- | --- | --- |
| 首次开始自动探测 | 检查中 | idle |
| 默认地址无法连接，当前会话从未连接成功 | 未配置；“尚未检测到可用服务，请启动 ComfyUI 或设置地址” | idle |
| 用户明确编辑过地址，或本会话曾连接成功，随后无法连接 | 未连接；“请检查地址并启动服务” | 保持原任务状态 |
| 服务可达，Seedance 能力不完整 | 已连接 + 待配置（安装插件或重启） | 保持原任务状态 |
| 服务和所需能力正常 | 已连接 | 保持原任务状态 |
| 配置 URL 无效 | 地址无效，提示有效的本机 HTTP(S) 地址 | 保持原任务状态 |
| 应用自己的探测接口异常 | 检查失败，可重试并展开技术详情 | 保持原任务状态 |
| 实际生成请求失败 | 服务提示仍独立显示 | error，显示生成失败原因 |

“未配置”描述的是尚无可用连接，不推断用户机器上没有安装 ComfyUI。默认地址有字符串并不等于已配置。编辑地址的意图标记和历史连接记录只在当前节点会话保留；沿用现有模板载入清理设置的策略。

- 红色 Error 徽标和节点运行错误仅用于生成执行失败；探测原始 `fetch failed` 收入服务详情，不放入主错误区域。
- Check、Seedance 检查/安装、Sync preset 不得设置或清空 `comfyStatus` / `errorMessage`；它们各自显示操作结果。
- 任务已经 done 时断连，不删除视频；任务已经 error 时连接恢复，不清掉任务错误；processing 时探测断连，不提前把任务判为失败。
- 生成入口仍调用 `runSingleNode(id)`。整个 workflow 和单节点执行均在 executor 做实时服务/能力校验，不能仅依赖 UI 缓存。
- 本次不添加全图启动前预检或新的暂停状态：Run 可执行前面的步骤；实际到达 ComfyUI 且前置条件不满足时，runner 明确失败并提供启动/配置后重试的提示，不静默跳过、不永久等待。

## 当前代码证据

- `FlowEditor.tsx` 使用无条件 `fitView`；载入 workflow 使用 `setTimeout(...fitView, 100)`；Clear 递增 `canvasRevision` 导致 ReactFlow 重挂载。
- `Sidebar.tsx` 展开宽度 276px、折叠宽度 56px，均为 absolute；不能拿画布容器的全宽当可见宽度。
- `custom-nodes.tsx` 的 `refreshComfyStatus` 依赖 `comfyStatus` / `videoUrl`，Effect 因运行状态变化重新探测；离线写入 error，在线时还可能清除已有执行错误。
- `comfy-video-status/route.ts` 返回 `online: false` 和原始错误文本，不能区分服务不可达与探测接口自身故障。
- `runner.ts` 执行失败时只写 `errorMessage`，没有为 ComfyUI 同步 `comfyStatus: error`；独立取消状态也没有自动清除节点的 processing 展示。需要在 ComfyUI executor 生命周期中补齐，避免移除探测旁路后暴露错误徽标/停止状态不同步。
- `migrations.ts` 已从 registry defaults 重建载入节点数据，通常不需要提升 schema version；需用回归测试确认旧错误数据不会恢复。

## Task 1: 一次性首屏视角与 Clear 保持视角

**Files:**
- Create: `src/lib/workflow-entry-viewport.ts`
- Create: `src/lib/workflow-entry-viewport.test.ts`
- Create: `src/components/flow/WorkflowViewportController.tsx`
- Modify: `src/components/flow/FlowEditor.tsx`
- Modify: `src/components/flow/Sidebar.tsx`（仅暴露面板 DOM ref / 带类型的载入 entry）

**Interfaces:**

```ts
import type { Viewport } from '@xyflow/react';

export interface EntryViewportInput {
  anchor: { x: number; y: number; width: number; height: number };
  visible: { x: number; y: number; width: number; height: number };
}
export function calculateEntryViewport(input: EntryViewportInput): Viewport | null;

export type ViewportRequest =
  | { revision: number; mode: 'entry'; anchorId: string }
  | { revision: number; mode: 'overview' }
  | { revision: number; mode: 'restore'; viewport: Viewport };
```

- [x] 编写定位纯函数测试，先运行确认失败。至少覆盖展开/折叠遮挡、便签不影响定位、窄屏、零尺寸。

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateEntryViewport } from './workflow-entry-viewport';

test('entry starts inside visible canvas at readable zoom', () => {
  const result = calculateEntryViewport({
    anchor: { x: 50, y: 80, width: 280, height: 300 },
    visible: { x: 276, y: 0, width: 1164, height: 800 },
  });
  assert.deepEqual(result, { x: 263, y: -24, zoom: 0.9 });
});

test('zero-sized canvas waits for layout', () => {
  assert.equal(calculateEntryViewport({
    anchor: { x: 50, y: 80, width: 280, height: 300 },
    visible: { x: 276, y: 0, width: 0, height: 0 },
  }), null);
});
```

- [x] 实现计算：尺寸非正返回 null；`zoom = Math.min(0.9, (visible.width - 64) / anchor.width)`，再限制到当前 ReactFlow 支持的缩放范围。`x = visible.x + 32 - anchor.x * zoom`，`y = visible.y + 48 - anchor.y * zoom`。极窄区域不足边距时减少边距，避免负缩放。节点过高允许向下滚动/平移，不为了显示整张长节点压缩首屏。
- [x] Controller 在 ReactFlow 内使用 `useNodesInitialized()`、`viewportInitialized` 和 ResizeObserver，确认当前 request 的节点集已挂载且 anchor 已测量后调用 `setViewport`；避免读取上一个 workflow 的测量数据。每个 request revision 只成功消费一次，初始化不使用固定延时。
- [x] DOM refs 分别读取画布和 Sidebar 实际矩形。仅当左侧面板与画布相交时扣除交集宽度，将其转换为画布局部坐标；未来侧栏占位时交集自然为 0。不要在算法中硬编码 276/56。
- [x] 移除 ReactFlow 初始 `fitView` 和载入时的 100ms timeout。初始化发出 entry request；Sidebar 载入参数保留 entry.id，使用 `DEFAULT_WORKFLOW_ID` 判断 entry/overview。普通 workflow 的 overview 在测量完成后调用原有 `fitView({ padding: 0.2 })`；空图直接消费请求。
- [x] Clear 在递增 `canvasRevision` 前通过 `getViewport()` 记录当前视角，将其同时作为重挂载的 `defaultViewport` 和 restore request；不要因组件重新挂载而生成 entry request。
- [x] 用户画布移动开始事件带有真实输入事件时取消 pending request；代码设置 viewport 产生的回调不能被当作用户输入。快速载入时用 revision 忽略旧异步结果；自动定位不使用动画，避免清空/切换后延迟动画覆盖视角。
- [x] 运行 `pnpm exec node --import tsx --test src/lib/workflow-entry-viewport.test.ts`。浏览器验收 1440×900、1280×800 和窄窗口：上传入口可见、目标缩放 90%、Fit 能看全图；拖拽/缩放后 Clear、改变节点状态、切换 Sidebar 都不回到首屏。
- [x] 将该任务涉及的文件纳入最终实现提交（提交组织调整见执行记录）。

## Task 2: 定义独立的服务状态和可识别的探测结果

**Files:**
- Create: `src/lib/comfyui-service-state.ts`
- Create: `src/lib/comfyui-service-state.test.ts`
- Create: `src/app/api/comfy-video-status/route.test.ts`
- Modify: `src/app/api/comfy-video-status/route.ts`
- Modify: `src/lib/comfyui-server.ts`

**Interfaces:**

```ts
export type ComfyServiceStatus =
  | 'checking' | 'unconfigured' | 'disconnected'
  | 'connected' | 'invalid-url' | 'check-failed';

export type ComfyProbeKind =
  | 'connected' | 'unreachable' | 'invalid-url' | 'probe-failed';

export interface ComfyProbeResult {
  kind: ComfyProbeKind;
  online: boolean;
  detail: string | null;
  version: string | null;
  detectedInputDir: string | null;
  detectedOutputDir: string | null;
  detectedInput3dDir: string | null;
}

export function classifyComfyService(
  kind: ComfyProbeKind,
  context: { explicitAddress: boolean; connectedBefore: boolean },
): Exclude<ComfyServiceStatus, 'checking'>;
```

- [x] 先测试默认探测不可达、明确地址不可达、曾在线后不可达、invalid-url、probe-failed、connected。

```ts
test('default unreachable service is setup guidance', () => {
  assert.equal(classifyComfyService('unreachable', {
    explicitAddress: false, connectedBefore: false,
  }), 'unconfigured');
  assert.equal(classifyComfyService('unreachable', {
    explicitAddress: false, connectedBefore: true,
  }), 'disconnected');
  assert.equal(classifyComfyService('probe-failed', {
    explicitAddress: false, connectedBefore: false,
  }), 'check-failed');
});
```

- [x] 实现纯映射：connected/invalid-url 直接映射，probe-failed -> check-failed；unreachable 根据 `explicitAddress || connectedBefore` 决定 disconnected/unconfigured。该模块完全不接收运行状态，无写入运行字段的接口。
- [x] 状态接口正常探测结果返回 HTTP 200，包括 unreachable；URL 无效返回 400 + invalid-url；非预期内部故障返回 500 + probe-failed。前端按结构化 kind 处理，不能把任意非 2xx 当作“未配置”。响应保留 online 和已有目录字段，detail 保存技术信息。
- [x] `getComfySystemStats(comfyUrl: string, signal?: AbortSignal): Promise<unknown>` 向 fetch 传递 signal。状态路由设置 5 秒探测超时，并传递请求取消；只给探测加短超时，不影响现有最长 45 分钟的视频任务。
- [x] 用 Node/undici 的明确 cause code（例如 ECONNREFUSED、连接超时）及 Abort/Timeout 错误类型识别 unreachable；不通过匹配 `fetch failed` 文本判断。协议返回异常、无法解析的响应和未知异常保留为 probe-failed。
- [x] 路由测试 mock fetch 并在每个测试后恢复：断连返回 unreachable；有效响应返回版本/目录；非法 URL 不发出请求；内部异常仍为 probe-failed；超时结束而非悬挂。
- [x] 运行 `pnpm exec node --import tsx --test src/lib/comfyui-service-state.test.ts src/app/api/comfy-video-status/route.test.ts`，通过后纳入最终实现提交。

## Task 3: 节点接入服务 hook，去掉对运行状态的旁路写入

**Files:**
- Create: `src/hooks/use-comfy-service-status.ts`
- Modify: `src/components/flow/custom-nodes.tsx`
- Modify: `src/lib/comfyui-video-preset.ts`
- Modify: `src/lib/workflow/executors/comfy-video.ts`（移除返回 patch 中的 comfyOnline）
- Test: `src/lib/workflow/migrations.test.ts`
- Test: `src/lib/default-workflow-comfy.test.ts`

**Interfaces:**

```ts
export interface ComfyServiceSnapshot {
  status: ComfyServiceStatus;
  probe: ComfyProbeResult | null;
}
export interface UseComfyServiceStatusOptions {
  comfyUrl: string;
  explicitAddress: boolean;
}
export interface UseComfyServiceStatusResult {
  service: ComfyServiceSnapshot;
  refresh: () => Promise<void>;
}
export function useComfyServiceStatus(
  options: UseComfyServiceStatusOptions,
): UseComfyServiceStatusResult;
```

- [x] hook 的服务结果使用 `classifyComfyService`；只依赖地址/显式配置意图。挂载和地址稳定 400ms 后自动探测，Check 立即探测。URL 每次编辑都先取消旧请求并作废结果，不等到 debounce 结束才取消。
- [x] 每次请求递增序号并创建 AbortController；提交结果前验证序号、地址和未卸载条件。取消不显示失败；旧地址响应和旧 Seedance 检查结果不能污染新地址。Cleanup 取消请求及 timer，兼容 Strict Mode 的 effect 重启。
- [x] 在 ComfyVideoNode 使用 hook 渲染服务行；任务徽标继续从 data.comfyStatus 派生。优先直接读取 data 运行字段，移除 comfyStatus/errorMessage 等运行字段的冗余本地镜像，避免重渲染间状态不一致。
- [x] 删除 `refreshComfyStatus` 内对 `comfyStatus`、`errorMessage` 的全部写入；从默认数据、组件类型与 executor 结果移除冗余 `comfyOnline`，连接真值只来自 hook。已生成视频的目录 metadata 可继续保留，服务面板展示当前 probe 的目录，两者不互相覆盖。
- [x] UI 主提示按需求表显示。未配置/未连接使用中性颜色；技术 detail 放入服务详情。只有生成的 errorMessage 进入红色任务错误区域。
- [x] Seedance 检查仅在当前地址连接成功后执行，保持与服务检查相同的过期保护。插件缺失显示待配置，现有安装按钮仅在服务在线且未安装时启用。
- [x] Sync preset 的失败消息使用独立 `presetMessage: string | null`；成功只清自己的消息。预设改变地址时重新探测，不能清除任务错误。
- [x] Generate 按钮仍根据模型是否有效、任务是否 processing 控制；按钮附近显示服务要求。移除 handleGenerate 中 Seedance 旁路写入任务 error 的逻辑，统一交给下一任务的 executor 实时校验。
- [x] 添加模板/迁移回归：载入旧 `comfyStatus: 'error', errorMessage: 'fetch failed', comfyOnline: false` 节点后得到 idle/null 且不含 comfyOnline；确认默认节点仍具有相同类型、端口和设置默认值，schema 仍为 2。
- [x] 浏览器使用延迟/失败响应验证：processing 时 Check 不改任务；done 后断连视频仍在；error 后在线错误仍在；快速改地址旧结果无效；地址稳定后一次探测，任务状态变化不触发额外探测。
- [x] 运行迁移和默认 workflow 测试，通过后纳入最终实现提交。

## Task 4: 统一生成校验、真实错误和取消生命周期

**Files:**
- Modify: `src/lib/workflow/executors/comfy-video.ts`
- Modify: `src/lib/workflow/executors/output-executors.test.ts`
- Modify: `src/lib/workflow/runner.test.ts`
- Modify: `src/lib/workflow/default-workflow-runtime.test.ts`
- Test: `src/lib/workflow/node-registry.test.ts`（实际文件名已确认；现有契约测试通过）
- Inspect: `src/lib/workflow/node-registry.ts`（保留现有 readiness/completion 契约；只有契约测试证明缺失时才改）

**Interfaces:** 保持 `executeComfyVideo(context: WorkflowNodeExecutorContext): Promise<Record<string, unknown>>`。使用 Task 2 的 ComfyProbeResult，通过 context.apiFetch 和 context.signal 请求状态接口，再检查现有 `/api/comfy-seedance-status` 的 ready。

- [x] 在现有 executor 测试辅助函数基础上增加真实契约用例：状态 unreachable 时请求列表不含 generate；connected 但插件未 ready 时不提交；均就绪时顺序为 status -> Seedance status -> generate；失败 patch 包含 error 状态；abort 不生成 error patch。

```ts
test('unavailable ComfyUI fails execution without submitting a job', async () => {
  const patches: Record<string, unknown>[] = [];
  const ctx = context({
    node: node('comfyVideo', { modelUrl: '/model.glb' }),
    responses: [{ kind: 'unreachable', online: false }],
    reportProgress: (patch) => patches.push(patch),
  });
  await assert.rejects(executeComfyVideo(ctx), /ComfyUI/);
  assert.equal(ctx.requests.some((url) => url.includes('/api/generate-comfy-video')), false);
  assert.equal(patches.at(-1)?.comfyStatus, 'error');
});
```

- [x] executor 开始时验证模型，发出 processing + “Checking ComfyUI requirements…”；清空上一轮任务错误。实时检查服务和 Seedance 能力，失败给出“启动 ComfyUI 并检查连接后重试”或“安装 Seedance / 重启后重试”等可操作原因。只有预检通过后，才清旧输出并发起生成 POST。
- [x] 所有请求携带 context.signal；加入覆盖整个函数的 try/catch：非 abort 异常 `reportProgress({ comfyStatus: 'error', errorMessage: message, progressText: null })` 后继续 throw，让 runner 按原规则标记失败；成功返回 done。
- [x] abort 时 executor 清理自己的进行中展示：发出 `comfyStatus: 'idle', progressText: null`，不清除更早成功的视频，不添加错误，然后抛出取消。这个同步 abort listener 在 runner 作废 activeRunId 前执行；finally 移除 listener。为 Stop 与紧接着重新 Run 写回归，证明旧任务 finally 不覆盖新 run；如果现有 runner 的保护拒绝取消 patch，再把生命周期 patch 定义进 registry 并由 runner 在取消前统一调用，不能在组件手写取消旁路。
- [x] 保持 registry readiness 只检查模型/连线，不用服务缓存返回永久 not-ready。getCompletion 继续只读任务字段，服务状态不参与错误/完成判定。
- [x] runner 回归使用真实 Comfy executor + mock API：首次未配置但未运行没有任务 error；实际执行失败后节点 error 和 runner failed 一致；修复连接后重新执行成功并传播视频；Stop 后不残留 processing，不发布迟到输出；默认工作流仍在 Surface Processing 暂停并由 Apply 继续。
- [x] 更新现有成功 executor 测试的响应队列为三段，保持对视频 metadata 和下游传播的既有断言。
- [x] 完成目标测试后纳入最终实现提交。

## 集成验证与交付

- [x] 用 `rg --files src` 获取实际测试列表，使用 pnpm exec node --import tsx --test 运行本次新增测试、workflow 目录测试、default-workflow-comfy 与 comfyui 现有测试；不使用不存在的 pnpm test script。
- [x] 运行 `pnpm exec tsc --noEmit` 和 `pnpm lint`；区分既有问题与新增问题，保留输出证据。
- [x] 使用 `pnpm dev` 和浏览器在 ComfyUI 未启动的环境验收：首屏 Video Upload 可读且不被展开侧栏遮挡，ComfyUI 显示中性未配置，无 Error/fetch failed 主提示。
- [x] 手工验证载入 Default Workflow / 普通保存 workflow / Fit / Clear / Sidebar 切换和窗口缩放的视角差异符合需求表。
- [x] 用 mock 探测及生成响应覆盖连接成功、插件缺失、探测失败、真正生成失败、成功后断连和迟到响应；不为验证首屏而启动实际长时间模型训练或视频生成。
- [x] 检查 `git diff --check`，确认变更只涉及两个目标及其测试。交付说明附首屏截图、状态转换验证结果和未能执行的环境检查。

## 实施顺序

1. Task 1 独立交付首屏体验。
2. Task 2 定义服务检查契约。
3. Task 3 完成 UI 状态分离。
4. Task 4 保证两个生成入口的执行与取消行为一致。
5. 完成集成验证后汇报。实现与验收结果如下。


## 执行记录（2026-09-06）

- Task 1–4 均已完成。分支：`codex/first-screen-comfy-status`。相关文件统一纳入一个实现提交，便于整体审阅与回滚；没有合并 main 或推送远端。
- 全部 30 个 TypeScript 测试文件通过，共 88 项测试。命令：`rg --files -0 src -g '*.test.ts' | xargs -0 pnpm exec node --import tsx --test`。
- `pnpm exec tsc --noEmit`、`pnpm lint`、`git diff --check` 均通过。
- `tsx` CLI 在沙箱中创建 IPC socket 被限制，改用相同 tsx loader 配合 Node 原生 test runner；未新增依赖。
- 1280×720 与 1440×900 首屏：viewport 为 `translate(263px, -24px) scale(0.9)`，Video Upload 左缘 x=308px，位于展开侧栏右侧 32px。
- 500×800 窄窗口：缩放 0.64，上传节点位于 x=298.4–477.6px，完整落在侧栏右侧可见区域内。
- 用户缩放到 1.08 后，Clear 和 Sidebar 折叠均保持原 viewport。普通保存工作流加载后缩放约 0.542，Default Workflow 重载后恢复 0.9，并重置曾编辑过的 ComfyUI 地址。
- ComfyUI 未启动：服务显示“未配置”，任务 Idle，无任务 Error。编辑到不可达地址显示“未连接”。临时本机状态服务验证 slow -> fast 地址切换，最终只显示 `test-fast`，任务仍为 Idle，缺失 Seedance 显示“待配置”。
- executor / runner 测试覆盖服务不可达、Seedance 缺失、真实生成失败、失败后重试并传播视频、Stop 清除 processing、旧 run 不覆盖新 run。额外验证状态探测将 5 秒 deadline 传入上游 fetch。
- 独立审查发现并修复：库内排队的 fitView 可能覆盖新视角（改为直接计算 overview viewport）；取消安装残留 busy（按 controller 身份清除）；旧 run finally 删除新 controller（增加身份检查）。复核无剩余具体问题。
- 现有 5001 服务仍提供启动时的旧代码，验收使用临时目录的独立 5002 预览，未中断既有进程。临时目录只复制源码/配置，复用已安装依赖；没有启动真实训练、生成视频或安装 Seedance。
- 首屏截图：`/tmp/splat-first-screen-verified.png`。工作区中原有报告和图片脚本未改动。

### 相对初始步骤的实现调整

- 服务缓存放在独立 hook，使用 AbortController 身份代替额外的数字请求序号；Seedance 的 Check 复用完整服务检查，保持地址与能力结果一致。
- workflow 载入重挂载画布，以清除复用节点 ID 的旧本地设置；普通 workflow overview 使用 `getViewportForBounds` + `setViewport`，不调用会排队的 fitView。
- 端口、schema version 和 registry readiness/completion 无需改变，现有 registry、compiler、默认 workflow 回归保持通过。运行错误和取消 patch 由 Comfy executor 提供，未添加运行旁路。
- 默认流程暂停/恢复继续由已有 default-workflow-runtime 测试覆盖；新增生命周期用例放在 executor 与 runner 测试中，避免重复相同调度断言。
- 浏览器采用实际页面和临时本机状态响应验证；完整视频生成链路用 mock API 回归覆盖，未执行耗时生成任务。
