import { execFileSync } from "node:child_process";

export interface RepoSnapshot {
  root: string;
  sha: string | null;
  branch: string | null;
  dirty: boolean;
}

export function repoSnapshot(root: string): RepoSnapshot {
  try {
    const run = (args: string[]): string =>
      execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();

    const sha = run(["rev-parse", "HEAD"]);
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
    const dirty = run(["status", "--porcelain"]).length > 0;

    return { root, sha, branch, dirty };
  } catch {
    return { root, sha: null, branch: null, dirty: false };
  }
}
