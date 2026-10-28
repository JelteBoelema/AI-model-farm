"use server";

import { z } from "zod";
import { defineAction } from "@/server/actions";
import { recordAudit } from "@/server/audit";
import { actingUserOf, actorOf } from "@/server/auth/session";
import { setControlSwitch } from "@/server/controls";
import { resetMfa } from "@/server/auth/mfa";
import { runAutopilot } from "@/server/services/autopilot";
import { budgetChangeSchema, changeBudget, changePolicy, decideApproval, policyChangeSchema } from "@/server/services/policy-admin";
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

const LIMIT_PAGES = ["/settings", "/settings/autonomy", "/settings/approvals", "/"];

/** Tightening applies at once (admin); loosening is applied by the owner or filed as a request. */
export const changePolicyAction = defineAction("autonomy:raise", policyChangeSchema, async (input, { user }) => changePolicy(actingUserOf(user), input), { revalidate: LIMIT_PAGES });

export const changeBudgetAction = defineAction("budgets:lower", budgetChangeSchema, async (input, { user }) => changeBudget(actingUserOf(user), input), { revalidate: LIMIT_PAGES });

export const decideApprovalAction = defineAction(
  "policies:manage",
  z.object({ approvalId: z.string().uuid(), approve: z.boolean(), reason: z.string().trim().max(500).default("") }),
  async (input, { user }) => decideApproval(actingUserOf(user), input.approvalId, input.approve, input.reason),
  { revalidate: [...LIMIT_PAGES, "/social"] },
);

/** Runs one planning round now; the autopilot stays inside the same limits as on its schedule. */
export const runAutopilotAction = defineAction(
  "generation:run",
  z.object({}),
  async (_input, { user }) => {
    await recordAudit(actorOf(user), { action: "autopilot.run_requested" });
    const run = await runAutopilot();
    return { paused: run.paused, created: run.creators.reduce((s, c) => s + c.created, 0), approved: run.creators.reduce((s, c) => s + c.approved, 0), scheduled: run.creators.reduce((s, c) => s + c.scheduled, 0) };
  },
  { revalidate: ["/settings/autonomy", "/content", "/calendar", "/"] },
);

export const resetMfaAction = defineAction(
  "users:manage",
  z.object({ userId: z.string().uuid(), reason: z.string().trim().max(500) }),
  async (input, { user }) => resetMfa(actingUserOf(user), input.userId, input.reason),
  { revalidate: ["/settings/users"] },
);
