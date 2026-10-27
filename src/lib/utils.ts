import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const ACRONYMS = new Set(["qc", "ai", "api", "ui"]);

export function humanize(value: string): string {
  const words = value.replace(/[_.-]+/g, " ").toLowerCase().split(" ");
  const text = words.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatDateTime(date: Date | string | null | undefined, timeZone = "UTC"): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(date));
}

export function formatNumber(value: number | bigint | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-GB").format(value);
}
