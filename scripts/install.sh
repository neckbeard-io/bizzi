#!/usr/bin/env bash
#
# bizzi installer for macOS and Linux
#
#   curl -fsSL https://raw.githubusercontent.com/neckbeard-io/bizzi/main/scripts/install.sh | bash
#
# Installs the desktop app as a standalone copy that updates itself (Settings › Updates):
#   macOS  bizzi.app in /Applications (or ~/Applications when /Applications isn't writable)
#   Linux  the AppImage in ~/.local/share/bizzi, `bizzi` in ~/.local/bin, and a launcher entry
#
# Options (after `bash -s --` when piped):
#   --version <v>   install this release, dev builds included (e.g. 0.1.0 or 0.1.1-dev.2)
#   --dev           install the newest dev pre-release (the app then follows the Dev channel)
#   --dir <path>    install somewhere else (macOS: the folder holding bizzi.app)
#   --no-launch     don't open bizzi afterwards
#   --uninstall     remove the app; your data in ~/.bizzi stays
#   -h, --help      show this help
#
# Windows: run bizzi-<version>-windows-x64-setup.exe from the releases page instead.

# Colors are fixed escape codes, so they go in printf formats.
# shellcheck disable=SC2059

set -euo pipefail

REPO="neckbeard-io/bizzi"
RELEASES="https://github.com/${REPO}/releases"

# ── Output ────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; BLUE=$'\033[0;34m'; GREEN=$'\033[0;32m'
  YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; CYAN=$'\033[0;36m'; NC=$'\033[0m'
else
  BOLD=""; DIM=""; BLUE=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; NC=""
fi

info()    { printf "${BLUE}${BOLD}==>${NC} %s\n" "$*"; }
step()    { printf "  ${CYAN}•${NC} %s\n" "$*"; }
success() { printf "${GREEN}${BOLD}✓${NC} %s\n" "$*"; }
warn()    { printf "${YELLOW}${BOLD}!${NC} %s\n" "$*"; }
die()     { printf "${RED}${BOLD}✗ Error:${NC} %s\n" "$*" >&2; exit 1; }

TMP_DIR=""
cleanup() {
  local code=$?
  [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] && rm -rf "$TMP_DIR"
  exit "$code"
}
trap cleanup EXIT INT TERM

show_help() {
  cat <<EOF
${BOLD}bizzi installer${NC} for macOS and Linux: a standalone app that updates itself.

${BOLD}Usage${NC}
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash -s -- [options]

${BOLD}Options${NC}
  --version <v>   install this release, dev builds included (e.g. 0.1.0 or 0.1.1-dev.2)
  --dev           install the newest dev pre-release (the app then follows the Dev channel)
  --dir <path>    install somewhere else (macOS: the folder holding bizzi.app)
  --no-launch     don't open bizzi afterwards
  --uninstall     remove the app; your data in ~/.bizzi stays
  -h, --help      show this help

Windows: run the setup .exe from ${RELEASES}/latest
EOF
  exit 0
}

# ── Versions ──────────────────────────────────────────────────────────

# The newest stable release. GitHub redirects /releases/latest to its tag page; this avoids
# api.github.com, whose 60 requests an hour per address are often spent on shared addresses
# (VPNs, offices, CGNAT).
resolve_latest_version() {
  local tag
  tag=$(curl -sSI "${RELEASES}/latest" 2>/dev/null \
    | grep -i '^location:' \
    | grep '/tag/' \
    | sed -E 's|.*/tag/([^/[:space:]]+).*|\1|' \
    | head -n 1 || true)
  if [ -z "$tag" ] || ! printf '%s' "$tag" | grep -qE '^v?[0-9]+\.[0-9]+\.[0-9]+'; then
    die "Could not find the latest bizzi release. Pass --version <v> (see ${RELEASES})."
  fi
  printf '%s\n' "${tag#v}"
}

# The newest release of any kind, pre-releases included (needs the API, so it can be rate limited).
resolve_dev_version() {
  local tag
  tag=$(curl -fsS -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${REPO}/releases?per_page=1" 2>/dev/null \
    | grep -m1 '"tag_name"' \
    | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)
  if [ -z "$tag" ] || ! printf '%s' "$tag" | grep -qE '^v?[0-9]+\.[0-9]+\.[0-9]+'; then
    die "Could not find the newest dev build (GitHub may be rate limiting). Pass --version <v> (see ${RELEASES})."
  fi
  printf '%s\n' "${tag#v}"
}

# ── Platforms ─────────────────────────────────────────────────────────

# The release asset for this machine (release.yml names them).
asset_name() {
  local version="$1" os="$2" arch="$3"
  case "$os/$arch" in
    Darwin/arm64)          echo "bizzi-${version}-macos-arm64.zip" ;;
    Darwin/x86_64)         echo "bizzi-${version}-macos-x64.zip" ;;
    Linux/x86_64|Linux/amd64)  echo "bizzi-${version}-linux-x86_64.AppImage" ;;
    Linux/aarch64|Linux/arm64) echo "bizzi-${version}-linux-arm64.AppImage" ;;
    *) return 1 ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Checks a download against the release's SHA256SUMS.txt.
verify_checksum() {
  local file="$1" name="$2" sums="$3" expected actual
  expected=$(grep -E "[[:space:]]\*?${name}\$" "$sums" | head -n 1 | cut -d' ' -f1 || true)
  [ -n "$expected" ] || die "${name} is not listed in the release's SHA256SUMS.txt."
  actual=$(sha256_of "$file")
  [ "$expected" = "$actual" ] || die "Checksum mismatch for ${name}: got ${actual}, expected ${expected}."
}

download() {
  local url="$1" out="$2"
  local opts=(-fL --retry 2)
  if [ -t 2 ]; then opts+=(--progress-bar); else opts+=(-sS); fi
  curl "${opts[@]}" "$url" -o "$out" || die "Download failed: ${url}"
}

# ── macOS ─────────────────────────────────────────────────────────────

mac_target_dir() {
  local custom="$1"
  if [ -n "$custom" ]; then echo "$custom"
  elif [ -w /Applications ]; then echo /Applications
  else echo "${HOME}/Applications"; fi
}

# Quits a running copy of this app bundle (not other copies, e.g. a test build) and waits; its core
# finishes what it's doing first.
quit_running_mac() {
  local app="$1" pids
  pids=$(pgrep -f "${app}/Contents/MacOS/bizzi" || true)
  [ -n "$pids" ] || return 0
  step "Quitting the running bizzi..."
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 120); do
    pgrep -f "${app}/Contents/MacOS/bizzi" >/dev/null || return 0
    sleep 0.5
  done
  die "bizzi is still running. Quit it and run the installer again."
}

install_macos() {
  local version="$1" zip="$2" custom_dir="$3" no_launch="$4"
  local target_dir target_app
  target_dir=$(mac_target_dir "$custom_dir")
  target_app="${target_dir}/bizzi.app"
  mkdir -p "$target_dir"

  step "Unpacking..."
  ditto -x -k "$zip" "${TMP_DIR}/unpacked"
  [ -d "${TMP_DIR}/unpacked/bizzi.app" ] || die "bizzi.app not found in the download."
  xattr -dr com.apple.quarantine "${TMP_DIR}/unpacked/bizzi.app" 2>/dev/null || true
  codesign --verify --deep --strict "${TMP_DIR}/unpacked/bizzi.app" 2>/dev/null \
    || die "The downloaded app's signature doesn't verify; not installing it."

  quit_running_mac "$target_app"
  info "Installing to ${BOLD}${target_app}${NC}"
  rm -rf "$target_app"
  ditto "${TMP_DIR}/unpacked/bizzi.app" "$target_app"

  success "bizzi v${version} is installed in ${target_app}"
  printf "  ${DIM}It updates itself: Settings › Updates.${NC}\n"
  if [ "$no_launch" = 0 ] && [ -t 1 ]; then
    step "Opening bizzi..."
    open "$target_app"
  fi
}

# ── Linux ─────────────────────────────────────────────────────────────

LINUX_DIR="${HOME}/.local/share/bizzi"
LINUX_BIN="${HOME}/.local/bin"
LINUX_APPS="${HOME}/.local/share/applications"
LINUX_ICONS="${HOME}/.local/share/icons/hicolor/512x512/apps"

has_fuse2() {
  if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then return 0; fi
  for f in /usr/lib/libfuse.so.2* /usr/lib64/libfuse.so.2* /usr/lib/*-linux-gnu/libfuse.so.2* /lib/*-linux-gnu/libfuse.so.2*; do
    [ -e "$f" ] && return 0
  done
  return 1
}

install_linux() {
  local version="$1" appimage="$2" custom_dir="$3" no_launch="$4" icon_url="$5"
  local dir="${custom_dir:-$LINUX_DIR}"
  local target="${dir}/bizzi.AppImage"
  mkdir -p "$dir" "$LINUX_BIN" "$LINUX_APPS" "$LINUX_ICONS"

  info "Installing to ${BOLD}${target}${NC}"
  # Rename over the old file: a running copy keeps its inode.
  cp "$appimage" "${target}.new"
  chmod 755 "${target}.new"
  mv -f "${target}.new" "$target"
  ln -sf "$target" "${LINUX_BIN}/bizzi"

  curl -fsSL "$icon_url" -o "${LINUX_ICONS}/bizzi.png" 2>/dev/null || true
  cat > "${LINUX_APPS}/bizzi.desktop" <<EOF
[Desktop Entry]
Name=bizzi
Comment=Drive your coding agents on your own machines
Exec=${target} %U
Icon=bizzi
Terminal=false
Type=Application
Categories=Development;
MimeType=x-scheme-handler/bizzi;
StartupWMClass=bizzi
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$LINUX_APPS" >/dev/null 2>&1 || true

  success "bizzi v${version} is installed in ${dir}"
  printf "  ${DIM}Run it from your app launcher or with \`bizzi\`. It updates itself: Settings › Updates.${NC}\n"

  if ! has_fuse2; then
    warn "AppImages need FUSE 2 (libfuse2), which wasn't found."
    printf "  Debian/Ubuntu: ${BOLD}sudo apt install libfuse2t64${NC} (older releases: libfuse2)\n"
    printf "  Fedora: ${BOLD}sudo dnf install fuse-libs${NC} · Arch: ${BOLD}sudo pacman -S fuse2${NC}\n"
  fi
  case ":${PATH}:" in
    *":${LINUX_BIN}:"*) ;;
    *) warn "${LINUX_BIN} is not on your PATH; add it to use the \`bizzi\` command." ;;
  esac
  if [ "$no_launch" = 0 ] && [ -t 1 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && has_fuse2; then
    step "Opening bizzi..."
    nohup "$target" >/dev/null 2>&1 &
  fi
}

# ── Uninstall ─────────────────────────────────────────────────────────

do_uninstall() {
  info "Removing bizzi"
  case "$(uname -s)" in
    Darwin)
      local found=0
      for app in /Applications/bizzi.app "${HOME}/Applications/bizzi.app"; do
        [ -d "$app" ] || continue
        quit_running_mac "$app"
        step "Removing ${app}"
        if [ -w "$(dirname "$app")" ]; then rm -rf "$app"; else sudo rm -rf "$app"; fi
        found=1
      done
      [ "$found" = 1 ] || warn "No bizzi.app in /Applications or ~/Applications."
      ;;
    Linux)
      rm -rf "$LINUX_DIR" "${LINUX_BIN}/bizzi" "${LINUX_APPS}/bizzi.desktop" "${LINUX_ICONS}/bizzi.png"
      command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$LINUX_APPS" >/dev/null 2>&1 || true
      ;;
    *) die "Unsupported system: $(uname -s)" ;;
  esac
  success "bizzi is removed. Your data in ~/.bizzi is still there; delete it yourself if you want it gone."
  exit 0
}

# ── Main ──────────────────────────────────────────────────────────────

main() {
  local version="" dev=0 custom_dir="" no_launch=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) shift; version="${1:-}" ;;
      --dev) dev=1 ;;
      --dir) shift; custom_dir="${1:-}" ;;
      --no-launch) no_launch=1 ;;
      --uninstall) do_uninstall ;;
      -h|--help) show_help ;;
      *) warn "Ignoring unknown option: $1" ;;
    esac
    shift || true
  done

  local os arch
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin|Linux) ;;
    CYGWIN*|MINGW*|MSYS*) die "On Windows, run the setup .exe from ${RELEASES}/latest" ;;
    *) die "Unsupported system: ${os}" ;;
  esac

  info "${BOLD}bizzi installer${NC}"
  if [ -z "$version" ]; then
    if [ "$dev" = 1 ]; then step "Finding the newest dev build..."; version=$(resolve_dev_version)
    else step "Finding the latest release..."; version=$(resolve_latest_version); fi
  fi
  version="${version#v}"

  local name
  name=$(asset_name "$version" "$os" "$arch") || die "No bizzi build for ${os} ${arch}."
  step "Version ${BOLD}v${version}${NC} (${os} ${arch})"

  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/bizzi-install.XXXXXX")
  local base="${RELEASES}/download/v${version}"
  info "Downloading ${name}"
  download "${base}/${name}" "${TMP_DIR}/${name}"
  download "${base}/SHA256SUMS.txt" "${TMP_DIR}/SHA256SUMS.txt" 2>/dev/null
  verify_checksum "${TMP_DIR}/${name}" "$name" "${TMP_DIR}/SHA256SUMS.txt"
  step "Checksum verified"

  if [ "$os" = Darwin ]; then
    install_macos "$version" "${TMP_DIR}/${name}" "$custom_dir" "$no_launch"
  else
    install_linux "$version" "${TMP_DIR}/${name}" "$custom_dir" "$no_launch" \
      "https://raw.githubusercontent.com/${REPO}/v${version}/apps/desktop/assets/icon.png"
  fi
  if printf '%s' "$version" | grep -q -- '-'; then
    printf "  ${DIM}A dev build starts on the Dev update channel.${NC}\n"
  fi
}

if [ "${BIZZI_INSTALL_TEST:-0}" != "1" ]; then
  main "$@"
fi
