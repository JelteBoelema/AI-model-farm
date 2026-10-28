"use server";

import { z } from "zod";
import { isKnownTimeZone, zonedToUtc } from "@/lib/time";
import { defineAction } from "@/server/actions";
import { actingUserOf } from "@/server/auth/session";
import { bulkSchedule, cancelPublication, markPublishedManually, publishNow, reschedulePublication, retryPublication, schedulePublication } from "@/server/services/publishing";

const id = z.string().uuid();
const REVALIDATE = { revalidate: ["/calendar", "/content", "/social"] };

/** A wall-clock time from a datetime-local input, interpreted in the given zone. */
const local = z
  .object({ when: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Choose a date and time"), timeZone: z.string().refine(isKnownTimeZone, "Unknown time zone") })
  .transform(({ when, timeZone }) => {
    const [d, t] = when.split("T") as [string, string];
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    const [hh, mm] = t.split(":").map(Number) as [number, number];
    return zonedToUtc(y, m, day, hh, mm, timeZone);
  });

export const scheduleAction = defineAction(
  "publishing:schedule",
  z.object({ contentItemId: id, socialAccountId: id, at: local }),
  async (input, { user }) => {
    const job = await schedulePublication(actingUserOf(user), { contentItemId: input.contentItemId, socialAccountId: input.socialAccountId, scheduledFor: input.at });
    return { id: job.id, status: job.status };
  },
  REVALIDATE,
);

export const bulkScheduleAction = defineAction(
  "publishing:schedule",
  z.object({ socialAccountId: id, contentItemIds: z.array(id).min(1).max(50) }),
  async (input, { user }) => (await bulkSchedule(actingUserOf(user), input)).map((r) => ({ ...r, scheduledFor: r.scheduledFor?.toISOString() })),
  REVALIDATE,
);

export const rescheduleAction = defineAction("publishing:schedule", z.object({ jobId: id, at: local }), async (input, { user }) => reschedulePublication(actingUserOf(user), input.jobId, input.at), REVALIDATE);

export const cancelPublicationAction = defineAction("publishing:schedule", z.object({ jobId: id }), async (input, { user }) => cancelPublication(actingUserOf(user), input.jobId), REVALIDATE);

export const retryPublicationAction = defineAction("publishing:schedule", z.object({ jobId: id }), async (input, { user }) => retryPublication(actingUserOf(user), input.jobId), REVALIDATE);

export const markPublishedAction = defineAction("publishing:schedule", z.object({ jobId: id, url: z.string().max(500) }), async (input, { user }) => markPublishedManually(actingUserOf(user), input.jobId, input.url), REVALIDATE);

export const publishNowAction = defineAction(
  "publishing:schedule",
  z.object({ contentItemId: id, socialAccountId: id }),
  async (input, { user }) => {
    const job = await publishNow(actingUserOf(user), input);
    return { id: job.id, status: job.status };
  },
  REVALIDATE,
);
