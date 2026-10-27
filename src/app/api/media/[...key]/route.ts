import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/session";
import { assertValidKey, storage } from "@/server/storage";

export const dynamic = "force-dynamic";

// Authenticated media delivery for the local storage driver (S3 uses short-lived signed URLs).
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const key = (await params).key.join("/");
  try {
    assertValidKey(key);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const asset = await db.mediaAsset.findUnique({ where: { storageKey: key }, select: { mimeType: true } });
  if (!asset || !(await storage().exists(key))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await storage().get(key);
  return new NextResponse(new Uint8Array(body), {
    headers: { "content-type": asset.mimeType, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" },
  });
}
