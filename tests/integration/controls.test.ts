import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { assertNotPaused, findActivePause, PausedError, setControlSwitch } from "@/server/controls";
import { makeCreator, makeProvider } from "./helpers";

const actor = { type: "USER" as const, id: null, label: "ops@test" };

describe("kill switches", () => {
  afterAll(async () => {
    await db.controlSwitch.updateMany({ data: { paused: false } });
  });

  it("pauses a single creator without affecting others", async () => {
    const a = await makeCreator();
    const b = await makeCreator();
    await setControlSwitch(actor, { scope: "CREATOR", targetId: a.id, paused: true, reason: "identity drift" });
    await expect(assertNotPaused({ chain: "generation", creatorId: a.id })).rejects.toBeInstanceOf(PausedError);
    await expect(assertNotPaused({ chain: "generation", creatorId: b.id })).resolves.toBeUndefined();
    await setControlSwitch(actor, { scope: "CREATOR", targetId: a.id, paused: false, reason: "fixed" });
    await expect(assertNotPaused({ chain: "generation", creatorId: a.id })).resolves.toBeUndefined();
  });

  it("pauses a provider", async () => {
    const p = await makeProvider();
    await setControlSwitch(actor, { scope: "PROVIDER", targetId: p.id, paused: true, reason: "provider incident" });
    expect(await findActivePause({ chain: "generation", providerId: p.id })).toMatchObject({ scope: "PROVIDER", reason: "provider incident" });
  });

  it("stops the whole publishing chain but not generation", async () => {
    await setControlSwitch(actor, { scope: "ALL_PUBLISHING", paused: true, reason: "platform outage" });
    await expect(assertNotPaused({ chain: "publishing" })).rejects.toThrow(/platform outage/);
    await expect(assertNotPaused({ chain: "generation" })).resolves.toBeUndefined();
    await setControlSwitch(actor, { scope: "ALL_PUBLISHING", paused: false, reason: "resolved" });
    await expect(assertNotPaused({ chain: "publishing" })).resolves.toBeUndefined();
  });

  it("audits every change and requires a reason and valid target", async () => {
    await expect(setControlSwitch(actor, { scope: "ALL_GENERATION", paused: true, reason: "" })).rejects.toThrow(/reason/);
    await expect(setControlSwitch(actor, { scope: "CREATOR", paused: true, reason: "missing target" })).rejects.toThrow(/target/);
    const before = await db.auditLog.count({ where: { action: { in: ["control.paused", "control.resumed"] } } });
    await setControlSwitch(actor, { scope: "ALL_GENERATION", paused: true, reason: "drill" });
    await setControlSwitch(actor, { scope: "ALL_GENERATION", paused: false, reason: "drill over" });
    expect(await db.auditLog.count({ where: { action: { in: ["control.paused", "control.resumed"] } } })).toBe(before + 2);
  });
});
