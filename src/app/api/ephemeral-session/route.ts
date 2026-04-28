import { NextRequest, NextResponse } from 'next/server';
import { cleanupEphemeralSession, isValidEphemeralSessionId } from '@/lib/ephemeral-storage';

/**
 * POST /api/ephemeral-session
 * Body: { action: 'cleanup', sessionId: string }
 * Deletes all files for a workflow browser session (e.g. on full page reload).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, sessionId } = body as { action?: string; sessionId?: string };

    if (action !== 'cleanup') {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
    if (!isValidEphemeralSessionId(sessionId)) {
      return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
    }

    await cleanupEphemeralSession(sessionId);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Cleanup failed';
    console.error('[ephemeral-session]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
