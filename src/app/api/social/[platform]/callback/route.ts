import { NextResponse } from "next/server";
import type { Platform } from "@prisma/client";
import { actingUserOf, getCurrentUser } from "@/server/auth/session";
import { DomainError } from "@/server/errors";
import { logger } from "@/server/logger";
import { PlatformError } from "@/server/platforms/types";
import { completeConnect } from "@/server/services/social";

export const dynamic = "force-dynamic";

const PLATFORMS: Record<string, Platform> = { instagram: "INSTAGRAM", tiktok: "TIKTOK", youtube: "YOUTUBE" };

// OAuth redirect target. Never trusts query parameters beyond the one-time state check.
export async function GET(req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const url = new URL(req.url);
  const platform = PLATFORMS[(await params).platform];
  const back = (q: Record<string, string>) => NextResponse.redirect(new URL(`/social?${new URLSearchParams(q)}`, url.origin), 303);
  if (!platform) return NextResponse.json({ error: "not found" }, { status: 404 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", url.origin), 303);
  try {
    const account = await completeConnect(actingUserOf(user), {
      platform,
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
    });
    return back({ connected: account.id });
  } catch (err) {
    if (err instanceof DomainError || err instanceof PlatformError) return back({ error: err.message });
    logger.error({ err: (err as Error).message }, "social connect failed");
    return back({ error: "Connecting the account failed" });
  }
}
