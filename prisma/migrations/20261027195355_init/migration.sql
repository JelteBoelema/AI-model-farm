-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "CreatorStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AutonomyMode" AS ENUM ('MANUAL', 'ASSISTED', 'CONTROLLED_AUTONOMY');

-- CreateEnum
CREATE TYPE "CharacterProfileStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('INSTAGRAM', 'TIKTOK', 'YOUTUBE');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTED', 'TOKEN_EXPIRED', 'INSUFFICIENT_SCOPE', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "PromptKind" AS ENUM ('IDEATION', 'CREATOR_WIZARD', 'SCRIPT', 'IMAGE', 'VIDEO', 'VOICEOVER', 'CAPTION', 'QUALITY_RULES', 'SAFETY_RULES');

-- CreateEnum
CREATE TYPE "PromptScope" AS ENUM ('GLOBAL', 'CREATOR', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "PromptVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "ProviderCapability" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'SPEECH', 'LIPSYNC', 'MODERATION');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('NOT_CONFIGURED', 'ACTIVE', 'DEGRADED', 'DISABLED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentFormat" AS ENUM ('IMAGE_POST', 'CAROUSEL', 'SHORT_VIDEO', 'TALKING_HEAD', 'STORY');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('IDEA', 'BRIEFED', 'SCRIPTED', 'PROMPTED', 'GENERATING', 'QC_REVIEW', 'READY', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "GenerationKind" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'SPEECH', 'LIPSYNC', 'MODERATION', 'MEDIA_PROCESSING');

-- CreateEnum
CREATE TYPE "GenerationJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED_BUDGET', 'BLOCKED_POLICY', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'SUBTITLE');

-- CreateEnum
CREATE TYPE "MediaSource" AS ENUM ('GENERATED', 'UPLOADED', 'DERIVED');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ApprovalSubject" AS ENUM ('CONTENT_ITEM', 'MEDIA_ASSET', 'CHARACTER_PROFILE', 'PROMPT_VERSION', 'SOCIAL_ACCOUNT_LINK', 'BUDGET_INCREASE', 'SECURITY_CHANGE');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PublishingStatus" AS ENUM ('SCHEDULED', 'QUEUED', 'PUBLISHING', 'AWAITING_CONFIRMATION', 'PUBLISHED', 'FAILED', 'NEEDS_MANUAL_ACTION', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CostEntryType" AS ENUM ('CHARGE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CostBasis" AS ENUM ('MEASURED', 'PROVIDER_REPORTED', 'ESTIMATED');

-- CreateEnum
CREATE TYPE "CostCategory" AS ENUM ('TOKENS', 'IMAGE', 'VIDEO_SECONDS', 'AUDIO', 'STORAGE', 'EGRESS', 'HOSTING', 'OTHER');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "BudgetScope" AS ENUM ('GLOBAL', 'CREATOR', 'CAMPAIGN', 'PROVIDER');

-- CreateEnum
CREATE TYPE "BudgetPeriod" AS ENUM ('DAY', 'MONTH');

-- CreateEnum
CREATE TYPE "PolicyScope" AS ENUM ('GLOBAL', 'CREATOR', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "ControlScope" AS ENUM ('ALL_GENERATION', 'ALL_PUBLISHING', 'CREATOR', 'CAMPAIGN', 'PROVIDER');

-- CreateEnum
CREATE TYPE "DataOrigin" AS ENUM ('MEASURED', 'DEMO');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'AGENT');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "disabled_at" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creators" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "target_audience" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "target_regions" TEXT[],
    "personality" TEXT NOT NULL,
    "tone_of_voice" TEXT NOT NULL,
    "backstory" TEXT NOT NULL,
    "content_pillars" JSONB NOT NULL DEFAULT '[]',
    "content_formats" "ContentFormat"[],
    "prompt_settings" JSONB NOT NULL DEFAULT '{}',
    "publishing_schedule" JSONB NOT NULL DEFAULT '{}',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
    "autonomy_mode" "AutonomyMode" NOT NULL DEFAULT 'CONTROLLED_AUTONOMY',
    "status" "CreatorStatus" NOT NULL DEFAULT 'DRAFT',
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "creators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_profiles" (
    "id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "CharacterProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "appearance" JSONB NOT NULL DEFAULT '{}',
    "identity_prompt" TEXT NOT NULL,
    "negative_prompt" TEXT NOT NULL DEFAULT '',
    "consistency_strategy" JSONB NOT NULL DEFAULT '{}',
    "likeness_attestation" TEXT,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_references" (
    "id" UUID NOT NULL,
    "character_profile_id" UUID NOT NULL,
    "media_asset_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "is_canonical" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_accounts" (
    "id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_account_id" TEXT,
    "handle" TEXT NOT NULL,
    "account_type" TEXT,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "granted_scopes" TEXT[],
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "credential_ref" TEXT,
    "token_expires_at" TIMESTAMPTZ(3),
    "last_verified_at" TIMESTAMPTZ(3),
    "max_posts_per_day" INTEGER NOT NULL DEFAULT 3,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PromptKind" NOT NULL,
    "scope" "PromptScope" NOT NULL DEFAULT 'GLOBAL',
    "creator_id" UUID,
    "campaign_id" UUID,
    "description" TEXT NOT NULL DEFAULT '',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PromptVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "body" TEXT NOT NULL,
    "variables_schema" JSONB NOT NULL DEFAULT '{}',
    "default_params" JSONB NOT NULL DEFAULT '{}',
    "changelog" TEXT NOT NULL DEFAULT '',
    "created_by_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_providers" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "capabilities" "ProviderCapability"[],
    "status" "ProviderStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "credential_ref" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "pricing" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL DEFAULT '',
    "brief" TEXT NOT NULL DEFAULT '',
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_creators" (
    "campaign_id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,

    CONSTRAINT "campaign_creators_pkey" PRIMARY KEY ("campaign_id","creator_id")
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "campaign_id" UUID,
    "title" TEXT NOT NULL,
    "format" "ContentFormat" NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'IDEA',
    "idea" TEXT NOT NULL DEFAULT '',
    "brief" JSONB NOT NULL DEFAULT '{}',
    "script" JSONB NOT NULL DEFAULT '{}',
    "caption" TEXT NOT NULL DEFAULT '',
    "hashtags" TEXT[],
    "ai_disclosure" BOOLEAN NOT NULL DEFAULT true,
    "max_generations" INTEGER NOT NULL DEFAULT 6,
    "generation_count" INTEGER NOT NULL DEFAULT 0,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_scenes" (
    "id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT '',
    "duration_ms" INTEGER NOT NULL,
    "dialogue" TEXT NOT NULL DEFAULT '',
    "audio_notes" TEXT NOT NULL DEFAULT '',
    "reference_asset_id" UUID,
    "approved_asset_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "video_scenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "content_item_id" UUID,
    "scene_id" UUID,
    "provider_id" UUID NOT NULL,
    "prompt_version_id" UUID,
    "kind" "GenerationKind" NOT NULL,
    "status" "GenerationJobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotency_key" TEXT NOT NULL,
    "rendered_prompt" TEXT NOT NULL DEFAULT '',
    "params" JSONB NOT NULL DEFAULT '{}',
    "provider_job_id" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "estimated_cost_micros" BIGINT,
    "actual_cost_micros" BIGINT,
    "error" JSONB,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "creator_id" UUID,
    "content_item_id" UUID,
    "generation_job_id" UUID,
    "kind" "MediaKind" NOT NULL,
    "source" "MediaSource" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "provider_key" TEXT,
    "model_version" TEXT,
    "prompt_snapshot" TEXT,
    "params_snapshot" JSONB,
    "quality_score" DOUBLE PRECISION,
    "quality_report" JSONB,
    "rights_note" TEXT,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "subject_type" "ApprovalSubject" NOT NULL,
    "subject_id" UUID NOT NULL,
    "decision" "ApprovalDecision" NOT NULL DEFAULT 'PENDING',
    "requested_by" "ActorType" NOT NULL,
    "requested_by_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "decided_by_id" UUID,
    "reason" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishing_jobs" (
    "id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "scheduled_for" TIMESTAMPTZ(3) NOT NULL,
    "status" "PublishingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "idempotency_key" TEXT NOT NULL,
    "external_post_id" TEXT,
    "external_url" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "last_error" JSONB,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "publishing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_ledger" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entry_type" "CostEntryType" NOT NULL,
    "category" "CostCategory" NOT NULL,
    "basis" "CostBasis" NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "units" DECIMAL(20,6),
    "unit_type" TEXT,
    "uncertainty_note" TEXT,
    "provider_id" UUID,
    "creator_id" UUID,
    "campaign_id" UUID,
    "content_item_id" UUID,
    "generation_job_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "cost_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_reservations" (
    "id" UUID NOT NULL,
    "generation_job_id" UUID,
    "provider_id" UUID,
    "creator_id" UUID,
    "campaign_id" UUID,
    "content_item_id" UUID,
    "amount_micros" BIGINT NOT NULL,
    "basis" "CostBasis" NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'HELD',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "settled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_policies" (
    "id" UUID NOT NULL,
    "scope" "BudgetScope" NOT NULL,
    "target_id" UUID,
    "period" "BudgetPeriod" NOT NULL,
    "limit_micros" BIGINT NOT NULL,
    "warn_at_percent" INTEGER NOT NULL DEFAULT 80,
    "auto_pause" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autonomy_policies" (
    "id" UUID NOT NULL,
    "scope" "PolicyScope" NOT NULL,
    "target_id" UUID,
    "max_cost_per_job_micros" BIGINT,
    "max_generations_per_item" INTEGER,
    "max_concurrent_jobs" INTEGER,
    "max_posts_per_day" INTEGER,
    "max_workflow_minutes" INTEGER,
    "max_retries" INTEGER,
    "require_human_approval" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "autonomy_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_switches" (
    "id" UUID NOT NULL,
    "scope" "ControlScope" NOT NULL,
    "target_id" UUID,
    "paused" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "changed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "control_switches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_snapshots" (
    "id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "publishing_job_id" UUID,
    "content_item_id" UUID,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "origin" "DataOrigin" NOT NULL,
    "source" TEXT NOT NULL,
    "views" BIGINT,
    "reach" BIGINT,
    "likes" BIGINT,
    "comments" BIGINT,
    "shares" BIGINT,
    "saves" BIGINT,
    "followers" BIGINT,
    "watch_time_sec" BIGINT,
    "avg_view_percent" DOUBLE PRECISION,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "actor_label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "creators_slug_key" ON "creators"("slug");

-- CreateIndex
CREATE INDEX "creators_status_idx" ON "creators"("status");

-- CreateIndex
CREATE INDEX "character_profiles_creator_id_status_idx" ON "character_profiles"("creator_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "character_profiles_creator_id_version_key" ON "character_profiles"("creator_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "character_references_character_profile_id_media_asset_id_key" ON "character_references"("character_profile_id", "media_asset_id");

-- CreateIndex
CREATE INDEX "social_accounts_creator_id_idx" ON "social_accounts"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_platform_external_account_id_key" ON "social_accounts"("platform", "external_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_platform_handle_key" ON "social_accounts"("platform", "handle");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_key_key" ON "prompt_templates"("key");

-- CreateIndex
CREATE INDEX "prompt_templates_kind_scope_idx" ON "prompt_templates"("kind", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_template_id_version_key" ON "prompt_versions"("template_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ai_providers_key_key" ON "ai_providers"("key");

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE INDEX "campaign_creators_creator_id_idx" ON "campaign_creators"("creator_id");

-- CreateIndex
CREATE INDEX "content_items_creator_id_status_idx" ON "content_items"("creator_id", "status");

-- CreateIndex
CREATE INDEX "content_items_campaign_id_idx" ON "content_items"("campaign_id");

-- CreateIndex
CREATE INDEX "content_items_status_updated_at_idx" ON "content_items"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "video_scenes_content_item_id_position_key" ON "video_scenes"("content_item_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_idempotency_key_key" ON "generation_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "generation_jobs_status_updated_at_idx" ON "generation_jobs"("status", "updated_at");

-- CreateIndex
CREATE INDEX "generation_jobs_content_item_id_idx" ON "generation_jobs"("content_item_id");

-- CreateIndex
CREATE INDEX "generation_jobs_creator_id_created_at_idx" ON "generation_jobs"("creator_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_storage_key_key" ON "media_assets"("storage_key");

-- CreateIndex
CREATE INDEX "media_assets_creator_id_kind_status_idx" ON "media_assets"("creator_id", "kind", "status");

-- CreateIndex
CREATE INDEX "media_assets_content_item_id_idx" ON "media_assets"("content_item_id");

-- CreateIndex
CREATE INDEX "media_assets_checksum_sha256_idx" ON "media_assets"("checksum_sha256");

-- CreateIndex
CREATE INDEX "approvals_subject_type_subject_id_idx" ON "approvals"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "approvals_decision_created_at_idx" ON "approvals"("decision", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_jobs_idempotency_key_key" ON "publishing_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "publishing_jobs_status_scheduled_for_idx" ON "publishing_jobs"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "publishing_jobs_social_account_id_scheduled_for_idx" ON "publishing_jobs"("social_account_id", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "cost_ledger_idempotency_key_key" ON "cost_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "cost_ledger_occurred_at_idx" ON "cost_ledger"("occurred_at");

-- CreateIndex
CREATE INDEX "cost_ledger_creator_id_occurred_at_idx" ON "cost_ledger"("creator_id", "occurred_at");

-- CreateIndex
CREATE INDEX "cost_ledger_campaign_id_occurred_at_idx" ON "cost_ledger"("campaign_id", "occurred_at");

-- CreateIndex
CREATE INDEX "cost_ledger_provider_id_occurred_at_idx" ON "cost_ledger"("provider_id", "occurred_at");

-- CreateIndex
CREATE INDEX "budget_reservations_status_expires_at_idx" ON "budget_reservations"("status", "expires_at");

-- CreateIndex
CREATE INDEX "budget_reservations_creator_id_status_idx" ON "budget_reservations"("creator_id", "status");

-- CreateIndex
CREATE INDEX "budget_reservations_campaign_id_status_idx" ON "budget_reservations"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "analytics_snapshots_social_account_id_captured_at_idx" ON "analytics_snapshots"("social_account_id", "captured_at");

-- CreateIndex
CREATE INDEX "analytics_snapshots_content_item_id_captured_at_idx" ON "analytics_snapshots"("content_item_id", "captured_at");

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_occurred_at_idx" ON "audit_logs"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- AddForeignKey
ALTER TABLE "creators" ADD CONSTRAINT "creators_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_profiles" ADD CONSTRAINT "character_profiles_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_references" ADD CONSTRAINT "character_references_character_profile_id_fkey" FOREIGN KEY ("character_profile_id") REFERENCES "character_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_references" ADD CONSTRAINT "character_references_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "prompt_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_creators" ADD CONSTRAINT "campaign_creators_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_creators" ADD CONSTRAINT "campaign_creators_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_scenes" ADD CONSTRAINT "video_scenes_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "video_scenes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_generation_job_id_fkey" FOREIGN KEY ("generation_job_id") REFERENCES "generation_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_jobs" ADD CONSTRAINT "publishing_jobs_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_jobs" ADD CONSTRAINT "publishing_jobs_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_generation_job_id_fkey" FOREIGN KEY ("generation_job_id") REFERENCES "generation_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_generation_job_id_fkey" FOREIGN KEY ("generation_job_id") REFERENCES "generation_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_publishing_job_id_fkey" FOREIGN KEY ("publishing_job_id") REFERENCES "publishing_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────── Hand-written integrity rules ───────────────────────────────

-- Append-only tables: cost_ledger and audit_logs may never be updated or deleted.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cost_ledger_append_only
  BEFORE UPDATE OR DELETE ON "cost_ledger"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER cost_ledger_no_truncate
  BEFORE TRUNCATE ON "cost_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Duplicate-publication guard: at most one live publishing job per content item per social account.
CREATE UNIQUE INDEX "publishing_jobs_live_unique"
  ON "publishing_jobs" ("content_item_id", "social_account_id")
  WHERE "status" <> 'CANCELLED';

-- One external post id per platform.
CREATE UNIQUE INDEX "publishing_jobs_external_post_unique"
  ON "publishing_jobs" ("platform", "external_post_id")
  WHERE "external_post_id" IS NOT NULL;

-- One budget policy per scope/target/period (NULL target = GLOBAL).
CREATE UNIQUE INDEX "budget_policies_scope_unique"
  ON "budget_policies" ("scope", COALESCE("target_id", '00000000-0000-0000-0000-000000000000'::uuid), "period");
CREATE UNIQUE INDEX "autonomy_policies_scope_unique"
  ON "autonomy_policies" ("scope", COALESCE("target_id", '00000000-0000-0000-0000-000000000000'::uuid));
CREATE UNIQUE INDEX "control_switches_scope_unique"
  ON "control_switches" ("scope", COALESCE("target_id", '00000000-0000-0000-0000-000000000000'::uuid));

-- At most one approved character profile per creator.
CREATE UNIQUE INDEX "character_profiles_one_approved"
  ON "character_profiles" ("creator_id") WHERE "status" = 'APPROVED';

-- Domain constraints.
ALTER TABLE "budget_policies"
  ADD CONSTRAINT "budget_policies_limit_positive" CHECK ("limit_micros" >= 0),
  ADD CONSTRAINT "budget_policies_warn_range" CHECK ("warn_at_percent" BETWEEN 1 AND 100),
  ADD CONSTRAINT "budget_policies_target_matches_scope" CHECK (("scope" = 'GLOBAL') = ("target_id" IS NULL));
ALTER TABLE "autonomy_policies"
  ADD CONSTRAINT "autonomy_policies_target_matches_scope" CHECK (("scope" = 'GLOBAL') = ("target_id" IS NULL));
ALTER TABLE "control_switches"
  ADD CONSTRAINT "control_switches_target_matches_scope"
  CHECK (("scope" IN ('ALL_GENERATION', 'ALL_PUBLISHING')) = ("target_id" IS NULL));
ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "budget_reservations_amount_positive" CHECK ("amount_micros" > 0);
ALTER TABLE "cost_ledger"
  ADD CONSTRAINT "cost_ledger_charge_non_negative" CHECK ("entry_type" <> 'CHARGE' OR "amount_micros" >= 0),
  ADD CONSTRAINT "cost_ledger_estimate_explained" CHECK ("basis" <> 'ESTIMATED' OR "uncertainty_note" IS NOT NULL);
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_generation_count_range"
  CHECK ("generation_count" >= 0 AND "max_generations" > 0);
ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_attempts_range" CHECK ("attempt" >= 0 AND "max_attempts" BETWEEN 1 AND 10);
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_size_non_negative" CHECK ("size_bytes" >= 0),
  ADD CONSTRAINT "media_assets_checksum_format" CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "video_scenes"
  ADD CONSTRAINT "video_scenes_duration_positive" CHECK ("duration_ms" > 0);
ALTER TABLE "social_accounts"
  ADD CONSTRAINT "social_accounts_posts_per_day_range" CHECK ("max_posts_per_day" BETWEEN 0 AND 100);
