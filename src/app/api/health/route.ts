import { NextResponse } from "next/server";
import { checkHealth } from "@/server/health";

export const dynamic = "force-dynamic";

// Readiness probe: dependencies must be reachable. Error details stay in logs, not the response.
export async function GET() {
  const report = await checkHealth();
  const checks = Object.fromEntries(Object.entries(report.checks).map(([k, v]) => [k, { ok: v.ok, latencyMs: v.latencyMs }]));
  return NextResponse.json({ status: report.status, checks }, { status: report.status === "ok" ? 200 : 503, headers: { "cache-control": "no-store" } });
}
