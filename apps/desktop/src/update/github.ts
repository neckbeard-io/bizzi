// GitHub Releases as the update feed: which release a channel should move to, its notes, and the
// file for this install. Pure functions plus one fetch; the controller owns the state.

import type { InstallMethod, UpdateChannel } from '../shared/update.ts';
import { compareSemver, isPrerelease } from './semver.ts';

export const REPO = 'neckbeard-io/bizzi';
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=50`;
export const USER_AGENT = 'bizzi-updater';

export interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
  /** `sha256:<hex>`; GitHub computes it for every uploaded asset. */
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  html_url: string;
  published_at?: string | null;
  prerelease: boolean;
  draft: boolean;
  assets: GitHubAsset[];
}

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export async function fetchReleases(fetchFn: Fetch, signal?: AbortSignal): Promise<GitHubRelease[]> {
  const res = await fetchFn(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28' },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new HttpError(res.status);
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as GitHubRelease[]) : [];
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** A sentence for the UI in place of a raw error. */
export function describeFailure(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 403 || err.status === 429) return 'GitHub is limiting update checks right now. Try again later.';
    return `GitHub returned an error (HTTP ${err.status}). Try again later.`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network/i.test(msg)) return "Couldn't reach GitHub. Check your connection and try again.";
  return msg;
}

export function versionOf(tag: string): string {
  return tag.replace(/^v/, '');
}

/** The release body up to the standing footer (`---`), which repeats install instructions. */
export function releaseNotes(body: string | null | undefined): string {
  const text = (body ?? '').replace(/\r\n/g, '\n');
  const cut = text.search(/\n---\s*(\n|$)/);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/** Releases the channel offers, newest first. Stable ignores pre-releases; Dev takes everything. */
export function channelReleases(releases: GitHubRelease[], channel: UpdateChannel): GitHubRelease[] {
  return releases
    .filter((r) => !r.draft && (channel === 'dev' || (!r.prerelease && !isPrerelease(versionOf(r.tag_name)))))
    .sort((a, b) => compareSemver(versionOf(b.tag_name), versionOf(a.tag_name)));
}

export interface Candidate {
  release: GitHubRelease;
  /** Notes of every offered release newer than `current`, newest first, each under its tag. */
  notes: string;
}

/** The newest release on the channel, or null when there is none. Newer may still be false. */
export function latestFor(releases: GitHubRelease[], channel: UpdateChannel, current: string): Candidate | null {
  const offered = channelReleases(releases, channel);
  const latest = offered[0];
  if (!latest) return null;
  const newer = offered.filter((r) => compareSemver(versionOf(r.tag_name), current) > 0);
  const notes =
    newer.length > 1
      ? newer.map((r) => `## ${r.tag_name}\n${releaseNotes(r.body) || 'Internal improvements and bug fixes.'}`).join('\n\n')
      : releaseNotes(latest.body);
  return { release: latest, notes };
}

/** File-name suffix of the asset each install method updates from (release.yml names them). */
export function assetSuffix(method: InstallMethod, arch: string): string | null {
  switch (method) {
    case 'mac-app':
      return `-macos-${arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
    case 'appimage':
      return `-linux-${arch === 'arm64' ? 'arm64' : 'x86_64'}.AppImage`;
    case 'deb':
      return `-linux-${arch === 'arm64' ? 'arm64' : 'amd64'}.deb`;
    case 'nsis':
      return '-windows-x64-setup.exe';
    case 'unsupported':
      return null;
  }
}

export function matchAsset(release: GitHubRelease, method: InstallMethod, arch: string): GitHubAsset | null {
  const suffix = assetSuffix(method, arch);
  return suffix ? (release.assets.find((a) => a.name.endsWith(suffix)) ?? null) : null;
}
