import { NextRequest, NextResponse } from 'next/server';
import { ImageGenerationClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import {
  buildEphemeralFileUrl,
  ensureSessionRoot,
  getEphemeralSessionFromRequest,
} from '@/lib/ephemeral-storage';

export async function POST(request: NextRequest) {
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const body = await request.json();
    const { prompt } = body as { prompt?: string };

    if (!prompt || !prompt.trim()) {
      return NextResponse.json({ error: 'No material description provided' }, { status: 400 });
    }

    // Build material-specific prompt (same strategy as 2.py)
    const materialPrompt = `${prompt.trim()}, seamless texture, tileable, flat material, 4k, high detail, no object, no shadow, plain surface, only texture`;
    const negativePrompt =
      'human, person, body, face, man, woman, furniture, sofa, chair, table, scene, shadow, blurry, low quality, noise, deformed';

    // Initialize SDK client with forwarded headers
    const config = new Config();
    const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
    const client = new ImageGenerationClient(config, customHeaders);

    // Generate texture image using SeeDream
    const response = await client.generate({
      prompt: materialPrompt,
      size: '2K',
    });

    const helper = client.getResponseHelper(response);

    if (!helper.success || helper.imageUrls.length === 0) {
      const errMsg = helper.errorMessages.join('; ') || 'Material image generation failed';
      console.error('[generate-texture] Generation failed:', errMsg);
      return NextResponse.json({ error: errMsg }, { status: 500 });
    }

    const imageUrl = helper.imageUrls[0];
    const jobId = randomUUID();
    const sessionRoot = await ensureSessionRoot(sessionId);
    const destDir = path.join(sessionRoot, 'textures', jobId);
    await mkdir(destDir, { recursive: true });

    const fileName = 'texture.png';
    const filePath = path.join(destDir, fileName);

    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
    await writeFile(filePath, Buffer.from(imageResponse.data));

    const textureUrl = buildEphemeralFileUrl(sessionId, `textures/${jobId}/${fileName}`);

    return NextResponse.json({
      success: true,
      textureUrl,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Material generation failed';
    console.error('[generate-texture] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
