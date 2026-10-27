// Uniform wrapper for server actions: authenticate, authorize, validate, and translate errors
// into safe messages. Unexpected errors are logged with an id and never leak internals.

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import type { Permission } from "@/lib/rbac";
import { InvalidTransitionError } from "@/lib/state-machines";
import { logger } from "./logger";
import { ForbiddenError, requestMeta, requirePermission, type CurrentUser } from "./auth/session";
import { UserServiceError } from "./services/users";

export type ActionResult<T = undefined> = { ok: true; data?: T; message?: string } | { ok: false; error: string };

const EXPECTED_ERRORS = [UserServiceError, InvalidTransitionError];

export function defineAction<S extends z.ZodType, T>(
  permission: Permission,
  schema: S,
  handler: (input: z.infer<S>, ctx: { user: CurrentUser; meta: Awaited<ReturnType<typeof requestMeta>> }) => Promise<T>,
  options: { revalidate?: string[] } = {},
) {
  return async (raw: unknown): Promise<ActionResult<T>> => {
    try {
      const user = await requirePermission(permission);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
      const data = await handler(parsed.data, { user, meta: await requestMeta() });
      options.revalidate?.forEach((p) => revalidatePath(p));
      return { ok: true, data };
    } catch (err) {
      if (err instanceof ForbiddenError) return { ok: false, error: "You do not have permission for this action." };
      if (EXPECTED_ERRORS.some((E) => err instanceof E)) return { ok: false, error: (err as Error).message };
      // redirect()/notFound() from next/navigation must propagate
      if (err && typeof err === "object" && "digest" in err) throw err;
      const errorId = randomUUID();
      logger.error({ errorId, err: (err as Error).message, stack: (err as Error).stack }, "server action failed");
      return { ok: false, error: `Something went wrong (reference ${errorId.slice(0, 8)}).` };
    }
  };
}
