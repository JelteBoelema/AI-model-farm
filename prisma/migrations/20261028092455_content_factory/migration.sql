-- DropIndex
DROP INDEX "generation_jobs_content_item_id_idx";

-- AlterTable
ALTER TABLE "content_items" ADD COLUMN     "batch_id" UUID,
ADD COLUMN     "failed_step" TEXT,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "quality_report" JSONB,
ADD COLUMN     "quality_score" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "generation_jobs" ADD COLUMN     "cost_basis" "CostBasis",
ADD COLUMN     "output" JSONB,
ADD COLUMN     "step" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "shot_index" INTEGER;

-- CreateTable
CREATE TABLE "content_batches" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_batches_created_at_idx" ON "content_batches"("created_at");

-- CreateIndex
CREATE INDEX "content_items_batch_id_idx" ON "content_items"("batch_id");

-- CreateIndex
CREATE INDEX "generation_jobs_content_item_id_step_idx" ON "generation_jobs"("content_item_id", "step");

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "content_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one approved take per shot of a content item (the one that will be published).
CREATE UNIQUE INDEX "media_assets_one_approved_per_shot" ON "media_assets"("content_item_id", "shot_index")
  WHERE "status" = 'APPROVED' AND "content_item_id" IS NOT NULL AND "shot_index" IS NOT NULL;

-- A recorded job cost always says how it was determined.
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_cost_explained"
  CHECK ("actual_cost_micros" IS NULL OR "cost_basis" IS NOT NULL);
