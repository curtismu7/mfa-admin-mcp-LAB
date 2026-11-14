#!/usr/bin/env bash
# MFA Admin MCP LAB: one-command install.
#
#   curl -fsSL https://raw.githubusercontent.com/curtismu7/mfa-admin-mcp-LAB/main/install.sh | bash
#
# Downloads the repo as a tarball (no git needed) into ./mfa-admin-mcp-LAB, then:
#   - Docker running:  docker compose up --build -d, and waits for /api/health
#   - else Node >= 26: npm ci && npm run build (start it with npm start)
# It starts in Mock mode: nothing leaves the machine and no credentials are asked for.
#
# Optional settings go on the bash side of the pipe:
#   curl -fsSL <url> | HOST_PORT=7816 bash
#   MFAADM_DIR=<dir>   install directory (default ./mfa-admin-mcp-LAB)
#   MFAADM_REF=<ref>   branch, tag or commit to install (default main)
#   HOST_PORT=<port>   Docker only: the port published on 127.0.0.1 (default 7815)
# Running it again updates the files in place and rebuilds; saved connections are kept.
set -euo pipefail

die() { printf 'install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

pick_form() {
  if have docker && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then echo docker; return; fi
  if have node && have npm && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 26 ]; then echo node; return; fi
  return 1
}

main() {
  local repo=curtismu7/mfa-admin-mcp-LAB
  local ref=${MFAADM_REF:-main}
  local dir=${MFAADM_DIR:-mfa-admin-mcp-LAB}
  local port=${HOST_PORT:-7815}
  local form

  have curl || die "curl is required."
  have tar || die "tar is required."
  case $port in ''|*[!0-9]*) die "HOST_PORT must be a number, got '$port'." ;; esac
  form=$(pick_form) || die "need Docker running with the compose plugin (OrbStack or Docker Desktop), or Node 26 or newer with npm. Start Docker, or install Node 26, and run this again."

  # Never unpack over a directory that is not an earlier install of this app.
  if [ -n "$(ls -A "$dir" 2>/dev/null)" ] && ! grep -q '"name": "mfa-admin-mcp-lab"' "$dir/package.json" 2>/dev/null; then
    die "$dir exists and is not an install of this app. Set MFAADM_DIR to another directory."
  fi

  mkdir -p "$dir"
  curl -fsSL "https://codeload.github.com/$repo/tar.gz/$ref" | tar -xz --strip-components=1 -C "$dir" \
    || die "could not download '$ref' from github.com/$repo."
  dir=$(cd "$dir" && pwd)

  if [ "$form" = docker ]; then
    # The compose file bind-mounts this optional file. If it is missing, Docker creates a directory there,
    # which then blocks creating the file. An empty file means "not configured", the same as missing.
    local worker=${MFAADM_WORKER_ENV_FILE:-$HOME/.config/mfa-admin-mcp/worker.env}
    if [ ! -e "$worker" ]; then
      mkdir -p "$(dirname "$worker")"
      (umask 077; : > "$worker")
    fi

    (cd "$dir" && HOST_PORT="$port" docker compose up --build -d)

    local url=http://127.0.0.1:$port
    printf 'Waiting for %s/api/health ' "$url"
    for _ in $(seq 1 60); do
      if curl -fsS "$url/api/health" 2>/dev/null | grep -q 'demo-health/1'; then
        printf '\nMFA Admin MCP LAB is running (Mock mode): %s/\nStop it with: cd %q && docker compose down\n' "$url" "$dir"
        return 0
      fi
      printf .; sleep 2
    done
    printf '\n'
    die "started, but $url/api/health did not answer. See: cd $(printf %q "$dir") && docker compose logs"
  fi

  (cd "$dir" && npm ci && npm run build)
  printf 'MFA Admin MCP LAB is installed in %s\nStart it with: cd %q && npm start   (then open http://127.0.0.1:7815/)\n' "$dir" "$dir"
}

# Everything runs from one function called on the last line, so a truncated download cannot run half a script.
main "$@"
