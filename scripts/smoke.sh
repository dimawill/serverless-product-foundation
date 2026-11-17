#!/usr/bin/env bash
set -euo pipefail
# Run only after deployment. AWS CLI credentials and a fresh email address are required.
: "${AWS_REGION:?Set AWS_REGION}"
: "${STAGE:?Set STAGE to dev or prod}"
: "${EMAIL:?Set EMAIL to an address you control}"
for cmd in aws jq curl; do command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 1; }; done
stack="ServerlessNotes-${STAGE}"
output() {
  aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}
api_url="$(output ApiUrl)"
pool_id="$(output UserPoolId)"
client_id="$(output AppClientId)"
if [[ "$api_url" == None || "$pool_id" == None || "$client_id" == None ]]; then
  echo 'Stack outputs missing. Deploy the stack first.' >&2; exit 1
fi
read -r -s -p 'New Cognito password (12+ chars; uppercase, lowercase, digit, symbol): ' password
printf '\n'
tmp="$(mktemp -d)"
chmod 700 "$tmp"
trap 'rm -f "$tmp"/signup.json "$tmp"/auth.json "$tmp"/curl.conf; rmdir "$tmp"; unset password' EXIT
jq -n --arg id "$client_id" --arg email "$EMAIL" --arg pass "$password" \
  '{ClientId:$id,Username:$email,Password:$pass}' > "$tmp/signup.json"
chmod 600 "$tmp/signup.json"
aws cognito-idp sign-up --region "$AWS_REGION" --cli-input-json "file://$tmp/signup.json" >/dev/null
read -r -p 'Email verification code: ' code
aws cognito-idp confirm-sign-up --region "$AWS_REGION" --client-id "$client_id" \
  --username "$EMAIL" --confirmation-code "$code" >/dev/null
jq -n --arg id "$client_id" --arg email "$EMAIL" --arg pass "$password" \
  '{ClientId:$id,AuthFlow:"USER_PASSWORD_AUTH",AuthParameters:{USERNAME:$email,PASSWORD:$pass}}' > "$tmp/auth.json"
chmod 600 "$tmp/auth.json"
id_token="$(aws cognito-idp initiate-auth --region "$AWS_REGION" \
  --cli-input-json "file://$tmp/auth.json" --query 'AuthenticationResult.IdToken' --output text)"
unset password
printf 'header = "Authorization: Bearer %s"\n' "$id_token" > "$tmp/curl.conf"
chmod 600 "$tmp/curl.conf"
unset id_token
api_url="${api_url%/}"
echo 'Creating note...'
created="$(curl -fsS -K "$tmp/curl.conf" -H 'Content-Type: application/json' \
  -X POST "$api_url/notes" -d '{"title":"Smoke test","content":"Created by smoke test"}')"
note_id="$(jq -er '.id' <<< "$created")"
echo 'Listing and reading note...'
curl -fsS -K "$tmp/curl.conf" "$api_url/notes" | jq -e --arg id "$note_id" '.items | any(.id == $id)' >/dev/null
curl -fsS -K "$tmp/curl.conf" "$api_url/notes/$note_id" | jq -e --arg id "$note_id" '.id == $id' >/dev/null
echo 'Updating and deleting note...'
curl -fsS -K "$tmp/curl.conf" -H 'Content-Type: application/json' -X PUT \
  "$api_url/notes/$note_id" -d '{"title":"Updated","content":"Smoke test"}' | jq -e '.title == "Updated"' >/dev/null
curl -fsS -K "$tmp/curl.conf" -X DELETE "$api_url/notes/$note_id" >/dev/null
echo 'CRUD smoke test passed.'
