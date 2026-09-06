# Manual Verification Runbook: Command With Placeholders

Runbook with placeholder tokens in command block.

## STEP 1: Configure Secret

**Command:**

```sh
deno task design:gate1 <doc.md> --api-key YOUR_API_KEY
```

**What this proves:** Verifies Gate 1 execution.

**Expected result:** Gate 1 passes.
