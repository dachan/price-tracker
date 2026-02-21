import { NextResponse } from "next/server";

import { service } from "@/lib/service";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;

  try {
    const item = await service.getItemDetails(params.id);
    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to get item",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;

  try {
    await service.deleteItem(params.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to delete item",
      },
      { status: 500 },
    );
  }
}
