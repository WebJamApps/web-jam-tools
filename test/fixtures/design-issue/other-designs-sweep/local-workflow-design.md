# Local Build Workflow — Design

## Revision History

| Version | Date       | Epic / Issue                                                               | Summary               |
| ------- | ---------- | -------------------------------------------------------------------------- | --------------------- |
| 1.0.0   | 2026-10-20 | [Local build check](https://github.com/WebJamApps/web-jam-tools/issues/30) | Added workflow steps. |

## Local workflow

When a Hydrogen run opens a pull request, run the local test suite before posting the summary
comment.

## Both surfaces

Identical on Claude Code, agy/Antigravity, and Codex.

## Load-bearing premises

| Premise                         | Proof                     | Proved     |
| ------------------------------- | ------------------------- | ---------- |
| Local test command runs offline | Executed `deno --version` | 2099-01-01 |
