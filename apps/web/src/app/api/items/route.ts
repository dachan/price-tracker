import { NextResponse } from "next/server";
import { z } from "zod";

import { service } from "@/lib/service";

const createItemSchema = z.object({
  url: z.string().url(),
  currency: z.string().length(3).optional(),
});

export async function POST(request: Request) {
  try {
    const payload = createItemSchema.parse(await request.json());
    const result = await service.createItem(payload);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Invalid request",
      },
      { status: 400 },
    );
  }
}

export async function GET() {
  try {
    const items = await service.listItems();
    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to list items",
      },
      { status: 500 },
    );
  }
}
