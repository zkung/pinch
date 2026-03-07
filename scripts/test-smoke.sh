#!/usr/bin/env sh
set -eu

node bin/openclaw-model.js --help >/dev/null

tmpdir=$(mktemp -d)
config="$tmpdir/openclaw.json"

cat > "$config" <<'JSON'
{
  "meta": {},
  "models": { "mode": "merge", "providers": {} },
  "agents": {
    "defaults": {
      "model": {
        "primary": "api-example-com-v1/gpt-4.1",
        "fallbacks": []
      },
      "models": {}
    },
    "list": []
  }
}
JSON

node bin/openclaw-model.js --config "$config" add https://api.example.com/v1 sk-test gpt-4.1 gpt41 >/dev/null
list_output=$(node bin/openclaw-model.js --config "$config" list)
printf '%s\n' "$list_output" | grep 'gpt41' >/dev/null

set +e
protected_output=$(node bin/openclaw-model.js --config "$config" del gpt41 2>&1)
protected_rc=$?
set -e

if [ "$protected_rc" -eq 0 ]; then
  echo 'protected delete should fail' >&2
  exit 1
fi
printf '%s\n' "$protected_output" | grep 'agents.defaults.model.primary' >/dev/null

node bin/openclaw-model.js --config "$config" del --force gpt41 >/dev/null

if node bin/openclaw-model.js --config "$config" list | grep -q 'gpt41'; then
  echo 'alias should have been removed' >&2
  exit 1
fi
