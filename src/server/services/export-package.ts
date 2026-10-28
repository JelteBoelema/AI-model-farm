// Export package: everything needed to publish an approved item by hand in the platform's own app
// (the supported alternative when API publishing is not possible). Mock content is marked as such.

import type { ContentItem } from "@prisma/client";
import { FORMAT_SPECS } from "@/lib/content-pipeline";
import { db } from "../db";
import { DomainError } from "../errors";
import { zip, type ZipEntry } from "../media/zip";
import { storage } from "../storage";
import { captionFor } from "./publishing";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "text/vtt": "vtt" };

function checklist(item: ContentItem & { creator: { name: string } }, mock: boolean, files: string[], schedule: { at: Date; handle: string }[]) {
  const spec = FORMAT_SPECS[item.format];
  return [
    `# Publish by hand: ${item.title}`,
    "",
    mock ? "> **Mock content — do not publish.** These files were made by mock providers for testing." : "",
    `Creator: ${item.creator.name} · format: ${spec?.label ?? item.format}`,
    schedule.length ? `Planned: ${schedule.map((s) => `@${s.handle} at ${s.at.toISOString()} (UTC)`).join(", ")}` : "",
    "",
    "## Steps",
    `1. Open the official app of the platform and sign in to the creator's professional account.`,
    `2. Create a new ${spec?.kind === "video" ? "Reel / short video" : item.format === "CAROUSEL" ? "carousel post" : item.format === "STORY" ? "story" : "post"} and add ${files.length > 1 ? `the files in this order: ${files.join(", ")}` : `\`${files[0]}\``}.`,
    "3. Paste the text from `caption.txt` (it already contains the hashtags and the AI disclosure).",
    "4. Turn on the platform's **AI-generated content** label where the app offers it.",
    "5. Publish (or schedule in the app), then copy the link of the post.",
    "6. In Creator Farm, open the item and use **Mark as published** with that link, so analytics and the calendar stay correct.",
    "",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
}

export async function buildExportPackage(itemId: string): Promise<{ filename: string; bytes: Buffer }> {
  const item = await db.contentItem.findUnique({ where: { id: itemId }, include: { creator: { select: { name: true } } } });
  if (!item) throw new DomainError("Content item not found");
  if (!["APPROVED", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED"].includes(item.status)) throw new DomainError("Only approved content can be exported");
  const video = FORMAT_SPECS[item.format]?.kind === "video";
  const media = video
    ? await db.mediaAsset.findMany({ where: { contentItemId: itemId, status: "APPROVED", kind: "VIDEO", shotIndex: null }, orderBy: { createdAt: "desc" }, take: 1 })
    : await db.mediaAsset.findMany({ where: { contentItemId: itemId, status: "APPROVED", kind: "IMAGE", shotIndex: { not: null } }, orderBy: { shotIndex: "asc" } });
  if (media.length === 0) throw new DomainError("No approved media to export");
  const subtitles = video ? await db.mediaAsset.findFirst({ where: { contentItemId: itemId, kind: "SUBTITLE" }, orderBy: { createdAt: "desc" } }) : null;
  const jobs = await db.publishingJob.findMany({ where: { contentItemId: itemId, status: { notIn: ["CANCELLED", "PUBLISHED"] } }, include: { socialAccount: { select: { handle: true } } } });

  const entries: ZipEntry[] = [];
  const names: string[] = [];
  for (const [i, m] of media.entries()) {
    const name = `${String(i + 1).padStart(2, "0")}.${EXT[m.mimeType] ?? "bin"}`;
    names.push(name);
    entries.push({ name, data: await storage().get(m.storageKey) });
  }
  if (subtitles) entries.push({ name: "subtitles.vtt", data: await storage().get(subtitles.storageKey) });
  const mock = media.some((m) => m.isMock);
  entries.push({ name: "caption.txt", data: Buffer.from(`${captionFor(item)}\n`) });
  entries.push({ name: "checklist.md", data: Buffer.from(checklist(item, mock, names, jobs.map((j) => ({ at: j.scheduledFor, handle: j.socialAccount.handle })))) });
  entries.push({
    name: "metadata.json",
    data: Buffer.from(
      JSON.stringify(
        {
          contentItemId: item.id,
          title: item.title,
          format: item.format,
          aiDisclosure: item.aiDisclosure,
          mock,
          media: media.map((m, i) => ({ file: names[i], assetId: m.id, sha256: m.checksumSha256, provider: m.providerKey, model: m.modelVersion })),
          exportedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    ),
  });
  const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "content";
  return { filename: `${slug}${mock ? "-MOCK" : ""}.zip`, bytes: zip(entries) };
}
