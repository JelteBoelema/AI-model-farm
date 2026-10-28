import { describe, expect, it } from "vitest";
import { toMicros } from "@/lib/money";
import { findActivePause } from "@/server/controls";
import { db } from "@/server/db";
import { changeCampaignStatus, createCampaign, setCampaignBudget, updateCampaign } from "@/server/services/campaigns";
import { acting, makeCreator, makeUser } from "./helpers";

describe("campaign management", () => {
  it("creates, edits and assigns creators; creators with open content stay assigned", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const [a, b] = [await makeCreator(), await makeCreator()];
    const c = await createCampaign(op, { name: "Spring drop", objective: "Launch", creatorIds: [a.id, b.id], startsAt: "2030-03-01", endsAt: "2030-04-01" });
    expect(await db.campaignCreator.count({ where: { campaignId: c.id } })).toBe(2);
    await expect(createCampaign(op, { name: "Backwards", startsAt: "2030-04-01", endsAt: "2030-03-01" })).rejects.toThrow(/end after it starts/);
    await db.contentItem.create({ data: { creatorId: b.id, campaignId: c.id, title: "Open item", format: "IMAGE_POST" } });
    await expect(updateCampaign(op, c.id, { name: "Spring drop", creatorIds: [a.id] })).rejects.toThrow(/open content/);
    await updateCampaign(op, c.id, { name: "Spring drop 2", creatorIds: [b.id] });
    expect((await db.campaignCreator.findMany({ where: { campaignId: c.id } })).map((x) => x.creatorId)).toEqual([b.id]);
  });

  it("pauses through the kill switch; resuming needs an admin", async () => {
    const op = acting(await makeUser("OPERATOR"));
    const admin = acting(await makeUser("ADMIN"));
    const c = await createCampaign(op, { name: "Pause test" });
    await changeCampaignStatus(op, c.id, "activate");
    await changeCampaignStatus(op, c.id, "pause", "Brand review");
    expect(await findActivePause({ chain: "publishing", campaignId: c.id })).toMatchObject({ scope: "CAMPAIGN", reason: "Brand review" });
    expect(await findActivePause({ chain: "generation", campaignId: c.id })).not.toBeNull();
    await expect(changeCampaignStatus(op, c.id, "resume")).rejects.toThrow(/permission/);
    await expect(changeCampaignStatus(op, c.id, "activate")).rejects.toThrow(/resume/);
    await changeCampaignStatus(admin, c.id, "resume");
    expect(await findActivePause({ chain: "publishing", campaignId: c.id })).toBeNull();
    expect((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("ACTIVE");
  });

  it("lets admins set or lower a budget but only the owner raise or remove it", async () => {
    const admin = acting(await makeUser("ADMIN"));
    const owner = acting(await makeUser("OWNER"));
    const c = await createCampaign(admin, { name: "Budget test" });
    await setCampaignBudget(admin, c.id, "MONTH", toMicros("200"));
    await setCampaignBudget(admin, c.id, "MONTH", toMicros("150"));
    await expect(setCampaignBudget(admin, c.id, "MONTH", toMicros("300"))).rejects.toThrow(/permission/);
    await expect(setCampaignBudget(admin, c.id, "MONTH", null)).rejects.toThrow(/permission/);
    await setCampaignBudget(owner, c.id, "MONTH", toMicros("300"));
    expect((await db.budgetPolicy.findFirstOrThrow({ where: { scope: "CAMPAIGN", targetId: c.id } })).limitMicros).toBe(toMicros("300"));
  });
});
