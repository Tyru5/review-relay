#!/usr/bin/env bash
# Install the review-relay binary on macOS / Linux from the GitHub Releases of Tyru5/review-relay.
#   curl -fsSL https://github.com/Tyru5/review-relay/releases/latest/download/install.sh | bash
#   curl -fsSL https://github.com/Tyru5/review-relay/releases/latest/download/install.sh | bash -s -- --version 0.2.0
set -euo pipefail

REPO="${REVIEW_RELAY_INSTALL_REPO:-Tyru5/review-relay}"
BASE_URL="https://github.com/$REPO/releases"
VERSION="${REVIEW_RELAY_INSTALL_VERSION:-latest}"
BIN_DIR="${REVIEW_RELAY_INSTALL_BIN_DIR:-$HOME/.local/bin}"
CONFIG="${REVIEW_RELAY_CONFIG:-$HOME/.review-relay/config.json}"

if [[ -t 1 ]]; then
  B=$'\e[1m'; D=$'\e[2m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; N=$'\e[0m'
else
  B=; D=; R=; G=; Y=; N=
fi

info() { printf '%s›%s %s\n' "$B" "$N" "$*"; }
ok()   { printf '%s✔%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*" >&2; }
fail() { printf '%s✘%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<USAGE
${B}usage:${N} curl -fsSL $BASE_URL/latest/download/install.sh | bash [-s -- options]

  --version <x.y.z>   version to install (default: latest)
  --bin-dir <path>    install location (default: ~/.local/bin)
  -h, --help          show this help

${D}env: REVIEW_RELAY_INSTALL_{VERSION,BIN_DIR,REPO}, REVIEW_RELAY_CONFIG${N}
USAGE
}

need_value() { [[ -n "${2:-}" && "$2" != -* ]] || fail "$1 requires a value"; }

while (($#)); do
  case "$1" in
    --version)   need_value "$1" "${2:-}"; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --bin-dir)   need_value "$1" "${2:-}"; BIN_DIR="$2"; shift 2 ;;
    --bin-dir=*) BIN_DIR="${1#*=}"; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           usage >&2; fail "unknown option: $1" ;;
  esac
done

detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux)  os=linux ;;
    MINGW*|MSYS*|CYGWIN*) fail "Windows shell detected; in PowerShell run: irm $BASE_URL/latest/download/install.ps1 | iex" ;;
    *)      fail "unsupported OS: $(uname -s) (macOS, Linux, Windows only)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *)             fail "unsupported CPU: $(uname -m) (x64 and arm64 only)" ;;
  esac
  # A shell under Rosetta reports x86_64; the native build is the better fit.
  if [[ $os == darwin && $arch == x64 && "$(sysctl -n sysctl.proc_translated 2>/dev/null)" == 1 ]]; then
    arch=arm64
  fi
  if [[ $os == linux ]] && has ldd && { ldd --version 2>&1 || true; } | grep -qi musl; then
    fail "musl libc (Alpine and similar) is not supported; use a glibc-based distro"
  fi
  echo "$os-$arch"
}

fetch() {
  if has curl; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif has wget; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is required"
  fi
}

# GitHub answers /releases/latest with a redirect to /releases/tag/<tag>; the tag is the version.
latest_version() {
  local final
  if has curl; then
    final="$(curl -fsSLI --retry 3 -o /dev/null -w '%{url_effective}' "$BASE_URL/latest" || true)"
  elif has wget; then
    # wget exits non-zero when it stops at the redirect; the Location header is all that matters.
    final="$({ wget -q -S --spider --max-redirect=0 "$BASE_URL/latest" 2>&1 || true; } | awk '/^ *Location:/ { print $2 }' | tail -n1)"
  else
    fail "curl or wget is required"
  fi
  [[ $final == */releases/tag/* ]] || fail "could not find the latest release at $BASE_URL"
  echo "${final##*/releases/tag/}"
}

sha256() {
  if has sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif has shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "sha256sum or shasum is required to verify the download"
  fi
}

check_runtime_deps() {
  local missing=()
  has git || missing+=("git")
  if ! has gh; then
    missing+=("gh (https://cli.github.com), then: gh auth login")
  elif ! gh extension list 2>/dev/null | grep -q 'gh-webhook'; then
    missing+=("gh webhook extension: gh extension install cli/gh-webhook")
  fi
  has codex  || missing+=("codex CLI (signed in)")
  has claude || missing+=("claude CLI (signed in)")
  if ((${#missing[@]})); then
    warn "review-relay needs these at runtime:"
    printf '    %s\n' "${missing[@]}" >&2
  fi
}

TARGET="$(detect_target)"
ASSET="review-relay-$TARGET"
TMP="$(mktemp -d)"
STAGED="$BIN_DIR/.review-relay.download"
trap 'rm -rf "$TMP" "$STAGED"' EXIT

if [[ $VERSION == latest ]]; then
  VERSION="$(latest_version)"
fi
VERSION="${VERSION#v}"
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || fail "invalid version: $VERSION"
URL="$BASE_URL/download/v$VERSION"

info "downloading review-relay $VERSION ($TARGET)"
mkdir -p "$BIN_DIR"
fetch "$URL/SHA256SUMS" "$TMP/SHA256SUMS" || fail "version $VERSION not found at $URL"
# Staged next to the target so the final mv is an atomic rename, even over a running binary.
fetch "$URL/$ASSET" "$STAGED" || fail "no $ASSET build for $VERSION"

expected="$(awk -v f="$ASSET" '$2 == f { print $1 }' "$TMP/SHA256SUMS")"
[[ -n $expected ]] || fail "$ASSET missing from SHA256SUMS"
[[ "$(sha256 "$STAGED")" == "$expected" ]] || fail "checksum mismatch for $ASSET; aborting"

chmod +x "$STAGED"
mv -f "$STAGED" "$BIN_DIR/review-relay"
installed="$("$BIN_DIR/review-relay" --version)" || fail "installed, but '$BIN_DIR/review-relay --version' failed"
ok "review-relay $installed installed to $BIN_DIR/review-relay"

if [[ -f "$CONFIG" ]]; then
  ok "keeping existing config $CONFIG"
else
  mkdir -p "$(dirname "$CONFIG")"
  fetch "$URL/config.example.json" "$CONFIG" && ok "wrote example config to $CONFIG ${Y}(edit repos before starting)${N}"
fi

check_runtime_deps

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on PATH; add to your shell rc:"
     echo "    export PATH=\"$BIN_DIR:\$PATH\"" >&2 ;;
esac

cat <<NEXT

${B}Next${N}
  review-relay setup        ${D}# pick repos, reviewers, and models (or \$EDITOR $CONFIG)${N}
  review-relay start        ${D}# watch configured repos${N}
  review-relay status       ${D}# recent jobs${N}
  rerun the installer to update
NEXT
