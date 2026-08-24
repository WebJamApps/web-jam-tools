# Manual Verification Runbook: Non Sequential Steps

Runbook with non-consecutive step numbering.

## STEP 1: First Step

**Command:**

```sh
deno task test
```

**What this proves:** Verifies tests.

**Expected result:** Tests pass.

## STEP 3: Third Step (Skipped Step 2)

**Command:**

```sh
deno task lint
```

**What this proves:** Verifies linter.

**Expected result:** Linter passes.
