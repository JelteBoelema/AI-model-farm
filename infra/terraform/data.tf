# Data stores: PostgreSQL (source of truth), Redis (queues), S3 (media), Secrets Manager.

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "main" {
  description             = "${local.name} ${var.environment} data at rest"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "AccountAdministration", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.region}.amazonaws.com" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
        Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:*" } }
      },
    ]
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}-${var.environment}"
  target_key_id = aws_kms_key.main.key_id
}

# ── PostgreSQL ──
resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-${var.environment}"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.name}-${var.environment}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name}-${var.environment}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "monitoring.rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "main" {
  #checkov:skip=CKV_AWS_157:Multi-AZ is on in production; staging runs single-AZ to save cost
  identifier                          = "${local.name}-${var.environment}"
  engine                              = "postgres"
  engine_version                      = "16"
  instance_class                      = var.db_instance_class
  allocated_storage                   = 50
  max_allocated_storage               = 500
  storage_type                        = "gp3"
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.main.arn
  db_name                             = "creatorfarm"
  username                            = "creatorfarm"
  manage_master_user_password         = true # RDS keeps the password in Secrets Manager; never in Terraform state
  multi_az                            = var.environment == "production"
  db_subnet_group_name                = aws_db_subnet_group.main.name
  vpc_security_group_ids              = [aws_security_group.data.id]
  parameter_group_name                = aws_db_parameter_group.main.name
  backup_retention_period             = 35
  backup_window                       = "01:00-02:00"
  maintenance_window                  = "sun:02:30-sun:03:30"
  copy_tags_to_snapshot               = true
  deletion_protection                 = true
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${local.name}-${var.environment}-final"
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = aws_kms_key.main.arn
  monitoring_interval                 = 60
  monitoring_role_arn                 = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]
  iam_database_authentication_enabled = true
  auto_minor_version_upgrade          = true
  publicly_accessible                 = false
}

# Point-in-time backups replicated to the second region.
resource "aws_kms_key" "dr" {
  provider            = aws.dr
  description         = "${local.name} ${var.environment} DR copies"
  enable_key_rotation = true
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "AccountAdministration", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" }]
  })
}

resource "aws_db_instance_automated_backups_replication" "dr" {
  provider               = aws.dr
  source_db_instance_arn = aws_db_instance.main.arn
  kms_key_id             = aws_kms_key.dr.arn
  retention_period       = 14
}

# ── Redis (queues; not a source of truth) ──
resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-${var.environment}"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_parameter_group" "main" {
  name   = "${local.name}-${var.environment}-redis7"
  family = "redis7"
  # BullMQ must never lose keys silently: writes fail instead (alarm on memory).
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "aws_elasticache_replication_group" "main" {
  #checkov:skip=CKV_AWS_31:TLS in transit and a security group limited to the tasks; an AUTH token would have to live in Terraform state (see docs/security-review.md)
  #checkov:skip=CKV2_AWS_50:Automatic failover is on in production; staging has a single node
  replication_group_id       = "${local.name}-${var.environment}"
  description                = "Creator Farm job queues"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = var.environment == "production" ? 2 : 1
  automatic_failover_enabled = var.environment == "production"
  multi_az_enabled           = var.environment == "production"
  parameter_group_name       = aws_elasticache_parameter_group.main.name
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.data.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.main.arn
  transit_encryption_enabled = true
  snapshot_retention_limit   = 3
  port                       = 6379
}

# ── S3 media ──
resource "aws_s3_bucket" "media" {
  #checkov:skip=CKV2_AWS_62:No consumers for object events; the database records every object
  bucket = "${local.name}-${var.environment}-media-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_logging" "media" {
  bucket        = aws_s3_bucket.media.id
  target_bucket = aws_s3_bucket.alb_logs.id
  target_prefix = "s3-access/media/"
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    id     = "noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.media.arn, "${aws_s3_bucket.media.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# Copy of all media in the second region.
resource "aws_s3_bucket" "media_dr" {
  #checkov:skip=CKV_AWS_18:Replica only; access to the source bucket is logged
  #checkov:skip=CKV2_AWS_62:Replica only; no consumers for object events
  #checkov:skip=CKV_AWS_144:This is the cross-region replica
  provider = aws.dr
  bucket   = "${local.name}-${var.environment}-media-dr-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media_dr" {
  provider = aws.dr
  bucket   = aws_s3_bucket.media_dr.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.dr.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media_dr" {
  provider = aws.dr
  bucket   = aws_s3_bucket.media_dr.id
  rule {
    id     = "noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
}

resource "aws_s3_bucket_versioning" "media_dr" {
  provider = aws.dr
  bucket   = aws_s3_bucket.media_dr.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "media_dr" {
  provider                = aws.dr
  bucket                  = aws_s3_bucket.media_dr.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_iam_role" "replication" {
  name = "${local.name}-${var.environment}-s3-replication"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "s3.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "replication" {
  role = aws_iam_role.replication.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource = aws_s3_bucket.media.arn },
      { Effect = "Allow", Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource = "${aws_s3_bucket.media.arn}/*" },
      { Effect = "Allow", Action = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"], Resource = "${aws_s3_bucket.media_dr.arn}/*" },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.main.arn },
      { Effect = "Allow", Action = ["kms:Encrypt"], Resource = aws_kms_key.dr.arn },
    ]
  })
}

resource "aws_s3_bucket_replication_configuration" "media" {
  depends_on = [aws_s3_bucket_versioning.media, aws_s3_bucket_versioning.media_dr]
  bucket     = aws_s3_bucket.media.id
  role       = aws_iam_role.replication.arn
  rule {
    id     = "dr"
    status = "Enabled"
    filter {}
    delete_marker_replication {
      status = "Disabled"
    }
    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }
    destination {
      bucket = aws_s3_bucket.media_dr.arn
      encryption_configuration {
        replica_kms_key_id = aws_kms_key.dr.arn
      }
    }
  }
}

# ── Secrets (values are set with the AWS CLI, never through Terraform) ──
locals {
  platform_secrets = ["auth-secret", "encryption-key", "database-url", "redis-url", "anthropic", "openai", "google-genai", "elevenlabs", "meta-app", "oidc-client-secret"]
}

resource "aws_secretsmanager_secret" "platform" {
  #checkov:skip=CKV2_AWS_57:Provider keys and app keys are rotated by hand (docs/runbooks/key-rotation.md); there is no rotation API for them
  for_each   = toset(local.platform_secrets)
  name       = "creatorfarm/${var.environment == "production" ? "prod" : var.environment}/${each.key}"
  kms_key_id = aws_kms_key.main.arn
  replica {
    region = var.dr_region
  }
}

locals {
  secret_prefix = "creatorfarm/${var.environment == "production" ? "prod" : var.environment}"
}
