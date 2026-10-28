# GitHub Actions deploys through OIDC (no long-lived AWS keys). Only the release workflow's
# "production" environment of this repository can assume the role.

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "deploy" {
  name = "${local.name}-${var.environment}-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:${var.environment}"
        }
      }
    }]
  })
}

locals {
  ecs_arn = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}"
}

resource "aws_iam_role_policy" "deploy" {
  #checkov:skip=CKV_AWS_355:ecs:RegisterTaskDefinition and ecs:DescribeTaskDefinition do not support resource-level permissions
  #checkov:skip=CKV_AWS_290:Same two actions; every other action is limited to this cluster
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecs:RunTask"], Resource = "${local.ecs_arn}:task-definition/${local.name}-*" },
      { Effect = "Allow", Action = ["ecs:DescribeTasks"], Resource = "${local.ecs_arn}:task/${aws_ecs_cluster.main.name}/*" },
      { Effect = "Allow", Action = ["ecs:UpdateService", "ecs:DescribeServices"], Resource = "${local.ecs_arn}:service/${aws_ecs_cluster.main.name}/*" },
      { Effect = "Allow", Action = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"], Resource = "*" },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.execution.arn, aws_iam_role.web.arn, aws_iam_role.worker.arn] },
    ]
  })
}
