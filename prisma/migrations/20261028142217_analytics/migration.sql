-- CreateEnum
CREATE TYPE "InsightKind" AS ENUM ('PATTERN', 'EXPERIMENT');

-- CreateEnum
CREATE TYPE "InsightStatus" AS ENUM ('OPEN', 'ACCEPTED', 'DISMISSED', 'COMPLETED');

-- AlterEnum
ALTER TYPE "DataOrigin" ADD VALUE 'MOCK';

-- AlterTable
ALTER TABLE "analytics_snapshots" ADD COLUMN     "age_hours" INTEGER,
ADD COLUMN     "collection_key" TEXT;
UPDATE "analytics_snapshots" SET "collection_key" = 'legacy:' || "id" WHERE "collection_key" IS NULL;
ALTER TABLE "analytics_snapshots" ALTER COLUMN "collection_key" SET NOT NULL;

-- AlterTable
ALTER TABLE "autonomy_policies" ADD COLUMN     "analytics_min_sample" INTEGER;

-- AlterTable
ALTER TABLE "content_items" ADD COLUMN     "pillar" TEXT;

-- CreateTable
CREATE TABLE "insights" (
    "id" UUID NOT NULL,
    "kind" "InsightKind" NOT NULL,
    "creator_id" UUID,
    "origin" "DataOrigin" NOT NULL,
    "dimension" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "finding" TEXT NOT NULL,
    "leader" TEXT,
    "baseline" TEXT,
    "lift_percent" DOUBLE PRECISION,
    "p_value" DOUBLE PRECISION,
    "sample_size" INTEGER NOT NULL,
    "groups" JSONB NOT NULL DEFAULT '[]',
    "min_sample" INTEGER,
    "meets_min_sample" BOOLEAN NOT NULL,
    "proposal" JSONB NOT NULL DEFAULT '{}',
    "status" "InsightStatus" NOT NULL DEFAULT 'OPEN',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" TEXT,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insights_creator_id_kind_status_idx" ON "insights"("creator_id", "kind", "status");

-- CreateIndex
CREATE INDEX "insights_fingerprint_status_idx" ON "insights"("fingerprint", "status");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_snapshots_collection_key_key" ON "analytics_snapshots"("collection_key");

-- AddForeignKey
ALTER TABLE "insights" ADD CONSTRAINT "insights_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Safe values for the human-set minimum sample.
ALTER TABLE "autonomy_policies" ADD CONSTRAINT "autonomy_policies_min_sample_sane" CHECK ("analytics_min_sample" IS NULL OR "analytics_min_sample" BETWEEN 5 AND 10000);

-- Metrics are counts.
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_metrics_nonnegative" CHECK (
  COALESCE("views", 0) >= 0 AND COALESCE("reach", 0) >= 0 AND COALESCE("likes", 0) >= 0 AND COALESCE("comments", 0) >= 0
  AND COALESCE("shares", 0) >= 0 AND COALESCE("saves", 0) >= 0 AND COALESCE("followers", 0) >= 0 AND COALESCE("watch_time_sec", 0) >= 0
  AND ("age_hours" IS NULL OR "age_hours" >= 0)
);

-- A mock account can never produce a measured snapshot.
CREATE FUNCTION analytics_snapshots_origin_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.origin::text = 'MEASURED' AND EXISTS (SELECT 1 FROM social_accounts a WHERE a.id = NEW.social_account_id AND a.is_mock) THEN
    RAISE EXCEPTION 'analytics_snapshots: a mock account cannot produce MEASURED data';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER analytics_snapshots_origin_guard BEFORE INSERT OR UPDATE ON "analytics_snapshots" FOR EACH ROW EXECUTE FUNCTION analytics_snapshots_origin_guard();

-- Predictions: a sample size is a count; at most one open (or accepted) insight per fingerprint.
ALTER TABLE "insights" ADD CONSTRAINT "insights_sample_nonnegative" CHECK ("sample_size" >= 0);
CREATE UNIQUE INDEX "insights_one_active_per_fingerprint" ON "insights"("fingerprint") WHERE "status" IN ('OPEN', 'ACCEPTED');
