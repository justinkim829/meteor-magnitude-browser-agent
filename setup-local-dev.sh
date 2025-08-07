#!/bin/bash

# Setup script for local development IAM permissions
# This script creates the necessary IAM permissions for local development

set -e

# Configuration
AWS_REGION="us-west-2"
AWS_ACCOUNT_ID="207567797907"
POLICY_NAME="MagnitudeLocalDevParameterAccess"
USER_NAME="magnitude-local-dev"

echo "🔧 Setting up local development IAM permissions..."

# Step 1: Create IAM policy for Parameter Store access
echo "📋 Creating IAM policy for Parameter Store access..."
aws iam create-policy \
  --policy-name $POLICY_NAME \
  --policy-document file://magnitude-local-dev-policy.json \
  --description "Allows local development access to Magnitude MCP server parameters" \
  --region $AWS_REGION 2>/dev/null || \
aws iam create-policy-version \
  --policy-arn "arn:aws:iam::$AWS_ACCOUNT_ID:policy/$POLICY_NAME" \
  --policy-document file://magnitude-local-dev-policy.json \
  --set-as-default \
  --region $AWS_REGION

# Step 2: Create IAM user for local development (optional)
echo "👤 Creating IAM user for local development (optional)..."
aws iam create-user \
  --user-name $USER_NAME \
  --region $AWS_REGION 2>/dev/null || true

# Step 3: Attach policy to user
echo "📎 Attaching policy to user..."
aws iam attach-user-policy \
  --user-name $USER_NAME \
  --policy-arn "arn:aws:iam::$AWS_ACCOUNT_ID:policy/$POLICY_NAME" \
  --region $AWS_REGION 2>/dev/null || true

echo "✅ Local development setup complete!"
echo ""
echo "🔑 To use this setup:"
echo "1. For existing AWS CLI user: Attach the policy to your current user"
echo "   aws iam attach-user-policy --user-name YOUR_USERNAME --policy-arn arn:aws:iam::$AWS_ACCOUNT_ID:policy/$POLICY_NAME"
echo ""
echo "2. For new development user: Create access keys"
echo "   aws iam create-access-key --user-name $USER_NAME"
echo ""
echo "3. Configure AWS CLI:"
echo "   aws configure"
echo "   (Enter your Access Key ID and Secret Access Key)"
echo ""
echo "4. Test access:"
echo "   aws ssm get-parameter --name \"/meteor/magnitude/anthropic-api-key\" --with-decryption --region $AWS_REGION"