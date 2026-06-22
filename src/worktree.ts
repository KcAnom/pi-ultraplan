import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Run git with an explicit argument array (never a shell string). */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface Worktree {
  dir: string;
  branch: string;
  cleanup(): void;
}

export function createWorktree(repoRoot: string, branch: string): Worktree {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-"));
  // git -C repoRoot worktree add <tmpDir> -b <branch> HEAD
  git(repoRoot, ["-C", repoRoot, "worktree", "add", tmpDir, "-b", branch, "HEAD"]);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      git(repoRoot, ["-C", repoRoot, "worktree", "remove", "--force", tmpDir]);
    } catch {
      // ignore: cleanup must never throw
    }
  };

  return { dir: tmpDir, branch, cleanup };
}

export function commitAll(dir: string, message: string): void {
  git(dir, ["-C", dir, "add", "-A"]);
  try {
    git(dir, [
      "-C",
      dir,
      "-c",
      "user.email=exec@pi",
      "-c",
      "user.name=pi-exec",
      "commit",
      "-m",
      message,
    ]);
  } catch (err) {
    // "nothing to commit" is not an error condition.
    const out = `${(err as { stdout?: unknown }).stdout ?? ""}${
      (err as { stderr?: unknown }).stderr ?? ""
    }`;
    if (/nothing to commit|no changes added|working tree clean/i.test(out)) {
      return;
    }
    throw err;
  }
}

export function formatPatch(dir: string, baseRef: string, outFile: string): void {
  const diff = git(dir, ["-C", dir, "diff", baseRef, "HEAD"]);
  fs.writeFileSync(outFile, diff);
}

export interface RemoteInfo {
  hasRemote: boolean;
  hasGh: boolean;
}

export function detectRemote(repoRoot: string): RemoteInfo {
  let hasRemote = false;
  let hasGh = false;
  try {
    const remotes = git(repoRoot, ["-C", repoRoot, "remote"]).trim();
    hasRemote = remotes.length > 0;
  } catch {
    hasRemote = false;
  }
  try {
    execFileSync("gh", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    hasGh = true;
  } catch {
    hasGh = false;
  }
  return { hasRemote, hasGh };
}

export function openPr(
  repoRoot: string,
  dir: string,
  branch: string,
  title: string,
  body: string,
): string {
  // Push branch from the worktree; throws on failure (caller handles fallback).
  git(dir, ["-C", dir, "push", "-u", "origin", branch]);
  const out = execFileSync(
    "gh",
    ["pr", "create", "--title", title, "--body", body, "--head", branch],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return out.trim();
}
