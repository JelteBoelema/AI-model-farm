-- AlterEnum
ALTER TYPE "SocialAccountStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "publishing_jobs" ADD COLUMN     "caption" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "created_by_id" UUID,
ADD COLUMN     "media_asset_ids" TEXT[],
ADD COLUMN     "remote_state" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "social_accounts" ADD COLUMN     "connected_at" TIMESTAMPTZ(3),
ADD COLUMN     "connected_by_id" UUID,
ADD COLUMN     "is_mock" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "min_gap_minutes" INTEGER NOT NULL DEFAULT 60;

-- CreateTable
CREATE TABLE "mock_platform_posts" (
    "id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "external_post_id" TEXT NOT NULL,
    "container_ids" TEXT[],
    "caption" TEXT NOT NULL,
    "media_kinds" TEXT[],
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mock_platform_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mock_platform_posts_external_post_id_key" ON "mock_platform_posts"("external_post_id");

-- CreateIndex
CREATE INDEX "mock_platform_posts_social_account_id_published_at_idx" ON "mock_platform_posts"("social_account_id", "published_at");

-- AddForeignKey
ALTER TABLE "mock_platform_posts" ADD CONSTRAINT "mock_platform_posts_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_limits_positive" CHECK ("max_posts_per_day" BETWEEN 1 AND 50 AND "min_gap_minutes" BETWEEN 0 AND 1440);
