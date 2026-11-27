#!/usr/bin/env bash
# Unit tests for scripts/install.sh: version lookup, asset names, checksum checks.
#   bash scripts/test-install.sh
# No network: `curl` is replaced per test, and install.sh is sourced with BIZZI_INSTALL_TEST=1.

# The curl mocks are called by the sourced installer.
# shellcheck disable=SC2329,SC1090,SC2016

set -uo pipefail

INSTALLER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh"
work=$(mktemp -d)
echo 0 > "$work/pass"
echo 0 > "$work/fail"
trap 'rm -rf "$work"' EXIT

pass() { echo "  ✓ $1"; echo $(( $(cat "$work/pass") + 1 )) > "$work/pass"; }
fail() { echo "  ✗ $1"; echo $(( $(cat "$work/fail") + 1 )) > "$work/fail"; }
check() { if ( eval "$2" ); then pass "$1"; else fail "$1"; fi; }

# GitHub for an address whose API allowance is spent: only the real redirect answers with $1.
mock_github() {
  _redirect="$1"
  curl() {
    case "$*" in
      *api.github.com*) printf '{"message":"API rate limit exceeded"}\n'; return 22 ;;
      *//github.com/neckbeard-io/bizzi/releases/latest*) printf '%b' "$_redirect" ;;
      *) printf 'HTTP/2 404\r\n\r\n' ;;
    esac
  }
}

load() { BIZZI_INSTALL_TEST=1 source "$INSTALLER" 2>/dev/null; trap - EXIT INT TERM; }

echo "install.sh"

check "the latest release comes from the redirect, with the API rate limited" '
  load; mock_github "HTTP/2 302\r\nlocation: https://github.com/neckbeard-io/bizzi/releases/tag/v0.1.0\r\n\r\n"
  [ "$(resolve_latest_version)" = "0.1.0" ]'

check "a capitalized Location header (HTTP/1.1)" '
  load; mock_github "HTTP/1.1 302 Found\r\nLocation: https://github.com/neckbeard-io/bizzi/releases/tag/v1.2.3\r\n\r\n"
  [ "$(resolve_latest_version)" = "1.2.3" ]'

check "no stable release yet (redirect to /releases) fails" '
  load; mock_github "HTTP/2 302\r\nlocation: https://github.com/neckbeard-io/bizzi/releases\r\n\r\n"
  ! (resolve_latest_version) >/dev/null 2>&1'

check "a tag that is not a version fails" '
  load; mock_github "HTTP/2 302\r\nlocation: https://github.com/neckbeard-io/bizzi/releases/tag/nightly\r\n\r\n"
  ! (resolve_latest_version) >/dev/null 2>&1'

check "offline fails" '
  load; curl() { return 6; }
  ! (resolve_latest_version) >/dev/null 2>&1'

check "--dev takes the newest release from the API" '
  load; curl() { printf "[\n  {\n    \"url\": \"x\",\n    \"tag_name\": \"v0.1.1-dev.4\",\n    \"name\": \"bizzi v0.1.1-dev.4\"\n  }\n]\n"; }
  [ "$(resolve_dev_version)" = "0.1.1-dev.4" ]'

check "--dev fails cleanly when the API is rate limited" '
  load; mock_github ""
  ! (resolve_dev_version) >/dev/null 2>&1'

check "asset names match release.yml" '
  load
  [ "$(asset_name 0.1.0 Darwin arm64)" = "bizzi-0.1.0-macos-arm64.zip" ] &&
  [ "$(asset_name 0.1.0 Darwin x86_64)" = "bizzi-0.1.0-macos-x64.zip" ] &&
  [ "$(asset_name 0.1.0 Linux x86_64)" = "bizzi-0.1.0-linux-x86_64.AppImage" ] &&
  [ "$(asset_name 0.1.0 Linux aarch64)" = "bizzi-0.1.0-linux-arm64.AppImage" ] &&
  ! asset_name 0.1.0 FreeBSD amd64 >/dev/null'

check "the checksum check accepts a match and refuses a mismatch" '
  load
  printf "hello" > "$work/a.zip"
  printf "%s  a.zip\n%s  other.zip\n" "$(sha256_of "$work/a.zip")" "00" > "$work/sums"
  verify_checksum "$work/a.zip" a.zip "$work/sums" &&
  ! (verify_checksum "$work/a.zip" other.zip "$work/sums") >/dev/null 2>&1 &&
  ! (verify_checksum "$work/a.zip" missing.zip "$work/sums") >/dev/null 2>&1'

p=$(cat "$work/pass"); f=$(cat "$work/fail")
echo ""
echo "Results: ${p} passed, ${f} failed"
[ "$f" -eq 0 ]
