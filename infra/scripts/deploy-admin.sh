#!/usr/bin/env bash
# Publishes the admin panel: writes dist/config.json from Terraform outputs,
# syncs packages/admin-web/dist to the site bucket and invalidates CloudFront.
#
# Usage: infra/scripts/deploy-admin.sh
# Requires: terraform, aws CLI (with credentials), jq. Run `npm run build`
# (or `npm run build -w packages/admin-web`) first.
#
# tenantId / clientId / apiScope come, in order of precedence, from the
# environment (TF_VAR_entra_tenant_id, TF_VAR_admin_spa_client_id,
# TF_VAR_admin_api_scope) or from infra/terraform/terraform.tfvars.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform"
DIST_DIR="$ROOT_DIR/packages/admin-web/dist"
TFVARS_FILE="${TFVARS_FILE:-$TF_DIR/terraform.tfvars}"

for tool in terraform aws jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' is required" >&2; exit 1; }
done

if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "error: $DIST_DIR/index.html not found. Build the panel first (npm run build -w packages/admin-web)." >&2
  exit 1
fi

# Reads a simple `key = "value"` line from terraform.tfvars.
tfvar() {
  local key="$1"
  [[ -f "$TFVARS_FILE" ]] || return 0
  sed -nE "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\"([^\"]*)\".*/\1/p" "$TFVARS_FILE" | head -n 1
}

TENANT_ID="${TF_VAR_entra_tenant_id:-$(tfvar entra_tenant_id)}"
CLIENT_ID="${TF_VAR_admin_spa_client_id:-$(tfvar admin_spa_client_id)}"
API_SCOPE="${TF_VAR_admin_api_scope:-$(tfvar admin_api_scope)}"

for pair in "entra_tenant_id:$TENANT_ID" "admin_spa_client_id:$CLIENT_ID" "admin_api_scope:$API_SCOPE"; do
  if [[ -z "${pair#*:}" ]]; then
    echo "error: ${pair%%:*} not found (set TF_VAR_${pair%%:*} or add it to $TFVARS_FILE)" >&2
    exit 1
  fi
done

echo "Reading Terraform outputs from $TF_DIR ..."
OUTPUTS="$(terraform -chdir="$TF_DIR" output -json)"
BUCKET="$(jq -r '.admin_bucket.value' <<<"$OUTPUTS")"
DIST_ID="$(jq -r '.cloudfront_distribution_id.value' <<<"$OUTPUTS")"
ADMIN_API_URL="$(jq -r '.admin_api_url.value' <<<"$OUTPUTS")"
ADMIN_URL="$(jq -r '.admin_url.value' <<<"$OUTPUTS")"

if [[ -z "$BUCKET" || "$BUCKET" == "null" ]]; then
  echo "error: Terraform outputs are empty. Run 'terraform apply' first." >&2
  exit 1
fi

# The panel calls `${apiBaseUrl}/admin/...`, so the base is the API root.
API_BASE_URL="${ADMIN_API_URL%/admin}"

jq -n \
  --arg tenantId "$TENANT_ID" \
  --arg clientId "$CLIENT_ID" \
  --arg apiBaseUrl "$API_BASE_URL" \
  --arg apiScope "$API_SCOPE" \
  '{tenantId: $tenantId, clientId: $clientId, apiBaseUrl: $apiBaseUrl, apiScope: $apiScope}' \
  > "$DIST_DIR/config.json"
echo "Wrote $DIST_DIR/config.json"

echo "Syncing $DIST_DIR -> s3://$BUCKET ..."
# Hashed assets can be cached for a long time; the entry points must not.
aws s3 sync "$DIST_DIR" "s3://$BUCKET" --delete \
  --exclude "index.html" --exclude "config.json" \
  --cache-control "public, max-age=31536000, immutable"
aws s3 cp "$DIST_DIR/index.html" "s3://$BUCKET/index.html" \
  --cache-control "no-cache" --content-type "text/html; charset=utf-8"
aws s3 cp "$DIST_DIR/config.json" "s3://$BUCKET/config.json" \
  --cache-control "no-cache" --content-type "application/json"

echo "Invalidating CloudFront distribution $DIST_ID ..."
INVALIDATION_ID="$(aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" --paths "/*" \
  --query 'Invalidation.Id' --output text)"
echo "Invalidation $INVALIDATION_ID created."
echo "Admin panel: $ADMIN_URL"
