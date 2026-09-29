import type {
  ZCodeAutomation,
  ZCodeAutomationRunOutcome,
  ZCodeAutomationTrigger,
} from "@zcode/shared";
import { automationBudgetWindowBucket } from "@zcode/services/node";

interface CronRunLifecycleRepo {
  ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): Promise<void>;
  markRunOutcome(runId: string, outcome: ZCodeAutomationRunOutcome, error?: string): Promise<void>;
  markRunDispatch(params: {
    runId: string;
    dispatchStatus: "failed_to_dispatch";
    error: string;
  }): Promise<void>;
  touchManualClaim(automationId: string, workspaceKey: string): Promise<void>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

interface CronRunLifecycleIdentity {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: ZCodeAutomationTrigger;
}

type LogWarn = (message: string, error: unknown) => void;

const MANUAL_CLAIM_HEARTBEAT_MS = 60_000;

export function startManualClaimHeartbeat(
  params: Pick<CronRunLifecycleIdentity, "automationId" | "runId" | "workspaceKey"> & {
    repo: Pick<CronRunLifecycleRepo, "touchManualClaim">;
    logWarn: LogWarn;
    intervalMs?: number;
  },
): { dispose(): void } {
  const timer = setInterval(() => {
    void params.repo
      .touchManualClaim(params.automationId, params.workspaceKey)
      .catch((error) =>
        params.logWarn(
          `续租 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
          error,
        ),
      );
  }, params.intervalMs ?? MANUAL_CLAIM_HEARTBEAT_MS);
  return { dispose: () => clearInterval(timer) };
}

export async function recordCronRunOutcomeBestEffort(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    outcome: ZCodeAutomationRunOutcome;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    await params.repo.ensureRunClaimed(params);
    await params.repo.markRunOutcome(params.runId, params.outcome, params.error);
  } catch (error) {
    params.logWarn(
      `回写定时任务运行结果失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

async function releaseManualClaimBestEffort(
  params: Pick<CronRunLifecycleIdentity, "automationId" | "runId" | "workspaceKey"> & {
    repo: Pick<CronRunLifecycleRepo, "releaseManualClaim">;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    await params.repo.releaseManualClaim(params.automationId, params.workspaceKey);
  } catch (error) {
    params.logWarn(
      `释放 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

/** 派发失败清理永不覆盖调用方持有的原始 dispatch error。 */
export async function settleManualDispatchFailureBestEffort(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    dispatchError: unknown;
    logWarn: LogWarn;
  },
): Promise<void> {
  const errorMessage =
    params.dispatchError instanceof Error
      ? params.dispatchError.message
      : String(params.dispatchError);
  try {
    await params.repo.markRunDispatch({
      runId: params.runId,
      dispatchStatus: "failed_to_dispatch",
      error: errorMessage,
    });
  } catch (error) {
    params.logWarn(
      `回写 manual automation 派发失败状态失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
  await releaseManualClaimBestEffort(params);
}

/** manual claim 覆盖 queue 等待和 turn 执行，只能在真实终态后释放。 */
export async function settleCronRunTerminalOutcome(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    outcome: Exclude<ZCodeAutomationRunOutcome, "running">;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  await recordCronRunOutcomeBestEffort(params);
  if (params.trigger !== "manual") return;
  await releaseManualClaimBestEffort(params);
}

/** spend 记账所需的窄 repo 面；AutomationRepo 结构化满足。 */
interface CronRunSpendRepo {
  get(automationId: string): Promise<Pick<ZCodeAutomation, "budget"> | null>;
  recordRunSpend(params: {
    automationId: string;
    runId: string;
    bucket: string;
    totalTokens: number;
    recordedAt: number;
  }): Promise<void>;
}

/** spend 记账所需的用量查询面；IZcodeAgentService 结构化满足。 */
export interface CronRunSpendUsageSource {
  getTaskTokenUsage(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    traceId?: string;
  }): Promise<{ totalTokens: number }>;
}

/**
 * run 终态后按 traceId 回写该 run 的 token 用量（预算 spend 的事实来源）。
 * 仅配置了预算的 automation 记账；失败只告警——under-count 安全，over-count 永不发生。
 * 见 packages/services/specs/automation-budget-control.md 的事件顺序。
 */
export async function recordCronRunSpendBestEffort(
  params: CronRunLifecycleIdentity & {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    repo: CronRunSpendRepo;
    usage: CronRunSpendUsageSource | null;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    if (!params.usage) return;
    const automation = await params.repo.get(params.automationId);
    if (!automation?.budget) return;
    const usage = await params.usage.getTaskTokenUsage({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      sessionId: params.sessionId,
      traceId: params.runId,
    });
    await params.repo.recordRunSpend({
      automationId: params.automationId,
      runId: params.runId,
      bucket: automationBudgetWindowBucket(automation.budget.window, Date.now()),
      totalTokens: usage.totalTokens,
      recordedAt: Date.now(),
    });
  } catch (error) {
    params.logWarn(
      `记录定时任务 token 用量失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}
