-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfa_enabled_at" TIMESTAMPTZ(3),
ADD COLUMN     "mfa_last_step" INTEGER,
ADD COLUMN     "mfa_recovery_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mfa_secret" TEXT;


-- An enabled second factor always has its secret; a secret without enablement is never stored.
ALTER TABLE "users" ADD CONSTRAINT "users_mfa_consistent" CHECK (("mfa_enabled_at" IS NULL) = ("mfa_secret" IS NULL));
