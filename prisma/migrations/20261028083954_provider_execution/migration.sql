-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PromptTestStatus" ADD VALUE 'QUEUED';
ALTER TYPE "PromptTestStatus" ADD VALUE 'RUNNING';

-- AlterTable
ALTER TABLE "prompt_test_runs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "error_kind" TEXT,
ADD COLUMN     "finished_at" TIMESTAMPTZ(3),
ADD COLUMN     "model" TEXT,
ADD COLUMN     "output_media_id" UUID,
ADD COLUMN     "provider_id" UUID,
ADD COLUMN     "started_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "prompt_test_runs_status_created_at_idx" ON "prompt_test_runs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "prompt_test_runs" ADD CONSTRAINT "prompt_test_runs_output_media_id_fkey" FOREIGN KEY ("output_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ledger rows created by prompt tests point back to the run in metadata; costs of a run are unique per attempt.
ALTER TABLE "prompt_test_runs" ADD CONSTRAINT "prompt_test_runs_cost_explained"
  CHECK ("cost_micros" IS NULL OR "cost_basis" IS NOT NULL);
