import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

export type UpdateGitRunner = (root: string, args: string[]) => { ok: boolean; stdout: string };

export type UpdateCheckStatus =
  | {
      kind: "checked";
      updateAvailable: boolean;
      localCommit: string;
      remoteCommit: string;
      remote: string;
      branch: string;
    }
  | { kind: "no_tracking_branch"; updateAvailable: false; localCommit: string }
  /** Offline, not a git checkout, or the remote branch is gone. Not cached. */
  | { kind: "unavailable"; updateAvailable: false };

export const NO_TRACKING_BRANCH_NOTE = "no tracking branch";
export const CHECKED_TODAY_NOTE = "今天已检查过更新。";
export const UNAVAILABLE_NOTE = "无法检查更新（离线或非 git 安装），已跳过。";

export interface UpdateCheckResult {
  checked: boolean;
  updateAvailable: boolean;
  localCommit?: string;
  remoteCommit?: string;
  note?: string;
}

interface UpdateCheckCache {
  date?: string;
  updateAvailable?: boolean;
  remoteCommit?: string;
  note?: string;
}

export function updateCheckFile(): string {
  return path.join(getStateDir(), "update-check.json");
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

/** Split `<remote>/<branch>` using the configured remote names (either may contain "/"). */
function splitUpstream(upstream: string, remotes: string[]): { remote: string; branch: string } | null {
  const match = remotes
    .filter((remote) => remote && upstream.startsWith(`${remote}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!match) return null;
  const branch = upstream.slice(match.length + 1);
  return branch ? { remote: match, branch } : null;
}

/**
 * Compare HEAD with the tip of its tracking branch on the remote.
 * An update is available when that tip is missing locally or is not an ancestor of HEAD,
 * so local commits ahead of the remote never count as an update.
 */
export function checkForUpdate(repoRoot: string, runGit: UpdateGitRunner): UpdateCheckStatus {
  const local = runGit(repoRoot, ["rev-parse", "HEAD"]);
  const localCommit = firstLine(local.stdout);
  if (!local.ok || !localCommit) return { kind: "unavailable", updateAvailable: false };

  const upstream = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const remotes = runGit(repoRoot, ["remote"]);
  const target =
    upstream.ok && remotes.ok
      ? splitUpstream(
          firstLine(upstream.stdout),
          remotes.stdout.split(/\r?\n/).map((remote) => remote.trim())
        )
      : null;
  if (!target) return { kind: "no_tracking_branch", updateAvailable: false, localCommit };

  const ref = `refs/heads/${target.branch}`;
  const listed = runGit(repoRoot, ["ls-remote", target.remote, ref]);
  if (!listed.ok) return { kind: "unavailable", updateAvailable: false };
  const remoteCommit = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === ref)?.[0];
  if (!remoteCommit || !/^[0-9a-f]{7,64}$/i.test(remoteCommit)) {
    return { kind: "unavailable", updateAvailable: false };
  }

  const present = runGit(repoRoot, ["cat-file", "-e", `${remoteCommit}^{commit}`]).ok;
  const contained = present && runGit(repoRoot, ["merge-base", "--is-ancestor", remoteCommit, "HEAD"]).ok;
  return {
    kind: "checked",
    updateAvailable: !contained,
    localCommit,
    remoteCommit,
    remote: target.remote,
    branch: target.branch,
  };
}

function localDate(now: Date): string {
  return now.toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
}

function writeCache(cache: UpdateCheckCache): void {
  try {
    writeSecureJson(updateCheckFile(), cache);
  } catch {
    // best effort: a read-only state dir only means we check again next time
  }
}

/** Real check at most once per local day (unless forced); the result shape is the `update-check --json` payload. */
export function runUpdateCheck(opts: {
  repoRoot: string;
  runGit: UpdateGitRunner;
  force?: boolean;
  now?: Date;
}): UpdateCheckResult {
  const today = localDate(opts.now ?? new Date());
  const last = readJsonIfExists<UpdateCheckCache>(updateCheckFile()) ?? {};
  if (!opts.force && last.date === today) {
    return { checked: false, updateAvailable: last.updateAvailable === true, note: CHECKED_TODAY_NOTE };
  }

  const status = checkForUpdate(opts.repoRoot, opts.runGit);
  if (status.kind === "unavailable") {
    // Do not record the date so a transient failure does not suppress the daily check.
    return { checked: false, updateAvailable: false, note: UNAVAILABLE_NOTE };
  }
  if (status.kind === "no_tracking_branch") {
    writeCache({ date: today, updateAvailable: false, note: NO_TRACKING_BRANCH_NOTE });
    return { checked: true, updateAvailable: false, localCommit: status.localCommit, note: NO_TRACKING_BRANCH_NOTE };
  }
  writeCache({ date: today, updateAvailable: status.updateAvailable, remoteCommit: status.remoteCommit });
  return {
    checked: true,
    updateAvailable: status.updateAvailable,
    localCommit: status.localCommit,
    remoteCommit: status.remoteCommit,
  };
}
