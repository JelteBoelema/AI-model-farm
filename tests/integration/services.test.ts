import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { toMicros } from "@/lib/money";
import { checkHealth } from "@/server/health";
import { getOverview, getSpend } from "@/server/services/dashboard";
import { PROVIDER_CATALOG } from "@/server/providers/catalog";
import { syncProviderRegistry } from "@/server/providers/registry";
import { makeCreator, uid } from "./helpers";

describe("health", () => {
  it("reports database, redis and storage as healthy", async () => {
    const report = await checkHealth();
    expect(report.status).toBe("ok");
    expect(Object.values(report.checks).every((c) => c.ok)).toBe(true);
  });
});

describe("spend read model", () => {
  it("separates measured, estimated and mock costs", async () => {
    const creator = await makeCreator();
    const base = { entryType: "CHARGE" as const, category: "IMAGE" as const, creatorId: creator.id };
    await db.costLedger.createMany({
      data: [
        { ...base, basis: "PROVIDER_REPORTED", amountMicros: toMicros("1.20"), idempotencyKey: `s:${uid()}` },
        { ...base, basis: "MEASURED", amountMicros: toMicros("0.30"), idempotencyKey: `s:${uid()}` },
        { ...base, basis: "ESTIMATED", amountMicros: toMicros("2.00"), uncertaintyNote: "no usage reported", idempotencyKey: `s:${uid()}` },
        { ...base, basis: "MEASURED", amountMicros: toMicros("9.99"), isMock: true, idempotencyKey: `s:${uid()}` },
      ],
    });
    const spend = await getSpend({ creatorId: creator.id });
    expect(spend).toEqual({ measuredMicros: toMicros("1.50"), estimatedMicros: toMicros("2.00"), mockMicros: toMicros("9.99"), entries: 4 });

    const overview = await getOverview({ creator: creator.id, period: "30d" });
    expect(overview.spend.measuredMicros).toBe(toMicros("1.50"));
    expect(overview.creators.total).toBe(1);
  });
});

describe("provider registry", () => {
  it("activates mocks and never providers whose adapter is not implemented, even with a key", async () => {
    process.env.RUNWAY_API_KEY = "rk-test-present";
    await syncProviderRegistry();
    const rows = await db.aiProvider.findMany({ where: { key: { in: PROVIDER_CATALOG.map((c) => c.key) } } });
    expect(rows).toHaveLength(PROVIDER_CATALOG.length);
    expect(rows.find((r) => r.key === "mock-text")!.status).toBe("ACTIVE");
    expect(rows.find((r) => r.key === "mock-image")!.status).toBe("ACTIVE");
    for (const key of ["runway", "google-veo", "elevenlabs", "bfl-flux", "mock-video"]) expect(rows.find((r) => r.key === key)!.status, key).not.toBe("ACTIVE");
    delete process.env.RUNWAY_API_KEY;
  });

  it("preserves an admin's DISABLED status on re-sync", async () => {
    await db.aiProvider.update({ where: { key: "runway" }, data: { status: "DISABLED" } });
    await syncProviderRegistry();
    expect((await db.aiProvider.findUniqueOrThrow({ where: { key: "runway" } })).status).toBe("DISABLED");
  });
});
