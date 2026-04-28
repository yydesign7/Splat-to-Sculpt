import open3d as o3d
import numpy as np
import os

# ================= 配置区域 =================
MESH_FILE = "mesh_result.ply"          # 基础网格
SEGMENT_FOLDER = "layers_v4"           # 分层文件夹

# 最终结果保存的子文件夹名字
DELIVERABLE_FOLDER = "final_deliverables"

# 定义颜色 (R, G, B)
LABEL_COLORS = [
    [0.5, 0.5, 0.5],  # 0: 灰 (桌子)
    [0.0, 0.0, 1.0],  # 1: 蓝 (瓶身)
    [1.0, 0.0, 0.0],  # 2: 红 (商标)
    [0.0, 1.0, 0.0],  # 3: 绿
    [1.0, 1.0, 0.0],  # 4: 黄
    [0.0, 1.0, 1.0]   # 5: 青
]
# ===========================================

def run_texture_mapping():
    # 1. 路径设置
    current_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(current_dir)
    output_dir = os.path.join(project_root, "output")
    
    # 定义最终交付物的文件夹路径
    final_output_dir = os.path.join(output_dir, DELIVERABLE_FOLDER)
    if not os.path.exists(final_output_dir):
        os.makedirs(final_output_dir)
        print(f"[*] 创建交付文件夹: {final_output_dir}")
    
    mesh_path = os.path.join(output_dir, MESH_FILE)
    seg_dir = os.path.join(output_dir, SEGMENT_FOLDER)
    
    print(f"[*] 读取基础网格: {mesh_path}")
    if not os.path.exists(mesh_path):
        print("[!] 错误: 找不到 Mesh 文件，请先运行 gs_to_mesh.py 更新网格！")
        return
    
    mesh = o3d.io.read_triangle_mesh(mesh_path)
    mesh.paint_uniform_color([0, 0, 0]) # 初始全黑
    
    # 2. 准备图层文件
    if not os.path.exists(seg_dir):
        print(f"[!] 错误: 找不到分割文件夹 {seg_dir}")
        return
        
    layer_files = sorted([f for f in os.listdir(seg_dir) if f.endswith(".ply")])
    print(f"[*] 检测到 {len(layer_files)} 个图层文件，开始映射...")

    if len(layer_files) == 0:
        print("[!] 文件夹里是空的！")
        return

    # 创建 Mesh 顶点的临时点云用于计算距离
    mesh_pcd = o3d.geometry.PointCloud()
    mesh_pcd.points = mesh.vertices

    # 3. 逐层上色
    for idx, filename in enumerate(layer_files):
        layer_path = os.path.join(seg_dir, filename)
        
        # 简单颜色分配
        color = LABEL_COLORS[idx % len(LABEL_COLORS)]
        
        print(f"    [-] 处理: {filename} -> 分配颜色 {color}")
        
        # 读取分层点云
        pcd_layer = o3d.io.read_point_cloud(layer_path)
        
        if len(pcd_layer.points) == 0:
            continue

        # 计算距离
        dists = mesh_pcd.compute_point_cloud_distance(pcd_layer)
        dists = np.asarray(dists)
        
        # 阈值判定
        mask = dists < 0.03
        
        # 应用颜色
        mesh_colors = np.asarray(mesh.vertex_colors)
        mesh_colors[mask] = color
        mesh.vertex_colors = o3d.utility.Vector3dVector(mesh_colors)

    # 4. 导出结果 (保存到 final_deliverables 文件夹)
    print("-" * 30)
    print(f"[*] 正在保存最终交付物至: output/{DELIVERABLE_FOLDER}/")
    
    # 导出 OBJ
    save_obj = os.path.join(final_output_dir, "labeled_mesh.obj")
    o3d.io.write_triangle_mesh(save_obj, mesh)
    print(f"    [OK] OBJ 模型: labeled_mesh.obj")
    
    # 导出 GLB
    save_glb = os.path.join(final_output_dir, "labeled_mesh.glb")
    try:
        o3d.io.write_triangle_mesh(save_glb, mesh)
        print(f"    [OK] GLB 模型: labeled_mesh.glb")
    except:
        pass

    # 5. 截图
    print("[*] 正在生成 Label Map 截图...")
    vis = o3d.visualization.Visualizer()
    vis.create_window(visible=True, width=800, height=600, window_name="Final Label Map")
    vis.add_geometry(mesh)
    
    ctr = vis.get_view_control()
    ctr.rotate(0.0, -100.0) 
    
    vis.poll_events()
    vis.update_renderer()
    
    image_path = os.path.join(final_output_dir, "label_map_final.png")
    vis.capture_screen_image(image_path)
    print(f"    [OK] PNG 截图: label_map_final.png")
    
    print("-" * 30)
    print(f"[Success] 所有文件已归档！请查看 output/{DELIVERABLE_FOLDER} 文件夹。")
    print("[*] 按 Q 退出预览窗口")
    
    vis.run()
    vis.destroy_window()

if __name__ == "__main__":
    run_texture_mapping()