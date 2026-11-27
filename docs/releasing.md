# Releasing bizzi

Maintainer reference for branches, release channels, the release workflow, what the self-updater
does, and what people installing a build have to know. The everyday rules (branch from `dev`, write
the changelog line with the change) are in [AGENTS.md](../AGENTS.md#branches-and-releases).

## Branches and channels

- **`dev` → Dev channel.** Every merged PR publishes a pre-release `vX.Y.Z-dev.N`
  (e.g. `v0.1.0-dev.4`). Installed copies on the Dev channel get it.
- **`main` → Stable channel.** `dev` reaches `main` through a promotion PR, which publishes
  `vX.Y.Z`. Stable is the default channel.

Versions follow SemVer 2.0 ordering: `v0.1.0 < v0.1.1-dev.1 < v0.1.1-dev.2 < v0.1.1`. Stable copies
ignore `-dev.N` builds. Dev copies see everything, so they move to the final `vX.Y.Z` when it lands
on `main` and to the next dev build after that. A copy running a `-dev` build starts on the Dev
channel; anything else starts on Stable.

## What publishes a release

`.github/workflows/release.yml`:

| Trigger | Version | Publishes |
|---|---|---|
| push to `dev` (a merged PR) | next `vX.Y.Z-dev.N`: the patch after the last closed version, N after the existing tags | pre-release, images `:<version>` + `:dev` |
| push to `main` (a promotion) | the newest closed `## vX.Y.Z — <date>` in `CHANGELOG.md` | release marked latest, images `:<version>` + `:latest` |
| pull request touching packaging | `X.Y.Z-pr.N` | nothing: build check only |
| `workflow_dispatch` | the `version` input, or as for the branch | per the `publish` / `docker` inputs |

Pushes that only touch Markdown, `docs/`, `.github/`, `LICENSE` or `NOTICE` publish nothing. A
release for them would offer every installed copy an identical build. Runs on the same branch
cancel each other, so when PRs merge in quick succession only the newest tip is built.

Jobs: **setup** (`scripts/release/resolve.ts`) → **desktop** (five runners) → **docker** (multi-arch
images on GHCR) → **release** (notes, `SHA256SUMS.txt`, the GitHub Release). Nothing is published
unless every desktop build succeeded.

### Artifacts

Each desktop runner runs `scripts/release/build-desktop.ts`, which writes into `dist/`:

| Runner | Files |
|---|---|
| `macos-15` | `bizzi-<v>-macos-arm64.dmg`, `.zip` |
| `macos-15-intel` | `bizzi-<v>-macos-x64.dmg`, `.zip` |
| `ubuntu-24.04` | `bizzi-<v>-linux-x86_64.AppImage`, `bizzi-<v>-linux-amd64.deb` |
| `ubuntu-24.04-arm` | `bizzi-<v>-linux-arm64.AppImage`, `bizzi-<v>-linux-arm64.deb` |
| `windows-latest` | `bizzi-<v>-windows-x64-setup.exe` |

The `.zip` is what installed Macs update from; the `.dmg` is for people. The updater finds assets by
these suffixes (`assetSuffix` in `apps/desktop/src/update/github.ts`). Rename one and copies already
in use stop updating, so change both together and keep accepting the old name for a while.

Inside each app, `apps/desktop/scripts/stage.ts` puts the core next to Electron:
- the official Node build matching the runner's (checked against `SHASUMS256.txt`);
- the core's sources and its production dependencies, installed on that runner, so native addons
  match;
- no `node_modules/@bizzi` links: `apps/cli/src/workspaces-hook.ts` resolves those imports, because
  installers don't keep symlinks and Node won't strip types under `node_modules`.

The Claude Agent SDK's bundled `claude` binary (about 300 MB per platform) is left out. The adapter
runs the `claude` bizzi provisions instead. `BIZZI_STAGE_CLAUDE_BINARY=1` keeps it.

### Docker images

`ghcr.io/neckbeard-io/bizzi-node` and `ghcr.io/neckbeard-io/bizzi-hub`, for `linux/amd64` and
`linux/arm64`, tagged `<version>` plus `latest` (stable) or `dev`. The core inside reports the release
version (build arg `BIZZI_VERSION`). Remote machines update with `docker compose pull && docker
compose up -d`.

## The release body is the changelog, and that's enforced

`scripts/release/notes.ts` writes the body:

- **Stable:** the `## vX.Y.Z` section of `CHANGELOG.md`. If it is missing or empty, **the run fails**
  before anything is published. Write the entry; don't edit the script.
- **Dev:** the changelog bullets added since the previous tag, under the Unreleased heading each sits
  beneath. With none, it falls back to Conventional Commit subjects (`feat`, `fix`), which is the
  kind of note the changelog rules exist to prevent.

A standing footer follows, after a `---` line. The updater shows only what comes before that line,
and joins the notes of every release between the running version and the new one.

## Promoting `dev` to `main`

1. When a batch of dev builds has been tried, open a PR from `dev` to `main`.
2. In that PR, close the changelog: rename `## Unreleased` to `## vX.Y.Z — <YYYY-MM-DD>` and start a
   fresh, empty `## Unreleased` above it. Pick X.Y.Z by SemVer: dev builds were numbered after the
   patch bump, but a release with new features can be the next minor.
3. Merge it (a merge commit, so `main` and `dev` share history). That publishes `vX.Y.Z`. Then merge
   `main` back into `dev` so the next dev build counts from the new version.

## Manual runs

```sh
# Build everything for a branch without publishing (e.g. to try packaging changes)
gh workflow run release.yml --ref <branch> -f version=0.1.0-test.1 -f publish=false

# Re-publish a stable release from main (uploads replace assets; notes are refreshed)
gh workflow run release.yml --ref main

# Watch it
gh run watch "$(gh run list --workflow=release.yml -L1 --json databaseId --jq '.[0].databaseId')"
```

**Never set `version` in a `package.json` to cut a release.** The build stamps the version in
(`-c.extraMetadata.version` for the app, `BIZZI_VERSION` for the core and images).

## The installer

`scripts/install.sh` is the recommended install on macOS and Linux (README). People run it straight
from `main` (`raw.githubusercontent.com/neckbeard-io/bizzi/main/scripts/install.sh`), so a change to it
reaches users only when it is promoted. It finds the latest stable release through the
`/releases/latest` redirect rather than the API, which rate-limits shared addresses, so a release
must not be marked pre-release by mistake or the installer won't see it. `--dev` uses the API.

It downloads the self-updating asset for the machine (the macOS `.zip`, the Linux AppImage) and checks it
against the release's `SHA256SUMS.txt`. On macOS it also runs `codesign --verify` and clears the
quarantine attribute. `scripts/test-install.sh` (CI) covers version lookup, asset names and checksums.
Rename an asset and the installer breaks along with the updater.

## Local builds

```sh
npm ci
node scripts/release/build-desktop.ts --version 0.1.0-local   # this machine's platform/arch → dist/
```

On a Mac this takes a couple of minutes and produces the `.dmg` and `.zip`. Other platforms build
only on their own runners, because the core's native addons are installed for the host.

## The self-updater

`apps/desktop/src/update/` (main process), with the UI in Settings › Updates and a pill under the
sidebar header:

- Checks `api.github.com/repos/neckbeard-io/bizzi/releases` 15 s after launch and every 4 hours,
  unless automatic checks are off. A failed background check changes nothing on screen. A skipped
  version stays hidden from background checks but not from *Check now*.
- Downloads the asset for this install and checks it against the sha256 `digest` GitHub records for
  every uploaded asset.
- Installs, per install method:

| Method | Detected by | Install |
|---|---|---|
| macOS app | running from a writable `…/bizzi.app` | unzip, `codesign --verify`, quit; a detached script waits for exit, moves the old bundle aside, moves the new one in (puts the old one back on failure), relaunches |
| AppImage | `$APPIMAGE`, writable directory | replace the file (the running copy keeps the old inode), quit, relaunch |
| Windows | NSIS install | quit; PowerShell waits for exit, runs the installer with `/S --updated --force-run` |
| .deb | running from `/opt/` | open the package in the system installer (needs root); nothing restarts |
| unsupported | source checkout, App Translocation, read-only location | explains why; the release page link stays |

Quitting stops the core this app spawned (it drains for up to 30 s), so the swap waits for that. A
core started separately (launchd `bizzi serve`, Docker) keeps running its own version. The swap is
logged to `~/.bizzi/logs/update.log`.

## Signing, and what installers have to do about it

No build is signed with a paid certificate yet, so each OS pushes back on the first install. That's
expected; don't debug it as breakage.

- **macOS:** ad-hoc signed (`codesign --sign -`, verified in the build). A downloaded `.dmg` is
  quarantined, and macOS 15+ calls the app *damaged*. Fix it once after installing:
  `xattr -dr com.apple.quarantine /Applications/bizzi.app`. Self-updates aren't quarantined.
  A clean double-click install later needs a Developer ID certificate, Hardened Runtime and
  notarization. Only the signing step in `build-desktop.ts` changes, and the bundled `node` binary
  must be signed too.
- **Windows:** unsigned; SmartScreen warns (*More info* → *Run anyway*). Experimental: the core has
  had little testing on Windows.
- **Linux:** the AppImage needs `chmod +x`; the `.deb` installs with `sudo apt install ./file.deb`.
