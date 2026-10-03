// Shared literal cases for web-jam-tools#1223 "hooks: push guards treat a git
// command carrying a global option the same as the plain command".
// Each row: [command, expected exit code of block-dangerous-git-deploy.sh,
// expected exit code of block-irreversible-operations.sh]. 2 = blocked.

export type GuardCase = [command: string, deployExit: number, irreversibleExit: number];

/** Numbered rows 1-24: a git global option before the subcommand. */
export const GLOBAL_OPTION_CASES: GuardCase[] = [
  ["git -C /tmp/x push origin dev", 2, 0],
  ["git -c user.name=x push origin dev", 2, 0],
  ["git --git-dir /tmp/x/.git push origin dev", 2, 0],
  ["git --git-dir=/tmp/x/.git push origin main", 2, 0],
  ["git --work-tree /tmp/x push origin --delete feat", 2, 2],
  ["git --work-tree=/tmp/x push origin :feat", 2, 2],
  ["git --no-pager push origin dev", 2, 0],
  ["git -C /tmp/x -c a=b push -d origin feat", 2, 2],
  [`git -C "/tmp/my repo" push origin dev`, 2, 0],
  ["cd /tmp && git -C /tmp/x push origin --delete feat", 2, 2],
  ["git --namespace foo push origin main", 2, 0],
  ["git -P --no-optional-locks push origin :feat", 2, 2],
  ["git -C /tmp/x push --force origin feat", 2, 0],
  ["git -c a=b push -f origin feat", 2, 0],
  ["git -C /tmp/x push --force-with-lease origin feat", 2, 0],
  ["git --git-dir=/tmp/x/.git push --mirror", 2, 0],
  ["git -C /tmp/x push --prune origin", 2, 0],
  ["git -C /tmp/x push origin feat", 0, 0],
  ["git -C /tmp/x push -u origin claude/123-some-branch", 0, 0],
  ["git -C /tmp/x status", 0, 0],
  ["git -C /tmp/x log --oneline -5", 0, 0],
  ["git -c core.pager=cat log -1", 0, 0],
  ["git -C /tmp/x fetch origin", 0, 0],
  ["git -C /tmp/x worktree add /tmp/y origin/feat", 0, 0],
];

/** Plain commands whose decision must not change. */
export const PLAIN_REGRESSION_CASES: GuardCase[] = [
  ["git push origin dev", 2, 0],
  ["git push origin main", 2, 0],
  ["git push origin --delete feat", 2, 2],
  ["git push -d origin feat", 2, 2],
  ["git push origin :feat", 2, 2],
  ["git push origin feat", 0, 0],
  ["git push --force origin feat", 0, 0],
  ["git status", 0, 0],
  ["cd /tmp && git push origin dev", 2, 0],
];
