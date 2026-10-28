variable "environment" {
  description = "production or staging"
  type        = string
  validation {
    condition     = contains(["production", "staging"], var.environment)
    error_message = "environment must be production or staging"
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "dr_region" {
  description = "Region for snapshot copies and replicated secrets"
  type        = string
  default     = "eu-west-1"
}

variable "domain_name" {
  description = "Public host name of the dashboard, e.g. farm.example.com"
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for domain_name in the same region"
  type        = string
}

variable "alarm_email" {
  description = "Address that receives alarm notifications (confirm the SNS subscription mail)"
  type        = string
}

variable "image_repository" {
  description = "Image repository prefix, e.g. ghcr.io/jelteboelema/ai-model-farm"
  type        = string
}

variable "image_tag" {
  description = "Image tag to run (the release workflow deploys by commit SHA)"
  type        = string
  default     = "main"
}

variable "registry_credentials_secret_arn" {
  description = "Secrets Manager secret with GHCR credentials for private images (null for public images or ECR)"
  type        = string
  default     = null
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through GitHub OIDC"
  type        = string
  default     = "JelteBoelema/AI-model-farm"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "web_desired_count" {
  type    = number
  default = 2
}

variable "worker_scaling" {
  description = "Per worker role: task size and autoscaling range on queue backlog"
  type = map(object({
    cpu            = number
    memory         = number
    min            = number
    max            = number
    backlog_target = number
    queues         = list(string)
  }))
  default = {
    scheduler  = { cpu = 512, memory = 1024, min = 1, max = 1, backlog_target = 0, queues = [] }
    generation = { cpu = 1024, memory = 2048, min = 1, max = 4, backlog_target = 20, queues = ["generation-text", "generation-image", "generation-video"] }
    media      = { cpu = 2048, memory = 4096, min = 1, max = 3, backlog_target = 10, queues = ["media-processing"] }
    publishing = { cpu = 512, memory = 1024, min = 1, max = 2, backlog_target = 50, queues = ["publishing", "analytics"] }
  }
}

variable "waf_rate_limit_per_5min" {
  description = "Requests per client address per 5 minutes before the WAF blocks (all paths)"
  type        = number
  default     = 2000
}

variable "waf_login_rate_limit_per_5min" {
  description = "Sign-in requests per client address per 5 minutes"
  type        = number
  default     = 100
}

variable "oidc" {
  description = "Optional single sign-on (OpenID Connect). The client secret goes into creatorfarm/<env>/oidc-client-secret."
  type = object({
    issuer           = string
    client_id        = string
    display_name     = optional(string, "SSO")
    idp_enforces_mfa = optional(bool, false)
  })
  default = null
}
