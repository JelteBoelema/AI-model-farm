"use server";

import { z } from "zod";
import { defineAction } from "@/server/actions";
import { actorOf } from "@/server/auth/session";
import { setControlSwitch } from "@/server/controls";
import { changeRole, createUser, createUserSchema, setUserDisabled } from "@/server/services/users";

const controlScope = z.enum(["ALL_GENERATION", "ALL_PUBLISHING", "CREATOR", "CAMPAIGN", "PROVIDER"]);

const pauseSchema = z.object({
  scope: controlScope,
  targetId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(3, "Give a reason of at least 3 characters").max(500),
});

export const pauseAction = defineAction(
  "controls:pause",
  pauseSchema,
  async (input, { user }) => setControlSwitch(actorOf(user), { ...input, paused: true }),
  { revalidate: ["/", "/settings"] },
);

export const resumeAction = defineAction(
  "controls:resume",
  pauseSchema,
  async (input, { user }) => setControlSwitch(actorOf(user), { ...input, paused: false }),
  { revalidate: ["/", "/settings"] },
);

export const createUserAction = defineAction(
  "users:manage",
  createUserSchema,
  async (input, { user }) => {
    await createUser({ id: user.id, role: user.role, actor: actorOf(user) }, input);
  },
  { revalidate: ["/settings/users"] },
);

export const changeRoleAction = defineAction(
  "users:manage",
  z.object({ userId: z.string().uuid(), role: z.enum(["OWNER", "ADMIN", "OPERATOR", "VIEWER"]) }),
  async (input, { user }) => changeRole({ id: user.id, role: user.role, actor: actorOf(user) }, input.userId, input.role),
  { revalidate: ["/settings/users"] },
);

export const setDisabledAction = defineAction(
  "users:manage",
  z.object({ userId: z.string().uuid(), disabled: z.boolean() }),
  async (input, { user }) => setUserDisabled({ id: user.id, role: user.role, actor: actorOf(user) }, input.userId, input.disabled),
  { revalidate: ["/settings/users"] },
);
