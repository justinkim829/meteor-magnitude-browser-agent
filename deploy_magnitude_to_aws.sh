#!/bin/bash

# AWS Magnitude MCP Server Deployment Script
# This script deploys the Magnitude MCP server to AWS Fargate

set -e  # Exit on error

# Configuration
AWS_ACCOUNT_ID="207567797907"
AWS_REGION="us-west-2"
ECR_REPO_NAME="magnitude-mcp-server"
ECS_CLUSTER_NAME="magnitude-mcp-cluster"
ECS_SERVICE_NAME="magnitude-mcp-service"
TASK_FAMILY="magnitude-mcp"

# API Keys - These should be provided as environment variables
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}"
MCP_API_KEY="${MCP_API_KEY:-$(openssl rand -hex 32)}"
BROWSER_API_KEY="${BROWSER_API_KEY:-$(openssl rand -hex 32)}"

echo "🚀 Starting AWS deployment for Magnitude MCP Server..."

# Validate required API keys
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "❌ Error: ANTHROPIC_API_KEY environment variable is required"
  exit 1
fi

echo "📝 Using API Keys:"
echo "   MCP_API_KEY: ${MCP_API_KEY:0:8}..."
echo "   BROWSER_API_KEY: ${BROWSER_API_KEY:0:8}..."

# Step 1: Create ECR repository
echo "📦 Creating ECR repository..."
aws ecr describe-repositories --repository-names $ECR_REPO_NAME --region $AWS_REGION 2>/dev/null || \
aws ecr create-repository --repository-name $ECR_REPO_NAME --region $AWS_REGION

# Step 2: Get ECR login token and login to Docker
echo "🔐 Logging into ECR..."
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Step 3: Build Docker image for AMD64
echo "🔨 Building Docker image for AMD64 platform..."
docker buildx build --platform linux/amd64 -f Dockerfile.simple -t $ECR_REPO_NAME --load .

# Step 4: Tag image for ECR
echo "🏷️  Tagging Docker image..."
docker tag $ECR_REPO_NAME:latest $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:latest

# Step 5: Push image to ECR
echo "⬆️  Pushing image to ECR..."
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:latest

# Step 6: Store API keys in Parameter Store
echo "🔑 Storing API keys in Parameter Store..."

# Store Anthropic API key
aws ssm put-parameter \
  --name "/meteor/magnitude/anthropic-api-key" \
  --value "$ANTHROPIC_API_KEY" \
  --type "SecureString" \
  --description "Anthropic API key for magnitude MCP server" \
  --region $AWS_REGION \
  --overwrite 2>/dev/null || \
aws ssm put-parameter \
  --name "/meteor/magnitude/anthropic-api-key" \
  --value "$ANTHROPIC_API_KEY" \
  --type "SecureString" \
  --description "Anthropic API key for magnitude MCP server" \
  --region $AWS_REGION

# Store MCP API key
aws ssm put-parameter \
  --name "/meteor/magnitude/mcp-api-key" \
  --value "$MCP_API_KEY" \
  --type "SecureString" \
  --description "MCP API key for magnitude MCP server authentication" \
  --region $AWS_REGION \
  --overwrite 2>/dev/null || \
aws ssm put-parameter \
  --name "/meteor/magnitude/mcp-api-key" \
  --value "$MCP_API_KEY" \
  --type "SecureString" \
  --description "MCP API key for magnitude MCP server authentication" \
  --region $AWS_REGION

# Store Browser API key
aws ssm put-parameter \
  --name "/meteor/magnitude/browser-api-key" \
  --value "$BROWSER_API_KEY" \
  --type "SecureString" \
  --description "Browser API key for magnitude MCP server authentication" \
  --region $AWS_REGION \
  --overwrite 2>/dev/null || \
aws ssm put-parameter \
  --name "/meteor/magnitude/browser-api-key" \
  --value "$BROWSER_API_KEY" \
  --type "SecureString" \
  --description "Browser API key for magnitude MCP server authentication" \
  --region $AWS_REGION

# Step 7: Create CloudWatch log group
echo "📊 Creating CloudWatch log group..."
aws logs describe-log-groups --log-group-name-prefix /ecs/magnitude-mcp --region $AWS_REGION 2>/dev/null || \
aws logs create-log-group --log-group-name /ecs/magnitude-mcp --region $AWS_REGION

# Step 8: Create or update IAM roles
echo "👤 Setting up IAM roles..."

# Create ECS task execution role if it doesn't exist
EXECUTION_ROLE_ARN=$(aws iam get-role --role-name ecsTaskExecutionRole --query 'Role.Arn' --output text 2>/dev/null || echo "")
if [ -z "$EXECUTION_ROLE_ARN" ]; then
  echo "Creating ECS task execution role..."
  aws iam create-role --role-name ecsTaskExecutionRole \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "ecs-tasks.amazonaws.com"},
        "Action": "sts:AssumeRole"
      }]
    }'
  
  aws iam attach-role-policy --role-name ecsTaskExecutionRole \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
  
  EXECUTION_ROLE_ARN="arn:aws:iam::$AWS_ACCOUNT_ID:role/ecsTaskExecutionRole"
fi

# Add parameter store read permission for Magnitude parameters
aws iam put-role-policy --role-name ecsTaskExecutionRole \
  --policy-name magnitude-parameter-store-read \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
      "Resource": [
        "arn:aws:ssm:'$AWS_REGION':'$AWS_ACCOUNT_ID':parameter/meteor/magnitude/anthropic-api-key",
        "arn:aws:ssm:'$AWS_REGION':'$AWS_ACCOUNT_ID':parameter/meteor/magnitude/mcp-api-key",
        "arn:aws:ssm:'$AWS_REGION':'$AWS_ACCOUNT_ID':parameter/meteor/magnitude/browser-api-key"
      ]
    }]
  }'

# Create task role
TASK_ROLE_ARN=$(aws iam get-role --role-name magnitude-mcp-task-role --query 'Role.Arn' --output text 2>/dev/null || echo "")
if [ -z "$TASK_ROLE_ARN" ]; then
  echo "Creating task role..."
  aws iam create-role --role-name magnitude-mcp-task-role \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "ecs-tasks.amazonaws.com"},
        "Action": "sts:AssumeRole"
      }]
    }'
  
  TASK_ROLE_ARN="arn:aws:iam::$AWS_ACCOUNT_ID:role/magnitude-mcp-task-role"
fi

# Step 9: Create ECS task definition
echo "📝 Creating ECS task definition..."
cat > task-definition.json << EOF
{
  "family": "$TASK_FAMILY",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "$EXECUTION_ROLE_ARN",
  "taskRoleArn": "$TASK_ROLE_ARN",
  "containerDefinitions": [{
    "name": "$ECR_REPO_NAME",
    "image": "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:latest",
    "portMappings": [{
      "containerPort": 9123,
      "protocol": "tcp"
    }],
    "essential": true,
    "environment": [
      {"name": "AWS_DEFAULT_REGION", "value": "$AWS_REGION"},
      {"name": "MAGNITUDE_MCP_PORT", "value": "9123"},
      {"name": "USE_SECURE_CDP", "value": "true"},
      {"name": "NODE_ENV", "value": "production"}
    ],
    "secrets": [
      {
        "name": "ANTHROPIC_API_KEY",
        "valueFrom": "arn:aws:ssm:$AWS_REGION:$AWS_ACCOUNT_ID:parameter/meteor/magnitude/anthropic-api-key"
      },
      {
        "name": "MCP_API_KEY",
        "valueFrom": "arn:aws:ssm:$AWS_REGION:$AWS_ACCOUNT_ID:parameter/meteor/magnitude/mcp-api-key"
      },
      {
        "name": "BROWSER_API_KEY",
        "valueFrom": "arn:aws:ssm:$AWS_REGION:$AWS_ACCOUNT_ID:parameter/meteor/magnitude/browser-api-key"
      }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/magnitude-mcp",
        "awslogs-region": "$AWS_REGION",
        "awslogs-stream-prefix": "ecs"
      }
    },
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -f http://localhost:9123/health || exit 1"],
      "interval": 30,
      "timeout": 10,
      "retries": 3,
      "startPeriod": 60
    }
  }]
}
EOF

aws ecs register-task-definition --cli-input-json file://task-definition.json --region $AWS_REGION

# Step 10: Get VPC and subnet information
echo "🌐 Getting VPC and subnet information..."
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text --region $AWS_REGION)
SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query "Subnets[*].SubnetId" --output text --region $AWS_REGION)
SUBNET_1=$(echo $SUBNETS | cut -d' ' -f1)
SUBNET_2=$(echo $SUBNETS | cut -d' ' -f2)

# Step 11: Create security groups
echo "🔒 Creating security groups..."

# ALB security group
ALB_SG_ID=$(aws ec2 describe-security-groups --group-names magnitude-mcp-alb-sg --query "SecurityGroups[0].GroupId" --output text --region $AWS_REGION 2>/dev/null || echo "")
if [ -z "$ALB_SG_ID" ]; then
  ALB_SG_ID=$(aws ec2 create-security-group \
    --group-name magnitude-mcp-alb-sg \
    --description "Security group for Magnitude MCP ALB" \
    --vpc-id $VPC_ID \
    --query 'GroupId' \
    --output text \
    --region $AWS_REGION)
  
  aws ec2 authorize-security-group-ingress \
    --group-id $ALB_SG_ID \
    --protocol tcp --port 443 --cidr 0.0.0.0/0 \
    --region $AWS_REGION
  
  aws ec2 authorize-security-group-ingress \
    --group-id $ALB_SG_ID \
    --protocol tcp --port 80 --cidr 0.0.0.0/0 \
    --region $AWS_REGION
fi

# ECS security group
ECS_SG_ID=$(aws ec2 describe-security-groups --group-names magnitude-mcp-ecs-sg --query "SecurityGroups[0].GroupId" --output text --region $AWS_REGION 2>/dev/null || echo "")
if [ -z "$ECS_SG_ID" ]; then
  ECS_SG_ID=$(aws ec2 create-security-group \
    --group-name magnitude-mcp-ecs-sg \
    --description "Security group for Magnitude MCP ECS tasks" \
    --vpc-id $VPC_ID \
    --query 'GroupId' \
    --output text \
    --region $AWS_REGION)
  
  aws ec2 authorize-security-group-ingress \
    --group-id $ECS_SG_ID \
    --protocol tcp --port 9123 \
    --source-group $ALB_SG_ID \
    --region $AWS_REGION
fi

# Step 12: Create Application Load Balancer
echo "⚖️  Creating Application Load Balancer..."
ALB_ARN=$(aws elbv2 describe-load-balancers --names magnitude-mcp-alb --query "LoadBalancers[0].LoadBalancerArn" --output text --region $AWS_REGION 2>/dev/null || echo "")
if [ -z "$ALB_ARN" ]; then
  ALB_ARN=$(aws elbv2 create-load-balancer \
    --name magnitude-mcp-alb \
    --subnets $SUBNET_1 $SUBNET_2 \
    --security-groups $ALB_SG_ID \
    --query 'LoadBalancers[0].LoadBalancerArn' \
    --output text \
    --region $AWS_REGION)
fi

ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN --query "LoadBalancers[0].DNSName" --output text --region $AWS_REGION)

# Step 13: Create target group
echo "🎯 Creating target group..."
TG_ARN=$(aws elbv2 describe-target-groups --names magnitude-mcp-tg --query "TargetGroups[0].TargetGroupArn" --output text --region $AWS_REGION 2>/dev/null || echo "")
if [ -z "$TG_ARN" ]; then
  TG_ARN=$(aws elbv2 create-target-group \
    --name magnitude-mcp-tg \
    --protocol HTTP --port 9123 \
    --vpc-id $VPC_ID \
    --target-type ip \
    --health-check-path /health \
    --health-check-interval-seconds 30 \
    --health-check-timeout-seconds 10 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3 \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text \
    --region $AWS_REGION)
fi

# Step 14: Create ALB listener
echo "👂 Creating ALB listener..."
aws elbv2 describe-listeners --load-balancer-arn $ALB_ARN --query "Listeners[?Port==\`80\`]" --region $AWS_REGION | grep -q "ListenerArn" || \
aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN \
  --region $AWS_REGION

# Step 15: Create ECS cluster
echo "🎪 Creating ECS cluster..."
aws ecs describe-clusters --clusters $ECS_CLUSTER_NAME --region $AWS_REGION 2>/dev/null | grep -q "ACTIVE" || \
aws ecs create-cluster --cluster-name $ECS_CLUSTER_NAME --region $AWS_REGION

# Step 16: Create or update ECS service
echo "🚀 Creating/updating ECS service..."
SERVICE_EXISTS=$(aws ecs describe-services --cluster $ECS_CLUSTER_NAME --services $ECS_SERVICE_NAME --query "services[0].status" --output text --region $AWS_REGION 2>/dev/null || echo "")

if [ "$SERVICE_EXISTS" == "ACTIVE" ] || [ "$SERVICE_EXISTS" == "DRAINING" ]; then
  echo "Updating existing service..."
  aws ecs update-service \
    --cluster $ECS_CLUSTER_NAME \
    --service $ECS_SERVICE_NAME \
    --task-definition $TASK_FAMILY \
    --desired-count 2 \
    --region $AWS_REGION
else
  echo "Creating new service..."
  aws ecs create-service \
    --cluster $ECS_CLUSTER_NAME \
    --service-name $ECS_SERVICE_NAME \
    --task-definition $TASK_FAMILY \
    --desired-count 2 \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_1,$SUBNET_2],securityGroups=[$ECS_SG_ID],assignPublicIp=ENABLED}" \
    --load-balancers targetGroupArn=$TG_ARN,containerName=$ECR_REPO_NAME,containerPort=9123 \
    --region $AWS_REGION
fi

# Step 17: Configure auto-scaling
echo "📈 Configuring auto-scaling..."
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/$ECS_CLUSTER_NAME/$ECS_SERVICE_NAME \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 1 --max-capacity 10 \
  --region $AWS_REGION 2>/dev/null || true

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/$ECS_CLUSTER_NAME/$ECS_SERVICE_NAME \
  --policy-name cpu-scaling \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 70.0,
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
    }
  }' \
  --region $AWS_REGION 2>/dev/null || true

# Step 18: Wait for service to stabilize
echo "⏳ Waiting for service to stabilize..."
aws ecs wait services-stable --cluster $ECS_CLUSTER_NAME --services $ECS_SERVICE_NAME --region $AWS_REGION

# Step 19: Output deployment information
echo "✅ Deployment complete!"
echo ""
echo "📋 Deployment Summary:"
echo "===================="
echo "ALB URL: http://$ALB_DNS"
echo "Health Check URL: http://$ALB_DNS/health"
echo "MCP Tools URL: http://$ALB_DNS/mcp/tools"
echo ""
echo "🔑 API Keys:"
echo "MCP_API_KEY: $MCP_API_KEY"
echo "BROWSER_API_KEY: $BROWSER_API_KEY"
echo ""
echo "🔧 Browser Registration:"
echo "To register a browser with the MCP server, the browser should POST to:"
echo "http://$ALB_DNS/register-browser"
echo ""
echo "Headers:"
echo "  Authorization: Bearer $BROWSER_API_KEY"
echo "  Content-Type: application/json"
echo ""
echo "Body:"
echo '{
  "cdp_port": 12345,
  "cdp_token": "secure-token",
  "token_expiry": "2025-07-23T00:00:00Z",
  "browser_instance_id": "browser-unique-id"
}'
echo ""
echo "📊 Monitoring:"
echo "CloudWatch Logs: https://console.aws.amazon.com/cloudwatch/home?region=$AWS_REGION#logStream:group=/ecs/magnitude-mcp"
echo "ECS Service: https://console.aws.amazon.com/ecs/home?region=$AWS_REGION#/clusters/$ECS_CLUSTER_NAME/services/$ECS_SERVICE_NAME/tasks"
echo ""
echo "🔒 Security Status: http://$ALB_DNS/mcp/security/status"
echo "📈 Metrics: http://$ALB_DNS/mcp/metrics"

# Clean up
rm -f task-definition.json