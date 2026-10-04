// Shared literal cases for web-jam-tools#1223 "hooks: push guards treat a git
// command carrying a global option the same as the plain command".
// Each row: [command, expected exit code of block-dangerous-git-deploy.sh,
// expected exit code of block-irreversible-operations.sh]. 2 = blocked.

export type GuardCase = [command: string, deployExit: number, irreversibleExit: number];

/**
 * Numbered rows of the requirements file's expected-decisions table, in order:
 * 1-24 a git global option before the subcommand; 25-32 the wider option list
 * and an unrecognised option; 33-41 protected-branch spellings; 42-60 alias
 * definitions and the config routes that carry one.
 */
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
  ["git --attr-source HEAD push origin dev", 2, 0],
  ["git --attr-source=HEAD push origin main", 2, 0],
  ["git --no-literal-pathspecs push origin dev", 2, 0],
  ["git --shallow-file /dev/null push origin --delete feat", 2, 2],
  ["git -C /tmp/x --attr-source HEAD push --force origin feat", 2, 0],
  ["git --made-up-option push origin feat", 2, 0],
  ["git -C /tmp/x --made-up-option value push origin feat", 2, 0],
  ["git --made-up-option status", 0, 0],
  ["git push origin +dev", 2, 0],
  ["git push origin refs/heads/dev", 2, 0],
  ["git push origin heads/dev", 2, 0],
  ["git push origin HEAD:refs/heads/dev", 2, 0],
  ["git push origin feat:refs/heads/main", 2, 0],
  ["git push origin +HEAD:heads/main", 2, 0],
  ["git -C /tmp/x push origin HEAD:refs/heads/dev", 2, 0],
  ["git push origin dev:feat", 0, 0],
  ["git push origin refs/heads/feat", 0, 0],
  ["git -c alias.p=push p origin dev", 2, 0],
  ["git -c alias.p=push p origin --delete feat", 2, 0],
  ["git -c ALIAS.p=push p --force origin feat", 2, 0],
  ["git --config-env=alias.p=X p origin --delete feat", 2, 0],
  ["git --config-env alias.p=X p origin feat", 2, 0],
  [
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin --delete feat",
    2,
    0,
  ],
  ["git config alias.p push", 2, 0],
  ["git config --global alias.p push", 2, 0],
  ["git -C /tmp/x config alias.p push", 2, 0],
  ["git config user.name", 0, 0],
  ["git -c include.path=/tmp/a.cfg p origin --delete feat", 2, 0],
  ["git -c includeIf.gitdir:/tmp/x/.path=/tmp/a.cfg p origin feat", 2, 0],
  ["git --config-env=include.path=X p origin feat", 2, 0],
  ["GIT_CONFIG_GLOBAL=/tmp/a.cfg git p origin --delete feat", 2, 0],
  ["GIT_CONFIG_SYSTEM=/tmp/a.cfg git p origin feat", 2, 0],
  [`GIT_CONFIG_PARAMETERS="'alias.p=push'" git p origin feat`, 2, 0],
  ["GIT_PAGER=cat git log -1", 0, 0],
  [
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=include.path GIT_CONFIG_VALUE_0=/tmp/a.cfg git p origin feat",
    2,
    0,
  ],
  ["git config include.path /tmp/a.cfg", 2, 0],
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
