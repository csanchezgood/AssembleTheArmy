# Remote state in S3 with S3-native locking (Terraform >= 1.10; no DynamoDB
# table needed). The bucket is versioned, encrypted and private; it was
# created outside Terraform on 2026-09-25 (see docs/HANDOFF.md).
terraform {
  backend "s3" {
    bucket       = "ata-terraform-state-826990194949"
    key          = "assemble-the-army/dev/terraform.tfstate"
    region       = "us-east-2"
    use_lockfile = true
    encrypt      = true
  }
}
