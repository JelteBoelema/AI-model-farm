// Global dashboard filters live in the URL so views are shareable and server-rendered.

import { z } from "zod";

export const PERIODS = ["today", "7d", "30d", "90d", "mtd", "all"] as const;
export type Period = (typeof PERIODS)[number];
export const PLATFORMS = ["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const;

const uuid = z.string().uuid();

export const dashboardFilterSchema = z.object({
  creator: uuid.optional().catch(undefined),
  campaign: uuid.optional().catch(undefined),
  platform: z.enum(PLATFORMS).optional().catch(undefined),
  period: z.enum(PERIODS).default("30d").catch("30d"),
  status: z
    .string()
    .regex(/^[A-Z_]{2,32}$/)
    .optional()
    .catch(undefined),
});

export type DashboardFilters = z.infer<typeof dashboardFilterSchema>;

type RawParams = Record<string, string | string[] | undefined>;

export function parseFilters(params: RawParams): DashboardFilters {
  const flat = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v !== undefined && v !== ""),
  );
  return dashboardFilterSchema.parse(flat);
}

/** Inclusive start of the selected period in UTC; null for "all". */
export function periodStart(period: Period, now: Date = new Date()): Date | null {
  const day = 24 * 60 * 60 * 1000;
  switch (period) {
    case "today":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    case "7d":
      return new Date(now.getTime() - 7 * day);
    case "30d":
      return new Date(now.getTime() - 30 * day);
    case "90d":
      return new Date(now.getTime() - 90 * day);
    case "mtd":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    case "all":
      return null;
  }
}

export const PERIOD_LABELS: Record<Period, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  mtd: "Month to date",
  all: "All time",
};
