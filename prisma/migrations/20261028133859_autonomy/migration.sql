-- AlterEnum
ALTER TYPE "ApprovalSubject" ADD VALUE 'POLICY_CHANGE';

-- AlterTable
ALTER TABLE "autonomy_policies" ADD COLUMN     "auto_approve_min_score" INTEGER,
ADD COLUMN     "max_new_items_per_day" INTEGER;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "dedupe_key" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_system" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");


ALTER TABLE "autonomy_policies" ADD CONSTRAINT "autonomy_policies_values_sane" CHECK (
  ("max_cost_per_job_micros" IS NULL OR "max_cost_per_job_micros" >= 0)
  AND ("max_generations_per_item" IS NULL OR "max_generations_per_item" BETWEEN 1 AND 100)
  AND ("max_concurrent_jobs" IS NULL OR "max_concurrent_jobs" BETWEEN 1 AND 500)
  AND ("max_posts_per_day" IS NULL OR "max_posts_per_day" BETWEEN 1 AND 50)
  AND ("max_workflow_minutes" IS NULL OR "max_workflow_minutes" BETWEEN 5 AND 10080)
  AND ("max_retries" IS NULL OR "max_retries" BETWEEN 0 AND 10)
  AND ("auto_approve_min_score" IS NULL OR "auto_approve_min_score" BETWEEN 0 AND 100)
  AND ("max_new_items_per_day" IS NULL OR "max_new_items_per_day" BETWEEN 0 AND 100)
);

-- A system identity can never be used to sign in.
ALTER TABLE "users" ADD CONSTRAINT "users_system_disabled" CHECK (NOT "is_system" OR "disabled_at" IS NOT NULL);
