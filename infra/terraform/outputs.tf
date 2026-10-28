output "load_balancer_dns" {
  description = "Point the DNS record of domain_name here (CNAME or alias)"
  value       = aws_lb.web.dns_name
}

output "media_bucket" {
  value = aws_s3_bucket.media.bucket
}

output "database_endpoint" {
  value = aws_db_instance.main.address
}

output "database_master_secret_arn" {
  description = "RDS-managed master password; build creatorfarm/<env>/database-url from it"
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "deploy_role_arn" {
  description = "GitHub variable AWS_DEPLOY_ROLE_ARN"
  value       = aws_iam_role.deploy.arn
}

output "ecs_network_config" {
  description = "GitHub variable ECS_NETWORK_CONFIG for the migration task"
  value       = "awsvpcConfiguration={subnets=[${join(",", aws_subnet.private[*].id)}],securityGroups=[${aws_security_group.worker.id}],assignPublicIp=DISABLED}"
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
