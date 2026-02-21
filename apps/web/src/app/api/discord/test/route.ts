import { NextResponse } from "next/server";

import { service } from "@/lib/service";

export async function POST() {
  try {
    const result = await service.sendDiscordTestMessage();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to send Discord test",
      },
      { status: 500 },
    );
  }
}
