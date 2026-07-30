import { NextResponse } from 'next/server';
import { DEFAULT_COMFY_VIDEO_PRESET } from '@/lib/comfyui-video-preset';

export async function GET() {
  return NextResponse.json({
    success: true,
    preset: DEFAULT_COMFY_VIDEO_PRESET,
  });
}
