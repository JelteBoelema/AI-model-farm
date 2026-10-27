import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Liveness probe: the process is up. Never touches dependencies.
export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
