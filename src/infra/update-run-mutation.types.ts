import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";
import type { UpdateResultPayload } from "./update-result-payload.js";
import type {
  InterruptedUpdateSettlement,
  InterruptedUpdateSettlementResult,
} from "./update-run-interruption-contract.js";
import type { UpdateRunReconciliationOperations } from "./update-run-reconciliation.types.js";
import type {
  CreateUpdateRunInput,
  FinishUpdateRunInput,
  UpdateRunDiagnostics,
  UpdateRunPhase,
  UpdateRunRecord,
  UpdateRunStep,
} from "./update-run-record.js";
import type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";

export type UpdateRunRedactionFacts = {
  effectiveHome: string;
  home?: string;
  userProfile?: string;
  configPath?: string;
};

export type UpdateRunPatch = Partial<
  Pick<UpdateRunRecord, "origin" | "target" | "before" | "after" | "trigger">
>;

export type UpdateRunPhasePatch = UpdateRunPatch & { step?: UpdateRunStep };

type UpdateRunWriteGeneration = { path: string; before: string; after: string | null };

export type UpdateRunWriteInput = {
  runId: string;
  redactionFacts: UpdateRunRedactionFacts;
  requireNoRecovery?: true;
  busyTimeoutMs?: number;
  redactPaths?: readonly string[];
  writeGeneration?: Pick<UpdateRunWriteGeneration, "path" | "before">;
};

type UpdateRunWriteResult =
  | { kind: "recorded"; record: UpdateRunRecord; updateResult?: UpdateResultPayload }
  | { kind: "bookkeeping-skipped" }
  | { kind: "recovery-required"; recovery: UpdateRecoveryRecord };

type UpdateRunWriteReply = UpdateRunWriteResult & { writeGeneration?: UpdateRunWriteGeneration };

export type UpdateRunWriteOperations = {
  "updateRuns.create": {
    input: UpdateRunWriteInput & { run: CreateUpdateRunInput };
    output: UpdateRunWriteReply;
  };
  "updateRuns.finish": {
    input: UpdateRunWriteInput & { result: FinishUpdateRunInput };
    output: UpdateRunWriteReply;
  };
  "updateRuns.recordVerification": {
    input: UpdateRunWriteInput & {
      verification: UpdateRunRecord["verification"];
      onlyIfRunning?: true;
    };
    output: UpdateRunWriteReply;
  };
  "updateRuns.recordDiagnostics": {
    input: UpdateRunWriteInput & { diagnostics: UpdateRunDiagnostics; preserveRecovery?: true };
    output: UpdateRunWriteReply;
  };
  "updateRuns.recordStep": {
    input: UpdateRunWriteInput & {
      step: UpdateRunStep & { reason?: string };
    };
    output: UpdateRunWriteReply;
  };
  "updateRuns.recordPhase": {
    input: UpdateRunWriteInput & { phase: UpdateRunPhase; patch: UpdateRunPhasePatch };
    output: UpdateRunWriteReply;
  };
};

export type UpdateRunWriteCommand = SqliteWorkerCommand<UpdateRunWriteOperations>;

export type UpdateRunWorkerOperations = UpdateRunWriteOperations &
  UpdateRunReconciliationOperations & {
    "updateRuns.reconcileInterrupted": {
      input: InterruptedUpdateSettlement;
      output: InterruptedUpdateSettlementResult;
    };
  };
