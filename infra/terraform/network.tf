data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "creator-farm"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = "${local.name}-${var.environment}" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.name}-private-${count.index}" }
}

# Nothing may use the VPC's default security group.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_eip" "nat" {
  count  = 2
  domain = "vpc"
}

# One NAT gateway per AZ: outgoing provider and platform calls survive an AZ outage.
resource "aws_nat_gateway" "main" {
  count         = 2
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = 2
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# S3 traffic stays inside the VPC.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id
}

resource "aws_flow_log" "main" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = "REJECT"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow.arn
  iam_role_arn         = aws_iam_role.flow_logs.arn
}

resource "aws_cloudwatch_log_group" "flow" {
  #checkov:skip=CKV_AWS_338:Operational logs are kept 30 days (data minimisation); the audit trail lives in the database
  name              = "/${local.name}/vpc-flow"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.main.arn
}

resource "aws_iam_role" "flow_logs" {
  name = "${local.name}-${var.environment}-flow-logs"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "vpc-flow-logs.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  role = aws_iam_role.flow_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.flow.arn}:*"
    }]
  })
}

# Security groups: only the load balancer is reachable from the internet.
resource "aws_security_group" "alb" {
  #checkov:skip=CKV_AWS_260:Port 80 only answers with a redirect to HTTPS
  name        = "${local.name}-${var.environment}-alb"
  description = "Public load balancer: HTTPS in, web tasks out"
  vpc_id      = aws_vpc.main.id
  ingress {
    description = "HTTPS from the internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTP, redirected to HTTPS"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description     = "To the web tasks"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.web.id]
  }
}

# Tasks may reach the data stores, DNS in the VPC, and HTTPS (AWS APIs, AI providers, platforms).
locals {
  task_egress = [
    { description = "HTTPS to AWS APIs, AI providers and social platforms", port = 443, protocol = "tcp", cidr = "0.0.0.0/0" },
    { description = "DNS (VPC resolver)", port = 53, protocol = "udp", cidr = "10.40.0.0/16" },
    { description = "DNS over TCP (VPC resolver)", port = 53, protocol = "tcp", cidr = "10.40.0.0/16" },
    { description = "PostgreSQL", port = 5432, protocol = "tcp", cidr = "10.40.0.0/16" },
    { description = "Redis", port = 6379, protocol = "tcp", cidr = "10.40.0.0/16" },
  ]
}

resource "aws_security_group" "web" {
  name        = "${local.name}-${var.environment}-web"
  description = "Web tasks"
  vpc_id      = aws_vpc.main.id
  dynamic "egress" {
    for_each = local.task_egress
    content {
      description = egress.value.description
      from_port   = egress.value.port
      to_port     = egress.value.port
      protocol    = egress.value.protocol
      cidr_blocks = [egress.value.cidr]
    }
  }
}

resource "aws_security_group_rule" "web_from_alb" {
  type                     = "ingress"
  description              = "From the load balancer"
  security_group_id        = aws_security_group.web.id
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb.id
}

resource "aws_security_group" "worker" {
  name        = "${local.name}-${var.environment}-worker"
  description = "Worker tasks (no inbound traffic)"
  vpc_id      = aws_vpc.main.id
  dynamic "egress" {
    for_each = local.task_egress
    content {
      description = egress.value.description
      from_port   = egress.value.port
      to_port     = egress.value.port
      protocol    = egress.value.protocol
      cidr_blocks = [egress.value.cidr]
    }
  }
}

resource "aws_security_group" "data" {
  name        = "${local.name}-${var.environment}-data"
  description = "PostgreSQL and Redis, reachable from tasks only"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "PostgreSQL from tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.web.id, aws_security_group.worker.id]
  }
  ingress {
    description     = "Redis from tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.web.id, aws_security_group.worker.id]
  }
}
