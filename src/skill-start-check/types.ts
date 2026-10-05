export type ToolTarget = "claude" | "agy" | "all";

export type CheckOutcome = "PASS" | "FAIL";

export type CheckMode = "by_name" | "on_its_own";

export interface SkillStartCheckPrompts {
  by_name: string;
  on_its_own: string;
}

export interface CheckResult {
  tool: "claude" | "agy";
  skillName: string;
  mode: CheckMode;
  outcome: CheckOutcome;
  reason?: string;
  detail?: string;
}

export interface SkillStartCheckOptions {
  tool?: ToolTarget;
  skillsDir?: string;
  workDir?: string;
  timeoutMs?: number;
  claudeTimeoutMs?: number;
  agyTimeoutMs?: number;
}
