# Compute: one web service behind the load balancer and one worker service per role. Workers scale
# on queue backlog per task (metric published by the scheduler in CloudWatch EMF).

resource "aws_ecs_cluster" "main" {
  name = "${local.name}-${var.environment}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

locals {
  services = concat(["web"], [for role in keys(var.worker_scaling) : "worker-${role}"], ["migrate"])
  common_env = [
    { name = "APP_ENV", value = var.environment },
    { name = "MOCK_MODE", value = "false" },
    { name = "STORAGE_DRIVER", value = "s3" },
    { name = "S3_BUCKET", value = aws_s3_bucket.media.bucket },
    { name = "S3_REGION", value = var.region },
    { name = "SECRETS_DRIVER", value = "aws" },
    { name = "AUTH_URL", value = "https://${var.domain_name}" },
    { name = "LOG_LEVEL", value = "info" },
  ]
  sso_env = var.oidc == null ? [] : [
    { name = "OIDC_ISSUER", value = var.oidc.issuer },
    { name = "OIDC_CLIENT_ID", value = var.oidc.client_id },
    { name = "OIDC_DISPLAY_NAME", value = var.oidc.display_name },
    { name = "OIDC_IDP_ENFORCES_MFA", value = tostring(var.oidc.idp_enforces_mfa) },
  ]
  sso_secrets = var.oidc == null ? [] : [{ name = "OIDC_CLIENT_SECRET", valueFrom = aws_secretsmanager_secret.platform["oidc-client-secret"].arn }]
  common_secrets = [
    for name, key in { DATABASE_URL = "database-url", REDIS_URL = "redis-url", AUTH_SECRET = "auth-secret", APP_ENCRYPTION_KEY = "encryption-key" } :
    { name = name, valueFrom = aws_secretsmanager_secret.platform[key].arn }
  ]
  repository_credentials = var.registry_credentials_secret_arn == null ? {} : { repositoryCredentials = { credentialsParameter = var.registry_credentials_secret_arn } }
}

resource "aws_cloudwatch_log_group" "service" {
  #checkov:skip=CKV_AWS_338:Operational logs are kept 30 days (data minimisation); the audit trail lives in the database
  for_each          = toset(local.services)
  name              = "/${local.name}/${each.key}"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.main.arn
}

# ── IAM ──
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-${var.environment}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The execution role injects only the four platform secrets into containers.
resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [for s in concat(local.common_secrets, local.sso_secrets) : s.valueFrom] }],
      [{ Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.main.arn }],
      var.registry_credentials_secret_arn == null ? [] : [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.registry_credentials_secret_arn }],
    )
  })
}

resource "aws_iam_role" "web" {
  name               = "${local.name}-${var.environment}-web"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "worker" {
  name               = "${local.name}-${var.environment}-worker"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

locals {
  secret_arn_prefix = "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:${local.secret_prefix}"
  app_base_statements = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.media.arn}/*" },
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.media.arn },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = "${local.secret_arn_prefix}/*" },
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.main.arn },
    { Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
  ]
}

# Web: connects and disconnects social accounts, so it manages their token secrets.
resource "aws_iam_role_policy" "web" {
  role = aws_iam_role.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.app_base_statements, [{
      Effect   = "Allow"
      Action   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret", "secretsmanager:TagResource"]
      Resource = "${local.secret_arn_prefix}/social/*"
    }])
  })
}

# Workers: refresh tokens (update), never create or delete account links.
resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.app_base_statements, [{
      Effect   = "Allow"
      Action   = ["secretsmanager:PutSecretValue"]
      Resource = "${local.secret_arn_prefix}/social/*"
    }])
  })
}

# ── Task definitions ──
resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.web.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([merge({
    name         = "web"
    image        = "${var.image_repository}/web:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment  = concat(local.common_env, local.sso_env, [{ name = "OTEL_SERVICE_NAME", value = "creator-farm-web" }])
    secrets      = concat(local.common_secrets, local.sso_secrets)
    healthCheck  = { command = ["CMD-SHELL", "curl -fsS http://localhost:3000/api/health/live || exit 1"], interval = 30, timeout = 5, retries = 3, startPeriod = 30 }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.service["web"].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "web" }
    }
  }, local.repository_credentials)])
}

resource "aws_ecs_task_definition" "worker" {
  for_each                 = var.worker_scaling
  family                   = "${local.name}-worker-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([merge({
    name        = "worker"
    image       = "${var.image_repository}/worker:${var.image_tag}"
    essential   = true
    stopTimeout = 120 # lets active jobs finish on scale-in and deploys
    environment = concat(local.common_env, [
      { name = "WORKER_QUEUES", value = each.key },
      { name = "OTEL_SERVICE_NAME", value = "creator-farm-worker-${each.key}" },
    ])
    secrets     = local.common_secrets
    healthCheck = { command = ["CMD-SHELL", "curl -fsS http://localhost:9464/healthz || exit 1"], interval = 30, timeout = 5, retries = 3, startPeriod = 60 }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.service["worker-${each.key}"].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = each.key }
    }
  }, local.repository_credentials)])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker.arn
  container_definitions = jsonencode([merge({
    name        = "migrate"
    image       = "${var.image_repository}/migrate:${var.image_tag}"
    essential   = true
    environment = local.common_env
    secrets     = [for s in local.common_secrets : s if s.name == "DATABASE_URL"]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.service["migrate"].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "migrate" }
    }
  }, local.repository_credentials)])
}

# ── Services ──
resource "aws_ecs_service" "web" {
  name                              = "${local.name}-web"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.web.arn
  desired_count                     = var.web_desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.web.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  lifecycle {
    ignore_changes = [task_definition] # the release workflow rolls out new revisions
  }
}

resource "aws_ecs_service" "worker" {
  for_each        = var.worker_scaling
  name            = "${local.name}-worker-${each.key}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker[each.key].arn
  desired_count   = each.value.min
  launch_type     = "FARGATE"
  # The scheduler must never run twice at once during a deploy.
  deployment_maximum_percent         = each.key == "scheduler" ? 100 : 200
  deployment_minimum_healthy_percent = each.key == "scheduler" ? 0 : 100
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.worker.id]
  }
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

# ── Autoscaling on backlog per task ──
locals {
  scaled_roles = { for role, cfg in var.worker_scaling : role => cfg if cfg.max > cfg.min && length(cfg.queues) > 0 }
}

resource "aws_appautoscaling_target" "worker" {
  for_each           = local.scaled_roles
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value.min
  max_capacity       = each.value.max
}

resource "aws_appautoscaling_policy" "worker_backlog" {
  for_each           = local.scaled_roles
  name               = "${local.name}-${each.key}-backlog-per-task"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.worker[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.worker[each.key].scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value       = each.value.backlog_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    customized_metric_specification {
      dynamic "metrics" {
        for_each = each.value.queues
        content {
          id          = "q${metrics.key}"
          return_data = false
          metric_stat {
            stat = "Average"
            metric {
              namespace   = "CreatorFarm"
              metric_name = "QueueBacklog"
              dimensions {
                name  = "Queue"
                value = metrics.value
              }
            }
          }
        }
      }
      metrics {
        id          = "tasks"
        return_data = false
        metric_stat {
          stat = "Average"
          metric {
            namespace   = "ECS/ContainerInsights"
            metric_name = "RunningTaskCount"
            dimensions {
              name  = "ClusterName"
              value = aws_ecs_cluster.main.name
            }
            dimensions {
              name  = "ServiceName"
              value = aws_ecs_service.worker[each.key].name
            }
          }
        }
      }
      metrics {
        id          = "backlog_per_task"
        label       = "Backlog per task"
        expression  = "(${join(" + ", [for i, q in each.value.queues : "q${i}"])}) / MAX([tasks, 1])"
        return_data = true
      }
    }
  }
}
