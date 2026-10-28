# Alarms. Application alarms come from infra/alarms.json (the same file the alarm drill test
# uses); infrastructure alarms are defined here. Everything notifies one SNS topic.

resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  app_alarms = jsondecode(file("${path.module}/../alarms.json"))
  queues     = local.app_alarms.queues
  roles      = local.app_alarms.roles
  # One CloudWatch alarm per alarm × dimension value.
  app_alarm_instances = merge([
    for a in local.app_alarms.alarms : (
      try(a.perQueue, false) ? { for q in local.queues : "${a.name}-${q}" => merge(a, { dims = { Queue = q } }) } :
      try(a.perRole, false) ? { for r in local.roles : "${a.name}-${r}" => merge(a, { dims = { Role = r } }) } :
      { (a.name) = merge(a, { dims = {} }) }
    )
  ]...)
}

resource "aws_cloudwatch_metric_alarm" "app" {
  for_each            = local.app_alarm_instances
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = "${each.value.description} Runbook: ${each.value.runbook}"
  namespace           = local.app_alarms.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dims
  statistic           = each.value.statistic
  period              = local.app_alarms.periodSeconds
  evaluation_periods  = each.value.evaluationPeriods
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison
  treat_missing_data  = each.value.missingData
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-alb-5xx"
  alarm_description   = "More than 1% of requests answered with 5xx. Runbook: docs/runbooks/alarms.md#infrastructure-alarms-terraform"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1
  evaluation_periods  = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  metric_query {
    id          = "ratio"
    expression  = "100 * errors / MAX([requests, 1])"
    return_data = true
  }
  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.web.arn_suffix }
    }
  }
  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.web.arn_suffix }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  alarm_name          = "${local.name}-alb-latency-p95"
  alarm_description   = "p95 response time above 2 s for 10 minutes. Runbook: docs/runbooks/alarms.md#infrastructure-alarms-terraform"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  dimensions          = { LoadBalancer = aws_lb.web.arn_suffix }
  period              = 60
  evaluation_periods  = 10
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "healthy_hosts" {
  alarm_name          = "${local.name}-web-unhealthy"
  alarm_description   = "No healthy web task behind the load balancer. Runbook: docs/runbooks/alarms.md#infrastructure-alarms-terraform"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  dimensions          = { LoadBalancer = aws_lb.web.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

locals {
  rds_alarms = {
    "rds-cpu"          = { metric = "CPUUtilization", threshold = 80, comparison = "GreaterThanThreshold", stat = "Average" }
    "rds-free-storage" = { metric = "FreeStorageSpace", threshold = 10 * 1024 * 1024 * 1024, comparison = "LessThanThreshold", stat = "Minimum" }
    "rds-connections"  = { metric = "DatabaseConnections", threshold = 150, comparison = "GreaterThanThreshold", stat = "Maximum" }
  }
}

resource "aws_cloudwatch_metric_alarm" "rds" {
  for_each            = local.rds_alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = "Database under pressure. Runbook: docs/runbooks/alarms.md#infrastructure-alarms-terraform"
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  statistic           = each.value.stat
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  period              = 300
  evaluation_periods  = 3
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  alarm_name          = "${local.name}-redis-memory"
  alarm_description   = "Redis above 80% memory; with noeviction, writes fail when full. Runbook: docs/runbooks/alarms.md#infrastructure-alarms-terraform"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  statistic           = "Maximum"
  dimensions          = { ReplicationGroupId = aws_elasticache_replication_group.main.id }
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "waf_blocked" {
  alarm_name          = "${local.name}-waf-blocked-spike"
  alarm_description   = "WAF blocking more than 500 requests in 5 minutes. Runbook: docs/runbooks/alarms.md#infrastructure-alarms-terraform"
  namespace           = "AWS/WAFV2"
  metric_name         = "BlockedRequests"
  statistic           = "Sum"
  dimensions          = { WebACL = aws_wafv2_web_acl.web.name, Region = var.region, Rule = "ALL" }
  period              = 300
  evaluation_periods  = 1
  threshold           = 500
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
