# Seedance 3D 模型多角度参考图

把 `.blend`、`.fbx`、`.glb`、`.gltf` 或 `.obj` 放到：

`D:\comfui\input\3d`

重启 ComfyUI 后添加节点：

1. `Seedance广告视频 → 3D模型 → 加载3D模型（Seedance）`
2. `Seedance广告视频 → 3D模型 → Seedance 3D模型多角度参考图`

先在“加载3D模型”节点选择文件，再把它的 `3D模型` 输出连接到九角度渲染节点。

节点会在后台调用 Blender，渲染 8 个环绕角度和 1 个高位英雄角度。`全部角度（批次）`
适合连接预览或保存图片；九个独立输出分别连接 Seedance 的 `image_1` 到 `image_9`。

如果模型文件里横向摆了多个不同产品，把“场景选择”改为“自动选择靠近原点的单件”。
普通的单件模型保持“场景全部对象”即可。

生成文件保存在：

`D:\comfui\output\Seedance_3D_Views`

## 模型建议

- 首选 GLB 或完整的 Blender 工程，材质和贴图最不容易丢失。
- FBX 请把贴图放在模型同目录。
- OBJ 必须同时提供 MTL 和贴图。
- 模型中至少需要一个可渲染的 Mesh。
