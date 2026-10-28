-- AlterTable
ALTER TABLE "generation_jobs" ALTER COLUMN "provider_id" DROP NOT NULL;

-- One approved take per shot *per media kind*: a scene has an approved clip and its voice-over.
DROP INDEX "media_assets_one_approved_per_shot";
CREATE UNIQUE INDEX "media_assets_one_approved_per_shot" ON "media_assets"("content_item_id", "shot_index", "kind")
  WHERE "status" = 'APPROVED' AND "content_item_id" IS NOT NULL AND "shot_index" IS NOT NULL;

-- Local steps (assembly) have no provider, but every provider-less job must be a local step.
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_provider_required"
  CHECK ("provider_id" IS NOT NULL OR "kind" = 'MEDIA_PROCESSING');
