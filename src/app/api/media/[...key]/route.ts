import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { clientAddress, hit, tooManyRequests } from "@/server/rate-limit";
import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/session";
import { assertValidKey, storage } from "@/server/storage";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "private, max-age=300", "x-content-type-options": "nosniff", "accept-ranges": "bytes" };

// Authenticated media delivery for the local storage driver (S3 uses short-lived signed URLs).
// Supports single byte ranges so browsers can seek in video and audio.
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const limited = await hit("api-media", clientAddress(req.headers), env().RATE_LIMIT_API_PER_MINUTE);
  if (!limited.allowed) return tooManyRequests(limited);
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.mfaSetupRequired) return NextResponse.json({ error: "mfa_setup_required" }, { status: 403 });
  const key = (await params).key.join("/");
  try {
    assertValidKey(key);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const asset = await db.mediaAsset.findUnique({ where: { storageKey: key }, select: { mimeType: true } });
  if (!asset || !(await storage().exists(key))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await storage().get(key);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const size = body.length;
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new NextResponse(null, { status: 416, headers: { ...HEADERS, "content-range": `bytes */${size}` } });
    start = Math.max(0, start);
    return new NextResponse(new Uint8Array(body.subarray(start, end + 1)), {
      status: 206,
      headers: { ...HEADERS, "content-type": asset.mimeType, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  return new NextResponse(new Uint8Array(body), { headers: { ...HEADERS, "content-type": asset.mimeType, "content-length": String(body.length) } });
}
