import open3d as o3d
import numpy as np
import os
import shutil

# ================= 配置区域 =================
INPUT_FILENAME = "scene.ply"    # 输入文件名
OUTPUT_FILENAME = "mesh_result.ply" # 默认输出文件名

# 泊松重建深度 (9为推荐值)
POISSON_DEPTH = 9 

# [升级 1] 坐标系校正开关 (配合 Teammate 1)
# 如果队友给的 SLAM 数据是倒着的或歪的，把这里改为 True
NEED_ROTATION = False 

# [升级 2] 是否导出额外格式 (配合 Teammate 2)
EXPORT_OBJ = True   # 通用格式，大部分软件都能开
EXPORT_GLB = True   # Web 和 ComfyUI 友好格式
# ===========================================

def check_and_get_data(data_dir):
    """
    检查 data 文件夹里有没有 input 文件，如果没有，
    就自动下载一个斯坦福兔子来顶替。
    """
    input_path = os.path.join(data_dir, INPUT_FILENAME)
    
    if os.path.exists(input_path):
        print(f"[*] 检测到本地数据: {input_path}")
        return input_path
    
    print(f"[!] data 文件夹里没找到 {INPUT_FILENAME}，正在启用【自动下载演示数据】模式...")
    print("[-] 正在下载斯坦福兔子 (Stanford Bunny)...")
    
    # 使用 Open3D 自带的数据集功能
    bunny_data = o3d.data.BunnyMesh()
    mesh = o3d.io.read_triangle_mesh(bunny_data.path)
    
    # 兔子原本是个网格，我们把它采样成点云，模拟 3DGS 的输入
    print("[-] 正在将演示模型转换为点云...")
    pcd = mesh.sample_points_poisson_disk(number_of_points=50000)
    
    # 保存到 data 文件夹
    print(f"[-] 已生成测试数据并保存至: {input_path}")
    o3d.io.write_point_cloud(input_path, pcd)
    
    return input_path

def run_pipeline():
    # 1. 路径设置
    current_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(current_dir)
    data_dir = os.path.join(project_root, "data")
    output_dir = os.path.join(project_root, "output")
    
    # 确保文件夹存在
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)

    output_path = os.path.join(output_dir, OUTPUT_FILENAME)

    # 2. 获取数据 (如果没数据，这里会自动下载兔子)
    input_path = check_and_get_data(data_dir)

    # 3. 开始处理流程
    print("-" * 30)
    print(f"[*] 开始执行网格转换流水线...")
    
    # 读取点云
    pcd = o3d.io.read_point_cloud(input_path)
    print(f"    原始点数: {len(pcd.points)}")

    # [升级 1] 坐标系校正 (针对 SLAM 数据可能的旋转问题)
    if NEED_ROTATION:
        print("[*] 检测到旋转修正开启，正在调整坐标系...")
        # 这里演示绕 X 轴旋转 180 度 (很多 SLAM 数据的 Y 轴是反的)
        # 这里的 (np.pi, 0, 0) 代表 X, Y, Z 轴的旋转弧度
        R = pcd.get_rotation_matrix_from_xyz((np.pi, 0, 0)) 
        pcd.rotate(R, center=(0, 0, 0))
        print("    -> 已旋转点云")

    # 预处理：下采样
    # 自适应计算 voxel_size
    center = pcd.get_center()
    max_bound = pcd.get_max_bound()
    scale = np.linalg.norm(max_bound - center)
    voxel_size = scale * 0.01 # 动态设定为尺寸的 1%
    
    print(f"[-] 正在下采样 (Voxel Size: {voxel_size:.4f})...")
    pcd_down = pcd.voxel_down_sample(voxel_size=voxel_size)

    # 去噪
    print("[-] 正在去除离群点...")
    cl, ind = pcd_down.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
    pcd_clean = pcd_down.select_by_index(ind)

    # 法线估计 (关键步骤)
    print("[-] 正在计算法线...")
    pcd_clean.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=voxel_size*2, max_nn=30)
    )
    pcd_clean.orient_normals_consistent_tangent_plane(100)

    # 泊松重建
    print(f"[-] 正在进行泊松重建 (Depth: {POISSON_DEPTH})...")
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd_clean, depth=POISSON_DEPTH
    )
    
    # 密度裁剪
    print("[-] 正在裁剪低密度区域...")
    densities = np.asarray(densities)
    density_threshold = np.percentile(densities, 5)
    vertices_to_remove = densities < density_threshold
    mesh.remove_vertices_by_mask(vertices_to_remove)
    
    # [升级 2] 多格式导出 (满足下游队友需求)
    print("-" * 30)
    # 1. 保存 PLY (原定格式)
    o3d.io.write_triangle_mesh(output_path, mesh)
    print(f"[Success] PLY 网格已保存: {output_path}")

    # 2. 保存 OBJ (通用格式)
    if EXPORT_OBJ:
        output_obj = output_path.replace(".ply", ".obj")
        o3d.io.write_triangle_mesh(output_obj, mesh)
        print(f"[Success] OBJ 网格已保存: {output_obj}")

    # 3. 保存 GLB (Artist Tool / ComfyUI 格式)
    if EXPORT_GLB:
        output_glb = output_path.replace(".ply", ".glb")
        # GLB 导出可能需要较新的 Open3D 版本，如果这里报错，请更新 pip install --upgrade open3d
        try:
            o3d.io.write_triangle_mesh(output_glb, mesh)
            print(f"[Success] GLB 网格已保存: {output_glb}")
        except Exception as e:
            print(f"[Warning] GLB 导出失败 (可能是Open3D版本过低)，已跳过: {e}")

    # 可视化
    print("-" * 30)
    print("[*] 正在打开预览窗口 (按 'Q' 退出)...")
    mesh.compute_vertex_normals()
    o3d.visualization.draw_geometries([mesh], 
                                      window_name="Pipeline Result (PLY/OBJ/GLB Exported)", 
                                      width=800, height=600,
                                      left=50, top=50,
                                      mesh_show_back_face=True)

if __name__ == "__main__":
    run_pipeline()