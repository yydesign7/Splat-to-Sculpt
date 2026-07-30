from __future__ import annotations

import re
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

import av
import folder_paths
import imageio_ffmpeg


VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}


def _natural_key(path: Path):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", path.name)]


def _run(command: list[str], label: str) -> None:
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        tail = "\n".join(result.stderr.splitlines()[-35:])
        raise RuntimeError(f"{label}失败（ffmpeg 返回 {result.returncode}）：\n{tail}")


def _probe(path: Path) -> tuple[float, int, int, bool]:
    with av.open(str(path)) as container:
        video_streams = [stream for stream in container.streams if stream.type == "video"]
        if not video_streams:
            raise ValueError(f"没有视频轨：{path}")
        stream = video_streams[0]
        duration = None
        if stream.duration is not None and stream.time_base is not None:
            duration = float(stream.duration * stream.time_base)
        elif container.duration is not None:
            duration = float(container.duration / av.time_base)
        if not duration or duration <= 0:
            raise ValueError(f"无法读取视频时长：{path}")
        return duration, int(stream.width), int(stream.height), any(s.type == "audio" for s in container.streams)


def _encoder_args(ffmpeg: str, encoder: str) -> list[str]:
    if encoder == "auto":
        check = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, errors="replace")
        encoder = "h264_nvenc" if "h264_nvenc" in check.stdout else "libx264"
    if encoder == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0"]
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "18"]


def _resolution(value: str, first_width: int, first_height: int) -> tuple[int, int]:
    if value == "跟随第一个镜头":
        return first_width // 2 * 2, first_height // 2 * 2
    width, height = value.split(" ", 1)[0].split("x")
    return int(width), int(height)


class SeedanceAdAssembler:
    @classmethod
    def INPUT_TYPES(cls):
        default_folder = str(Path(folder_paths.get_output_directory()) / "Seedance_Ads" / "clips")
        return {
            "required": {
                "镜头文件夹": ("STRING", {"default": default_folder, "multiline": False}),
                "成片名称": ("STRING", {"default": "jewelry_ad_final", "multiline": False}),
                "目标画幅": ([
                    "1080x1920 竖屏9:16",
                    "1920x1080 横屏16:9",
                    "1080x1080 方形1:1",
                    "720x1280 竖屏9:16",
                    "1280x720 横屏16:9",
                    "跟随第一个镜头",
                ], {"default": "1080x1920 竖屏9:16"}),
                "帧率": ("INT", {"default": 24, "min": 12, "max": 60, "step": 1}),
                "转场": (["直接切镜", "淡化"], {"default": "淡化"}),
                "转场秒数": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 2.0, "step": 0.05}),
                "背景音乐": ("STRING", {"default": "", "multiline": False}),
                "音乐音量": ("FLOAT", {"default": 0.18, "min": 0.0, "max": 2.0, "step": 0.01}),
                "编码器": (["auto", "h264_nvenc", "libx264"], {"default": "auto"}),
            }
        }

    RETURN_TYPES = ("STRING", "INT", "FLOAT")
    RETURN_NAMES = ("成片路径", "镜头数量", "成片时长秒")
    FUNCTION = "assemble"
    CATEGORY = "Seedance广告视频"
    OUTPUT_NODE = True

    def assemble(
        self,
        镜头文件夹: str,
        成片名称: str,
        目标画幅: str,
        帧率: int,
        转场: str,
        转场秒数: float,
        背景音乐: str,
        音乐音量: float,
        编码器: str,
    ):
        clips_dir = Path(镜头文件夹).expanduser()
        if not clips_dir.is_absolute():
            clips_dir = Path(folder_paths.get_output_directory()) / clips_dir
        clips_dir = clips_dir.resolve()
        if not clips_dir.is_dir():
            raise FileNotFoundError(f"镜头文件夹不存在：{clips_dir}")

        clips = sorted(
            [path for path in clips_dir.iterdir() if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS],
            key=_natural_key,
        )
        if not clips:
            raise FileNotFoundError(f"文件夹里没有视频：{clips_dir}")

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        probes = [_probe(path) for path in clips]
        width, height = _resolution(目标画幅, probes[0][1], probes[0][2])
        transition = min(max(float(转场秒数), 0.0), min(duration for duration, *_ in probes) / 2)
        if 转场 == "直接切镜":
            transition = 0.0

        music_path = None
        if 背景音乐.strip():
            candidate = Path(背景音乐.strip()).expanduser()
            if not candidate.is_absolute():
                input_candidate = Path(folder_paths.get_input_directory()) / candidate
                candidate = input_candidate if input_candidate.exists() else clips_dir / candidate
            music_path = candidate.resolve()
            if not music_path.is_file():
                raise FileNotFoundError(f"背景音乐不存在：{music_path}")

        safe_name = re.sub(r"[^\w\-\u4e00-\u9fff]+", "_", Path(成片名称).stem).strip("_") or "seedance_ad"
        final_dir = Path(folder_paths.get_output_directory()) / "Seedance_Ads" / "final"
        final_dir.mkdir(parents=True, exist_ok=True)
        output_path = final_dir / f"{safe_name}_{datetime.now():%Y%m%d_%H%M%S}.mp4"

        with tempfile.TemporaryDirectory(prefix="seedance_ad_", dir=folder_paths.get_temp_directory()) as temp_name:
            temp_dir = Path(temp_name)
            normalized: list[Path] = []
            durations: list[float] = []
            for index, (clip, (duration, _, _, has_audio)) in enumerate(zip(clips, probes), start=1):
                normalized_path = temp_dir / f"clip_{index:03d}.mp4"
                command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(clip)]
                if not has_audio:
                    command += ["-f", "lavfi", "-t", f"{duration:.6f}", "-i", "anullsrc=r=48000:cl=stereo"]
                audio_map = "0:a:0" if has_audio else "1:a:0"
                video_filter = (
                    f"fps={帧率},scale={width}:{height}:force_original_aspect_ratio=decrease,"
                    f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p"
                )
                command += [
                    "-map", "0:v:0", "-map", audio_map,
                    "-vf", video_filter,
                    "-af", "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad",
                    "-t", f"{duration:.6f}",
                    *_encoder_args(ffmpeg, 编码器),
                    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                    "-movflags", "+faststart", str(normalized_path),
                ]
                print(f"[Seedance广告成片] 统一镜头 {index}/{len(clips)}：{clip.name}")
                _run(command, f"处理镜头 {clip.name}")
                normalized.append(normalized_path)
                durations.append(_probe(normalized_path)[0])

            command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
            for clip in normalized:
                command += ["-i", str(clip)]
            if music_path:
                command += ["-stream_loop", "-1", "-i", str(music_path)]

            filters: list[str] = []
            if len(normalized) == 1:
                filters += ["[0:v]setpts=PTS-STARTPTS[vbase]", "[0:a]asetpts=PTS-STARTPTS[abase]"]
                total_duration = durations[0]
            elif transition <= 0:
                concat_inputs = "".join(f"[{i}:v][{i}:a]" for i in range(len(normalized)))
                filters.append(f"{concat_inputs}concat=n={len(normalized)}:v=1:a=1[vbase][abase]")
                total_duration = sum(durations)
            else:
                for i, duration in enumerate(durations):
                    fade_out_start = max(0.0, duration - transition)
                    filters.append(
                        f"[{i}:v]fps={帧率},fade=t=in:st=0:d={transition:.6f},"
                        f"fade=t=out:st={fade_out_start:.6f}:d={transition:.6f},setpts=PTS-STARTPTS[v{i}]"
                    )
                    filters.append(
                        f"[{i}:a]aresample=48000,afade=t=in:st=0:d={transition:.6f},"
                        f"afade=t=out:st={fade_out_start:.6f}:d={transition:.6f},asetpts=PTS-STARTPTS[a{i}]"
                    )
                concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(len(normalized)))
                filters.append(f"{concat_inputs}concat=n={len(normalized)}:v=1:a=1[vbase][abase]")
                total_duration = sum(durations)

            if music_path:
                music_index = len(normalized)
                filters.append(
                    f"[{music_index}:a]aresample=48000,volume={float(音乐音量):.4f},"
                    f"atrim=0:{total_duration:.6f},asetpts=PTS-STARTPTS[music]"
                )
                filters.append("[abase][music]amix=inputs=2:duration=first:dropout_transition=2[aout]")
            else:
                filters.append("[abase]anull[aout]")

            command += [
                "-filter_complex", ";".join(filters),
                "-map", "[vbase]", "-map", "[aout]",
                *_encoder_args(ffmpeg, 编码器),
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                "-t", f"{total_duration:.6f}", "-movflags", "+faststart", str(output_path),
            ]
            print(f"[Seedance广告成片] 合并 {len(normalized)} 个镜头 → {output_path}")
            _run(command, "合并成片")

        final_duration = _probe(output_path)[0]
        return (str(output_path), len(clips), round(final_duration, 3))


NODE_CLASS_MAPPINGS = {"SeedanceAdAssembler": SeedanceAdAssembler}
NODE_DISPLAY_NAME_MAPPINGS = {"SeedanceAdAssembler": "Seedance 首饰广告成片器（1–3分钟）"}
