import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import type { CreatorStatus, UserRole } from "@prisma/client";

export const uid = () => randomUUID().slice(0, 8);

export async function makeUser(role: UserRole = "OPERATOR", password = "correct-horse-battery") {
  return db.user.create({ data: { email: `${role.toLowerCase()}-${uid()}@test.local`, name: `Test ${role}`, role, passwordHash: await hashPassword(password) } });
}

export async function makeCreator(overrides: Partial<{ name: string; status: CreatorStatus }> = {}) {
  const id = uid();
  return db.creator.create({
    data: {
      slug: `creator-${id}`,
      name: overrides.name ?? `Creator ${id}`,
      niche: "test",
      targetAudience: "test",
      language: "nl-NL",
      targetRegions: ["NL"],
      personality: "test",
      toneOfVoice: "test",
      backstory: "fictional",
      contentFormats: ["IMAGE_POST"],
      status: overrides.status ?? "ACTIVE",
    },
  });
}

export function acting(user: { id: string; role: UserRole; email: string }) {
  return { id: user.id, role: user.role, actor: { type: "USER" as const, id: user.id, label: user.email } };
}

export async function makeProvider() {
  return db.aiProvider.create({ data: { key: `mock-${uid()}`, displayName: "Mock", capabilities: ["IMAGE"], isMock: true } });
}

export async function makeSocialAccount(creatorId: string) {
  return db.socialAccount.create({ data: { creatorId, platform: "INSTAGRAM", handle: `h_${uid()}` } });
}

export async function makeContent(creatorId: string) {
  return db.contentItem.create({ data: { creatorId, title: `Item ${uid()}`, format: "IMAGE_POST" } });
}
