#!/usr/bin/env python3
"""
Generate a 360° rotation video from a 3D model (OBJ/GLB/FBX/PLY).

For .glb/.gltf, uses Blender EEVEE (when ``blender`` is available) so glTF materials
and base colors match the asset; other formats use trimesh + pyrender / matplotlib.

Usage:
  python3 generate_rotation_video.py \
    --obj <model_file_path> \
    --output-dir <output_directory> \
    [--fps 30] \
    [--duration 6] \
    [--width 512] \
    [--height 512]

Output (JSON on stdout, last line):
  {
    "status": "ok",
    "video_path": "<path_to_mp4>",
    "total_frames": 180
  }
"""

import os
import sys
import json
import argparse
import traceback
import shutil
import subprocess

import trimesh
import numpy as np
import math


def _unimport_gl_modules() -> None:
    """Drop pyrender/OpenGL from sys.modules so a new PYOPENGL_PLATFORM is honored on re-import."""
    to_drop = [k for k in list(sys.modules) if k == "pyrender" or k.startswith("OpenGL")]
    for k in to_drop:
        try:
            del sys.modules[k]
        except KeyError:
            pass


def spherical_to_cartesian(azimuth_deg: float, elevation_deg: float, radius: float = 5.0):
    """Convert spherical coordinates (azimuth, elevation in degrees) to cartesian (x, y, z)."""
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    x = radius * math.cos(el) * math.cos(az)
    y = radius * math.cos(el) * math.sin(az)
    z = radius * math.sin(el)
    return np.array([x, y, z])


def make_light_pose(position: np.ndarray, target: np.ndarray = np.zeros(3)):
    """Create a 4x4 pose matrix for a light looking from position toward target."""
    forward = target - position
    forward = forward / np.linalg.norm(forward)
    up = np.array([0, 0, 1])
    right = np.cross(forward, up)
    if np.linalg.norm(right) < 1e-6:
        up = np.array([0, 1, 0])
        right = np.cross(forward, up)
    right = right / np.linalg.norm(right)
    up = np.cross(right, forward)
    up = up / np.linalg.norm(up)
    pose = np.eye(4)
    pose[:3, 0] = right
    pose[:3, 1] = up
    pose[:3, 2] = -forward  # OpenGL convention: -Z is forward
    pose[:3, 3] = position
    return pose


def resolve_blender_executable() -> str | None:
    """Prefer macOS app bundle, then PATH (same idea as Node resolveBlenderCommand)."""
    if sys.platform == "darwin":
        mac_path = "/Applications/Blender.app/Contents/MacOS/Blender"
        if os.path.isfile(mac_path):
            return mac_path
    return shutil.which("blender")


def _parse_last_json_line(stdout: str) -> dict | None:
    for line in reversed(stdout.strip().split("\n")):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return None


def try_blender_gltf_rotation_video(
    model_path: str,
    output_dir: str,
    model_name: str,
    fps: int,
    duration: int,
    width: int,
    height: int,
    light_params: dict | None,
) -> tuple[str, int] | None:
    """
    Render GLB/GLTF turntable with Blender EEVEE so glTF materials display correctly.
    Writes PNG frames then encodes H.264 via ffmpeg.
    """
    blender = resolve_blender_executable()
    if not blender:
        print("[rotation-video] Blender not found; skipping GLB EEVEE path", file=sys.stderr)
        return None

    script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "blender_rotation_video.py")
    if not os.path.isfile(script_path):
        print(f"[rotation-video] Missing script: {script_path}", file=sys.stderr)
        return None

    frames_dir = os.path.join(output_dir, "_rotation_frames")
    shutil.rmtree(frames_dir, ignore_errors=True)
    os.makedirs(frames_dir, exist_ok=True)

    light_json = os.path.join(output_dir, "_rotation_light.json")
    if os.path.isfile(light_json):
        try:
            os.remove(light_json)
        except OSError:
            pass
    if light_params:
        with open(light_json, "w", encoding="utf-8") as f:
            json.dump(light_params, f)

    total_frames = max(1, int(fps * duration))
    cmd = [
        blender,
        "--background",
        "--python",
        script_path,
        "--",
        "--model",
        os.path.abspath(model_path),
        "--frames-dir",
        os.path.abspath(frames_dir),
        "--total-frames",
        str(total_frames),
        "--width",
        str(width),
        "--height",
        str(height),
    ]
    if light_params:
        cmd.extend(["--light-json", os.path.abspath(light_json)])

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=900_000,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"[rotation-video] Blender subprocess failed: {e}", file=sys.stderr)
        return None

    parsed = _parse_last_json_line(proc.stdout or "")
    if proc.returncode != 0 or not parsed or parsed.get("status") != "ok":
        tail = (proc.stderr or "")[-2000:] if proc.stderr else ""
        print(
            f"[rotation-video] Blender render failed (code {proc.returncode}): "
            f"{parsed or proc.stdout[-500:]!s}\nstderr: {tail}",
            file=sys.stderr,
        )
        return None

    output_video = os.path.join(output_dir, f"{model_name}_rotate_360.mp4")
    frame_pattern = os.path.join(frames_dir, "%04d.png")
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-framerate",
                str(fps),
                "-i",
                frame_pattern,
                "-frames:v",
                str(total_frames),
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-preset",
                "fast",
                "-crf",
                "23",
                output_video,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"[rotation-video] ffmpeg encode failed: {e}", file=sys.stderr)
        return None

    shutil.rmtree(frames_dir, ignore_errors=True)
    for p in (light_json,):
        if os.path.isfile(p):
            try:
                os.remove(p)
            except OSError:
                pass

    return output_video, total_frames


def load_model(model_path):
    """Load a 3D model file (OBJ/GLB/FBX/PLY) and return a trimesh.Trimesh."""
    ext = os.path.splitext(model_path)[1].lower()
    # For single-mesh formats, force="mesh" to get a Trimesh directly
    if ext in ('.obj', '.ply', '.stl'):
        return trimesh.load(model_path, force="mesh")
    # For scene-based formats (GLB/GLTF/FBX), load without force and
    # concatenate into a single mesh if needed
    loaded = trimesh.load(model_path)
    if isinstance(loaded, trimesh.Trimesh):
        return loaded
    if isinstance(loaded, trimesh.Scene):
        meshes = list(loaded.geometry.values())
        if len(meshes) == 1:
            return meshes[0]
        return trimesh.util.concatenate(meshes)
    return loaded


def try_pyrender_render(mesh, width, height, cam_dist, total_frames, fps, output_video, light_params=None):
    """Strategy 1: pyrender (EGL or OSMesa) — fast, GPU/software-accelerated."""
    # Default light params
    lp = light_params or {
        "ambientIntensity": 0.6,
        "mainLightIntensity": 0.8,
        "mainLightColor": [1.0, 1.0, 1.0],
        "mainLightAzimuth": 45,
        "mainLightElevation": 45,
        "fillLightIntensity": 0.3,
        "fillLightAzimuth": -135,
        "fillLightElevation": 30,
        "exposure": 1.0,
    }

    # On macOS, CGL (unset) is worth trying before Linux-only EGL/OSMesa. Reset modules each attempt.
    if sys.platform == "darwin":
        try_order: list = [None, "egl", "osmesa"]
    else:
        try_order = ["egl", "osmesa"]

    for platform in try_order:
        try:
            _unimport_gl_modules()
            if platform is not None:
                os.environ["PYOPENGL_PLATFORM"] = platform
            else:
                os.environ.pop("PYOPENGL_PLATFORM", None)

            import pyrender
            import cv2

            scene = pyrender.Scene(bg_color=[26, 26, 46])
            mesh_node = scene.add(pyrender.Mesh.from_trimesh(mesh))

            camera = pyrender.PerspectiveCamera(yfov=np.pi / 3.0)
            cam_pose = np.array([
                [1, 0, 0, 0],
                [0, 1, 0, 0],
                [0, 0, 1, cam_dist],
                [0, 0, 0, 1]
            ])
            scene.add(camera, pose=cam_pose)

            # Main directional light with custom params — position from spherical coordinates
            main_color = np.array(lp.get("mainLightColor", [1.0, 1.0, 1.0]))
            main_intensity = lp.get("mainLightIntensity", 0.8) * 3.75  # scale for pyrender
            main_az = lp.get("mainLightAzimuth", 45)
            main_el = lp.get("mainLightElevation", 45)
            main_pos = spherical_to_cartesian(main_az, main_el, radius=cam_dist)
            main_pose = make_light_pose(main_pos)
            light = pyrender.DirectionalLight(color=main_color, intensity=main_intensity)
            scene.add(light, pose=main_pose)

            # Fill light from opposite side — position from spherical coordinates
            fill_az = lp.get("fillLightAzimuth", -135)
            fill_el = lp.get("fillLightElevation", 30)
            fill_pos = spherical_to_cartesian(fill_az, fill_el, radius=cam_dist)
            fill_pose = make_light_pose(fill_pos)
            fill_intensity = lp.get("fillLightIntensity", 0.3) * 3.75
            fill_light = pyrender.DirectionalLight(color=np.ones(3), intensity=fill_intensity)
            scene.add(fill_light, pose=fill_pose)

            # Ambient light via a dim directional from above
            ambient_intensity = lp.get("ambientIntensity", 0.6) * 3.75
            ambient_pose = np.array([
                [1, 0, 0, 0],
                [0, 0, 1, 0],
                [0, -1, 0, cam_dist],
                [0, 0, 0, 1]
            ])
            ambient_light = pyrender.DirectionalLight(color=np.ones(3), intensity=ambient_intensity)
            scene.add(ambient_light, pose=ambient_pose)

            r = pyrender.OffscreenRenderer(width, height)
            frames = []

            for i in range(total_frames):
                angle = (i / total_frames) * 2 * np.pi
                rot = trimesh.transformations.rotation_matrix(angle, [0, 1, 0])
                scene.set_pose(mesh_node, rot)

                color, _ = r.render(scene)
                frame = cv2.cvtColor(color, cv2.COLOR_RGB2BGR)
                frames.append(frame)

            r.delete()

            # Write video
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            video = cv2.VideoWriter(output_video, fourcc, fps, (width, height))
            for frame in frames:
                video.write(frame)
            video.release()

            return output_video, total_frames

        except Exception as e:
            tag = platform or "native"
            print(f"[rotation-video] pyrender ({tag}) failed: {e}", file=sys.stderr)
            continue

    return None


def try_matplotlib_render(mesh, width, height, cam_dist, total_frames, fps, output_video):
    """Strategy 2: matplotlib — pure software, no GPU/EGL needed. Optimized for speed."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    import cv2

    vertices = mesh.vertices
    faces = mesh.faces
    center = mesh.centroid
    scale = float(mesh.extents.max())

    # Try to get face colors
    face_colors = None
    try:
        face_colors = mesh.visual.face_colors
    except Exception:
        pass

    # Use lower DPI for speed, then resize to target resolution
    render_dpi = 50
    render_size = min(width, height)
    figsize = (render_size / render_dpi, render_size / render_dpi)

    # Reuse figure across frames for performance
    fig = plt.figure(figsize=figsize, dpi=render_dpi, facecolor='#1a1a2e')
    ax = fig.add_subplot(111, projection='3d', facecolor='#1a1a2e')

    mesh_poly = Poly3DCollection(vertices[faces], alpha=0.9)
    if face_colors is not None:
        mesh_poly.set_facecolor(face_colors / 255.0)
    else:
        mesh_poly.set_facecolor([0.5, 0.45, 0.4, 0.9])
    mesh_poly.set_edgecolor([0.3, 0.3, 0.3, 0.1])
    ax.add_collection3d(mesh_poly)

    ax.set_xlim(center[0] - scale, center[0] + scale)
    ax.set_ylim(center[1] - scale, center[1] + scale)
    ax.set_zlim(center[2] - scale, center[2] + scale)
    ax.set_axis_off()

    frames = []
    for i in range(total_frames):
        angle = (i / total_frames) * 360
        ax.view_init(elev=25, azim=angle)
        # Draw in-memory (Agg). Avoid per-frame savefig to disk — was 10+ min on macOS headless.
        fig.canvas.draw()
        w, h = fig.canvas.get_width_height()
        if hasattr(fig.canvas, "buffer_rgba"):
            buf = np.asarray(fig.canvas.buffer_rgba())
            rgb = buf[:, :, :3]
        else:
            rgb = np.frombuffer(
                fig.canvas.tostring_rgb(), dtype=np.uint8
            ).reshape((h, w, 3))
        frame = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        frame = cv2.resize(frame, (width, height))
        frames.append(frame)
    plt.close(fig)

    # Write video
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    video = cv2.VideoWriter(output_video, fourcc, fps, (width, height))
    for frame in frames:
        video.write(frame)
    video.release()

    return output_video, total_frames


def transcode_to_h264(input_path, fps):
    """Transcode video to H.264 for browser compatibility using FFmpeg.

    OpenCV VideoWriter with mp4v codec produces MPEG-4 Part 2 (FMP4),
    which browsers cannot play. This function re-encodes to H.264 (avc1).
    """
    import subprocess

    tmp_path = input_path + "_mp4v.mp4"
    os.rename(input_path, tmp_path)

    try:
        subprocess.run(
            [
                'ffmpeg', '-y',
                '-i', tmp_path,
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-preset', 'fast',
                '-crf', '23',
                '-r', str(fps),
                input_path,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        # If FFmpeg fails, restore the original file
        print(f"[rotation-video] FFmpeg H.264 transcode failed: {e}, keeping mp4v format", file=sys.stderr)
        if os.path.exists(input_path):
            os.remove(input_path)
        os.rename(tmp_path, input_path)
        return input_path

    # Clean up temp file
    os.remove(tmp_path)
    return input_path


def generate_360_rotation_video(obj_path, output_dir, fps=30, duration=6, width=512, height=512, light_params=None):
    """Generate a 360° rotation video from a 3D model file (OBJ/GLB/FBX/PLY)."""

    model_name = os.path.splitext(os.path.basename(obj_path))[0]
    output_video = os.path.join(output_dir, f"{model_name}_rotate_360.mp4")

    ext = os.path.splitext(obj_path)[1].lower()
    if ext in (".glb", ".gltf"):
        b = try_blender_gltf_rotation_video(
            obj_path, output_dir, model_name, fps, duration, width, height, light_params
        )
        if b:
            final_path = transcode_to_h264(b[0], fps)
            return final_path, b[1]
        print("[rotation-video] EEVEE path failed; falling back to trimesh/pyrender", file=sys.stderr)

    # Load model (supports OBJ, GLB, FBX, PLY)
    mesh = load_model(obj_path)

    # Compute camera distance based on model bounding box
    bbox = mesh.bounding_box
    extents = bbox.extents
    max_dim = max(float(x) for x in extents) if len(extents) > 0 else 1.0
    cam_dist = max_dim * 2.5

    total_frames = fps * duration

    # Strategy 1: pyrender (fast)
    result = try_pyrender_render(mesh, width, height, cam_dist, total_frames, fps, output_video, light_params)
    if result:
        # Transcode to H.264 for browser compatibility
        final_path = transcode_to_h264(result[0], fps)
        return final_path, result[1]

    # Strategy 2: matplotlib (slow but reliable)
    print("[rotation-video] Falling back to matplotlib renderer...", file=sys.stderr)
    result = try_matplotlib_render(mesh, width, height, cam_dist, total_frames, fps, output_video)
    if result:
        # Transcode to H.264 for browser compatibility
        final_path = transcode_to_h264(result[0], fps)
        return final_path, result[1]

    raise RuntimeError("视频生成失败: 所有渲染策略均不可用")


def main():
    parser = argparse.ArgumentParser(description="Generate 360° rotation video from 3D model")
    parser.add_argument("--model", required=False, help="Input model file path (OBJ/GLB/FBX/PLY)")
    parser.add_argument("--obj", required=False, help="Alias for --model (legacy)")
    parser.add_argument("--output-dir", required=True, help="Output directory")
    parser.add_argument("--fps", type=int, default=30, help="Video frame rate (default: 30)")
    parser.add_argument("--duration", type=int, default=6, help="Video duration in seconds (default: 6)")
    parser.add_argument("--width", type=int, default=512, help="Video width (default: 512)")
    parser.add_argument("--height", type=int, default=512, help="Video height (default: 512)")
    parser.add_argument("--light-params", required=False, default=None, help="JSON string with light parameters")
    args = parser.parse_args()

    model_path = args.model or args.obj
    if not model_path:
        parser.error("Either --model or --obj is required")

    # Parse light params
    light_params = None
    if args.light_params:
        try:
            light_params = json.loads(args.light_params)
        except json.JSONDecodeError:
            print(f"[rotation-video] Warning: Failed to parse light params JSON", file=sys.stderr)

    try:
        os.makedirs(args.output_dir, exist_ok=True)

        video_path, total_frames = generate_360_rotation_video(
            obj_path=model_path,
            output_dir=args.output_dir,
            fps=args.fps,
            duration=args.duration,
            width=args.width,
            height=args.height,
            light_params=light_params,
        )

        result = {
            "status": "ok",
            "video_path": video_path,
            "total_frames": total_frames,
        }
        print(json.dumps(result, ensure_ascii=False))

    except Exception as e:
        error_result = {
            "status": "error",
            "error": str(e),
            "traceback": traceback.format_exc(),
        }
        print(json.dumps(error_result, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
