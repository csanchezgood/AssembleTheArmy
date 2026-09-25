#!/usr/bin/env bash
# Loads the two secret values managed outside Terraform:
#   ${prefix}graph-client-secret  -> {"clientSecret": "..."}
#   ${prefix}webhook-secret       -> {"secret": "..."}
#
# Usage: infra/scripts/set-secrets.sh
# Requires: terraform (outputs of an applied stack), aws CLI, jq.
# Values are read with `read -s` and never echoed nor written to disk.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform"

for tool in terraform aws jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' is required" >&2; exit 1; }
done

OUTPUTS="$(terraform -chdir="$TF_DIR" output -json)"
GRAPH_SECRET_ARN="$(jq -r '.graph_secret_arn.value' <<<"$OUTPUTS")"
WEBHOOK_SECRET_ARN="$(jq -r '.webhook_secret_arn.value' <<<"$OUTPUTS")"

if [[ -z "$GRAPH_SECRET_ARN" || "$GRAPH_SECRET_ARN" == "null" ]]; then
  echo "error: Terraform outputs are empty. Run 'terraform apply' first." >&2
  exit 1
fi

put_secret() {
  local arn="$1" json="$2"
  aws secretsmanager put-secret-value --secret-id "$arn" --secret-string "$json" \
    --query 'VersionId' --output text
}

echo "Graph client secret ($GRAPH_SECRET_ARN)"
read -r -s -p "  Entra app client secret (leave empty to skip): " GRAPH_CLIENT_SECRET
echo
if [[ -n "$GRAPH_CLIENT_SECRET" ]]; then
  VERSION="$(put_secret "$GRAPH_SECRET_ARN" "$(jq -n --arg v "$GRAPH_CLIENT_SECRET" '{clientSecret: $v}')")"
  echo "  stored (version $VERSION)"
else
  echo "  skipped"
fi
unset GRAPH_CLIENT_SECRET

echo "Webhook shared secret ($WEBHOOK_SECRET_ARN)"
read -r -s -p "  X-Webhook-Secret value (leave empty to generate a random one): " WEBHOOK_SECRET
echo
if [[ -z "$WEBHOOK_SECRET" ]]; then
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
  echo "  generated a random 64-hex secret; configure it in the New Relic destination header."
  echo "  value: $WEBHOOK_SECRET"
fi
VERSION="$(put_secret "$WEBHOOK_SECRET_ARN" "$(jq -n --arg v "$WEBHOOK_SECRET" '{secret: $v}')")"
echo "  stored (version $VERSION)"
unset WEBHOOK_SECRET

echo "Done. Lambdas cache secrets per container; new values apply on the next cold start."
