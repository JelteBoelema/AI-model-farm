-- CreateEnum
CREATE TYPE "PromptTestStatus" AS ENUM ('RENDERED', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "prompt_test_runs" (
    "id" UUID NOT NULL,
    "prompt_version_id" UUID NOT NULL,
    "creator_id" UUID,
    "campaign_id" UUID,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "rendered_prompt" TEXT NOT NULL,
    "safety_rules" TEXT,
    "status" "PromptTestStatus" NOT NULL,
    "provider_key" TEXT,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "output" TEXT,
    "error" TEXT,
    "cost_micros" BIGINT,
    "cost_basis" "CostBasis",
    "duration_ms" INTEGER,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_prompt_pins" (
    "campaign_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "prompt_version_id" UUID NOT NULL,
    "pinned_by_id" UUID,
    "pinned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_prompt_pins_pkey" PRIMARY KEY ("campaign_id","template_id")
);

-- CreateIndex
CREATE INDEX "prompt_test_runs_prompt_version_id_created_at_idx" ON "prompt_test_runs"("prompt_version_id", "created_at");

-- AddForeignKey
ALTER TABLE "prompt_test_runs" ADD CONSTRAINT "prompt_test_runs_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_prompt_pins" ADD CONSTRAINT "campaign_prompt_pins_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_prompt_pins" ADD CONSTRAINT "campaign_prompt_pins_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "prompt_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_prompt_pins" ADD CONSTRAINT "campaign_prompt_pins_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written rules
-- A template has at most one draft version at a time.
CREATE UNIQUE INDEX "prompt_versions_one_draft" ON "prompt_versions" ("template_id") WHERE "status" = 'DRAFT';
-- Scope integrity: creator-scoped templates name a creator, campaign-scoped a campaign, global neither.
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_scope_target" CHECK (
  ("scope" = 'GLOBAL' AND "creator_id" IS NULL AND "campaign_id" IS NULL) OR
  ("scope" = 'CREATOR' AND "creator_id" IS NOT NULL AND "campaign_id" IS NULL) OR
  ("scope" = 'CAMPAIGN' AND "campaign_id" IS NOT NULL AND "creator_id" IS NULL)
);
-- Published versions are immutable: body, variables and parameters cannot change afterwards.
CREATE OR REPLACE FUNCTION prompt_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' AND (NEW."body" IS DISTINCT FROM OLD."body"
      OR NEW."variables_schema" IS DISTINCT FROM OLD."variables_schema"
      OR NEW."default_params" IS DISTINCT FROM OLD."default_params"
      OR NEW."version" IS DISTINCT FROM OLD."version"
      OR NEW."template_id" IS DISTINCT FROM OLD."template_id") THEN
    RAISE EXCEPTION 'prompt version % is % and immutable', OLD."id", OLD."status" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'DEPRECATED' AND NEW."status" <> 'DEPRECATED' THEN
    RAISE EXCEPTION 'deprecated prompt versions cannot be revived' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER prompt_versions_immutable BEFORE UPDATE ON "prompt_versions"
  FOR EACH ROW EXECUTE FUNCTION prompt_versions_immutable();
CREATE TRIGGER prompt_versions_no_delete BEFORE DELETE ON "prompt_versions"
  FOR EACH ROW WHEN (OLD."status" <> 'DRAFT') EXECUTE FUNCTION forbid_mutation();
