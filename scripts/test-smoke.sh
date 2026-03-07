#!/usr/bin/env sh
set -eu

node bin/pinch.js --help >/dev/null

tmpdir=$(mktemp -d)
cleanup() {
  if [ "${server_pid:-}" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT INT TERM

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

node bin/pinch.js --config "$config" add https://api.example.com/v1 sk-test gpt-4.1 gpt41 >/dev/null
list_output=$(node bin/pinch.js --config "$config" list)
printf '%s\n' "$list_output" | grep 'gpt41' >/dev/null
printf '%s\n' "$list_output" | grep 'Current default: gpt41 (api-example-com-v1/gpt-4.1)' >/dev/null
printf '%s\n' "$list_output" | grep 'yes[[:space:]]*gpt41' >/dev/null

set +e
protected_output=$(node bin/pinch.js --config "$config" del gpt41 2>&1)
protected_rc=$?
set -e

if [ "$protected_rc" -eq 0 ]; then
  echo 'protected delete should fail' >&2
  exit 1
fi
printf '%s\n' "$protected_output" | grep 'agents.defaults.model.primary' >/dev/null

node bin/pinch.js --config "$config" del --force gpt41 >/dev/null

if node bin/pinch.js --config "$config" list | grep -q 'gpt41'; then
  echo 'alias should have been removed' >&2
  exit 1
fi

provider_only_config="$tmpdir/provider-only.json"

cat > "$provider_only_config" <<'JSON'
{
  "meta": {},
  "models": {
    "mode": "merge",
    "providers": {
      "x666-me-v1": {
        "baseUrl": "https://api.example.com/v1",
        "apiKey": "sk-provider-only",
        "api": "openai-completions",
        "models": [
          { "id": "gpt-5.4", "name": "gpt-5.4" },
          { "id": "gpt-5.4-mini", "name": "gpt-5.4-mini" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "x666-me-v1/gpt-5.4",
        "fallbacks": []
      },
      "models": {}
    },
    "list": []
  }
}
JSON

provider_only_output=$(node bin/pinch.js --config "$provider_only_config" list)
printf '%s\n' "$provider_only_output" | grep 'Current default: x666-me-v1/gpt-5.4' >/dev/null
printf '%s\n' "$provider_only_output" | grep 'yes[[:space:]]*-[[:space:]]*x666-me-v1/gpt-5.4' >/dev/null
printf '%s\n' "$provider_only_output" | grep 'x666-me-v1/gpt-5.4-mini' >/dev/null

provider_only_default_output=$(node bin/pinch.js --config "$provider_only_config" default x666-me-v1/gpt-5.4-mini)
printf '%s\n' "$provider_only_default_output" | grep 'Default model set: x666-me-v1/gpt-5.4-mini' >/dev/null

provider_only_after_default=$(node bin/pinch.js --config "$provider_only_config" list)
printf '%s\n' "$provider_only_after_default" | grep 'Current default: x666-me-v1/gpt-5.4-mini' >/dev/null
printf '%s\n' "$provider_only_after_default" | grep 'yes[[:space:]]*-[[:space:]]*x666-me-v1/gpt-5.4-mini' >/dev/null

provider_only_delete_output=$(node bin/pinch.js --config "$provider_only_config" del x666-me-v1/gpt-5.4)
printf '%s\n' "$provider_only_delete_output" | grep 'Model removed: x666-me-v1/gpt-5.4' >/dev/null

provider_only_after_delete=$(node bin/pinch.js --config "$provider_only_config" list)
if printf '%s\n' "$provider_only_after_delete" | grep -q 'x666-me-v1/gpt-5.4[[:space:]]'; then
  echo 'modelRef delete should remove provider-only model' >&2
  exit 1
fi
printf '%s\n' "$provider_only_after_delete" | grep 'x666-me-v1/gpt-5.4-mini' >/dev/null

port_file="$tmpdir/mock-model-port"
server_script="$tmpdir/mock-model-server.js"
discover_config="$tmpdir/discover.json"

cat > "$server_script" <<'NODE'
const fs = require('fs');
const http = require('http');

const portFile = process.argv[2];
const expectedToken = process.argv[3];

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${expectedToken}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad auth header' } }));
    return;
  }

  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: [
        { id: 'claude-3.7-sonnet', owned_by: 'mock-provider' },
        { id: 'gpt-4.1-mini', owned_by: 'mock-provider' }
      ]
    }));
    return;
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');

      if (payload.model !== 'claude-3.7-sonnet') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unexpected model' } }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock-1',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'OK'
            }
          }
        ]
      }));
    });
    return;
  }

  if (req.url !== '/v1/models') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
NODE

node "$server_script" "$port_file" sk-discover >"$tmpdir/mock-model-server.log" 2>&1 &
server_pid=$!

attempt=0
while [ ! -s "$port_file" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 50 ]; then
    echo 'mock model server did not start in time' >&2
    cat "$tmpdir/mock-model-server.log" >&2 || true
    exit 1
  fi
  sleep 0.1
done

port=$(cat "$port_file")

cat > "$discover_config" <<JSON
{
  "meta": {},
  "models": {
    "mode": "merge",
    "providers": {
      "discover-provider": {
        "baseUrl": "http://127.0.0.1:$port/v1",
        "apiKey": "sk-discover",
        "api": "openai-completions",
        "models": []
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "placeholder/model",
        "fallbacks": []
      },
      "models": {}
    },
    "list": []
  }
}
JSON

search_output=$(node bin/pinch.js --config "$discover_config" search "http://127.0.0.1:$port/v1")
printf '%s\n' "$search_output" | grep 'claude-3.7-sonnet' >/dev/null
printf '%s\n' "$search_output" | grep 'gpt-4.1-mini' >/dev/null

node bin/pinch.js --config "$discover_config" add --discover "http://127.0.0.1:$port/v1" claude-3.7-sonnet claude37 >/dev/null

default_output=$(node bin/pinch.js --config "$discover_config" default claude37)
printf '%s\n' "$default_output" | grep 'Default model set: discover-provider/claude-3.7-sonnet' >/dev/null

test_output=$(node bin/pinch.js --config "$discover_config" test claude37)
printf '%s\n' "$test_output" | grep 'Test result: ok' >/dev/null
printf '%s\n' "$test_output" | grep 'Response preview: OK' >/dev/null

test_output_by_ref=$(node bin/pinch.js --config "$discover_config" test discover-provider/claude-3.7-sonnet)
printf '%s\n' "$test_output_by_ref" | grep 'Model tested: discover-provider/claude-3.7-sonnet' >/dev/null
printf '%s\n' "$test_output_by_ref" | grep 'Test result: ok' >/dev/null

discover_output=$(node bin/pinch.js --config "$discover_config" list)
printf '%s\n' "$discover_output" | grep 'Current default: claude37 (discover-provider/claude-3.7-sonnet)' >/dev/null
printf '%s\n' "$discover_output" | grep 'yes[[:space:]]*claude37' >/dev/null
printf '%s\n' "$discover_output" | grep 'claude37' >/dev/null
printf '%s\n' "$discover_output" | grep 'discover-provider/claude-3.7-sonnet' >/dev/null
