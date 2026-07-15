import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    {
      error: 'Material Gen is temporarily disabled',
      code: 'MATERIAL_GEN_DISABLED',
    },
    { status: 503 },
  );
}
