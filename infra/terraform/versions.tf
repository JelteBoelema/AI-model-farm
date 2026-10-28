# Creator Farm on AWS (eu-central-1). One root module per environment via workspaces or separate
# state keys; see docs/deployment.md. No secrets are stored in Terraform state: secret *values* are
# set with the AWS CLI, Terraform only creates the empty secrets and grants read access.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70"
    }
  }
  # Remote state: configured at `terraform init -backend-config=...` (S3 bucket + DynamoDB lock).
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "creator-farm"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# Snapshot copies for disaster recovery go to a second region.
provider "aws" {
  alias  = "dr"
  region = var.dr_region
}
