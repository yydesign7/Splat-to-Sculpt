import open3d as o3d
import numpy as np
import os

# ================= 配置区域 =================
INPUT_FILE = "scene.ply"         
OUTPUT_FOLDER = "layers_v4" 
# ===========================================

def run_segmentation_v4():
    # 1. 路径准备
    current_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(current_dir)
    input_path = os.path.join(project_root, "data", INPUT_FILE)
    output_dir = os.path.join(project_root, "output", OUTPUT_FOLDER)
    
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    print(f"[*] 读取点云: {input_path}")
    pcd = o3d.io.read_point_cloud(input_path)
    pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.05, max_nn=30))
    
    # ================= 第一阶段：强力去桌子 (Layer 0) =================
    print("-" * 30)
    print("[*] 正在移除背景(桌子)...")
    
    rest_pcd = pcd
    layer0_table = o3d.geometry.PointCloud()
    
    # 我们把距离阈值设为 0.04 (4cm)，这样能一口气吃掉有厚度的桌子
    # 只要法线朝上，就切切切！
    for i in range(5):
        plane_model, inliers = rest_pcd.segment_plane(distance_threshold=0.04, ransac_n=3, num_iterations=1000)
        
        if len(inliers) < 100: break 

        [a, b, c, d] = plane_model
        
        # 只要法线大致朝上 (c > 0.5)，就算桌子/地面
        if abs(c) > 0.5:
            part = rest_pcd.select_by_index(inliers)
            layer0_table += part
            rest_pcd = rest_pcd.select_by_index(inliers, invert=True)
            print(f"    -> 切除一层背景 ({len(part.points)} 点)")
        else:
            # 如果遇到垂直面，我们不切，但也不停止循环
            # 我们把这些点暂时“隐藏”，让RANSAC去切别的
            # (但在Open3D里很难暂时隐藏，所以我们直接跳出，交给DBSCAN处理)
            print(f"    -> 遇到垂直物体，停止切背景")
            break

    layer0_table.paint_uniform_color([0.5, 0.5, 0.5]) # 灰色桌子
    o3d.io.write_point_cloud(os.path.join(output_dir, "layer_0_body.ply"), layer0_table)

    # ================= 第二阶段：万物皆显 (Layer 1+) =================
    print("-" * 30)
    print("[*] 正在处理剩余物体...")
    
    vis_list = [layer0_table]
    
    # 聚类：把剩下的东西分成几堆
    if len(rest_pcd.points) > 10:
        labels = np.array(rest_pcd.cluster_dbscan(eps=0.04, min_points=30))
        max_label = labels.max()
        print(f"    -> 发现了 {max_label + 1} 个独立物体")
        
        # 遍历每一个物体 (不再只取最大的！)
        layer_count = 1
        for i in range(max_label + 1):
            # 提取当前物体
            obj_indices = np.where(labels == i)[0]
            current_obj = rest_pcd.select_by_index(obj_indices)
            
            # --- 子任务：在这个物体上找商标 ---
            # 尝试在这个物体上找平坦的小面
            plane_model, label_inliers = current_obj.segment_plane(distance_threshold=0.01, ransac_n=3, num_iterations=1000)
            
            # 只有当 平坦面点数占比 < 50% 时，才认为是“商标在瓶子上”
            # 如果 > 50%，说明这整个物体就是一个方盒子，不用拆
            ratio = len(label_inliers) / len(current_obj.points)
            
            if len(label_inliers) > 20 and ratio < 0.5:
                # 这是一个带商标的瓶子！
                print(f"    -> 物体 {i}: 检测到表面细节 (商标)")
                
                # 提取商标
                obj_label = current_obj.select_by_index(label_inliers)
                obj_label.paint_uniform_color([1.0, 0.0, 0.0]) # 红色
                
                # 提取瓶身
                obj_body = current_obj.select_by_index(label_inliers, invert=True)
                obj_body.paint_uniform_color([0.0, 0.0, 1.0]) # 蓝色
                
                # 保存
                o3d.io.write_point_cloud(os.path.join(output_dir, f"layer_{layer_count}_body.ply"), obj_body)
                layer_count += 1
                o3d.io.write_point_cloud(os.path.join(output_dir, f"layer_{layer_count}_detail.ply"), obj_label)
                layer_count += 1
                
                vis_list.append(obj_body)
                vis_list.append(obj_label)
                
            else:
                # 这是一个普通的物体 (或者没切干净的桌子渣)
                print(f"    -> 物体 {i}: 普通物体 (保留整体)")
                current_obj.paint_uniform_color([0.0, 1.0, 0.0]) # 绿色
                
                o3d.io.write_point_cloud(os.path.join(output_dir, f"layer_{layer_count}_detail.ply"), current_obj)
                layer_count += 1
                
                vis_list.append(current_obj)

    else:
        print("[!] 警告：桌子切完后没东西了！(可能是阈值太大把瓶子切了)")

    # ================= 结果展示 =================
    print("-" * 30)
    print(f"[*] 结果已保存至 {OUTPUT_FOLDER}")
    o3d.visualization.draw_geometries(vis_list, 
                                      window_name="Final Universal Result",
                                      width=800, height=600)

if __name__ == "__main__":
    run_segmentation_v4()