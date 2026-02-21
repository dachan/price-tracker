import { NextResponse } from "next/server";

import { service } from "@/lib/service";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;

  try {
    const result = await service.runCheckForItem(params.id);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to run check",
      },
      { status: 500 },
    );
  }
}
