import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionRowAttention } from "../../lib/session-attention.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import {
  areUiSessionKeysEquivalent,
  isDashboardSessionKey,
  resolveUiSessionNavigationParentKey,
} from "../../lib/sessions/session-key.ts";
import { pendingSessionsYield, readHandoffDisplay } from "./chat-sessions-yield.ts";
import {
  endedWithoutFinishing,
  isSubagentsPanelSession,
  isUnfinishedSubagent,
  spawnedSubagentsRenderKey,
  type SubagentRoster,
} from "./chat-spawned-subagent.ts";

export type ChatSubagentWait = {
  /** The persisted end of the parent’s latest turn, independent of loaded history. */
  startedAt: number;
  /** The handed-off run, so the wait stays that run's live status. */
  runId?: string;
  /** Unfinished direct subagents; 0 until the pane's own child query has answered. */
  runningCount: number;
  /** Unfinished child sessions that are not subagents. */
  sessionCount?: number;
  /** Every child session the handoff waits on, named on the waiting line. */
  sessions: readonly ChatHandoffSession[];
};

/** A child session of a handoff, as its waiting line and resume rule list it. */
export type ChatHandoffSession = {
  key: string;
  label: string;
  status: "attention" | "running" | "failed" | "stopped" | "done";
  /** The child's own attention note, when it asked for the user. */
  note?: string;
};

const HANDOFF_STATUS_ORDER: readonly ChatHandoffSession["status"][] = [
  "attention",
  "failed",
  "running",
  "stopped",
  "done",
];

/**
 * The direct children (subagents and sessions alike) whose work overlapped a
 * handoff from `from` until `to` (still open without one). Attention first.
 * "Needs your input" is the child's own declared attention; the Gateway row
 * does not distinguish a child paused for a continuation from a finished one.
 */
export function listHandoffSessions(
  children: readonly GatewaySessionRow[],
  window: { from: number; to?: number },
  now = Date.now(),
): ChatHandoffSession[] {
  return children
    .filter((row) => {
      const started = row.createdAt ?? row.startedAt ?? 0;
      return (
        (window.to === undefined || started <= window.to) &&
        (row.status === "queued" || isUnfinishedSubagent(row) || (row.endedAt ?? 0) >= window.from)
      );
    })
    .toSorted(byLaunch)
    .map((row): ChatHandoffSession => {
      const attention = sessionRowAttention(row, now);
      const session: ChatHandoffSession = {
        key: row.key,
        label: resolveSessionDisplayName(row.key, row),
        status:
          row.status === "queued" || isUnfinishedSubagent(row)
            ? "running"
            : (endedWithoutFinishing(row) ?? "done"),
      };
      if (attention.kind === "agent") {
        session.status = "attention";
        session.note = attention.note;
      }
      return session;
    })
    .toSorted(
      (a, b) => HANDOFF_STATUS_ORDER.indexOf(a.status) - HANDOFF_STATUS_ORDER.indexOf(b.status),
    );
}

/** A resumed handoff's rule lists its children, so its row follows the roster. */
export function groupReadsHandoffRoster(group: { messages: readonly { message: unknown }[] }) {
  return group.messages.some(({ message }) => readHandoffDisplay(message)?.resumedAt !== undefined);
}

/** The children a resumed handoff waited on, from the pane's own child query. */
export function listResumedHandoffSessions(
  parentKey: string,
  roster: Pick<SubagentRoster, "subagentSessions" | "subagentSessionsHydrated">,
  handoff: { yieldedAt: number; resumedAt: number },
): ChatHandoffSession[] {
  return listHandoffSessions(directChildren({ key: parentKey }, roster), {
    from: handoff.yieldedAt,
    to: handoff.resumedAt,
  });
}

export type ChatSubagentActivity = {
  session: GatewaySessionRow;
  key: string;
  label: string;
  /** Details lists both active and settled children. */
  status: "queued" | "running" | "waiting" | "done" | "failed" | "stopped";
  activity?: string;
  /** The current run's plan steps; only the live observer stream reports them. */
  progress?: { completed: number; total: number };
  listed: boolean;
};

// A count or a name says which children are left, so it waits for the pane's
// own child query. Rows seeded from another list can hold only some of them.
export function directChildren(
  session: Pick<GatewaySessionRow, "key" | "childSessions">,
  roster: Pick<SubagentRoster, "subagentSessions" | "subagentSessionsHydrated">,
) {
  if (!roster.subagentSessionsHydrated) {
    return [];
  }
  return (roster.subagentSessions ?? []).filter((row) => {
    const parent = resolveUiSessionNavigationParentKey(row);
    return (
      !row.archived &&
      !areUiSessionKeysEquivalent(row.key, session.key) &&
      (parent
        ? areUiSessionKeysEquivalent(parent, session.key)
        : session.childSessions?.some((key) => areUiSessionKeysEquivalent(key, row.key)))
    );
  });
}

type SubagentSession = SubagentRoster & { selectedSession: GatewaySessionRow | undefined };

function unfinishedChildren(input: SubagentSession) {
  const session = input.selectedSession;
  if (!session || session.archived || session.hasActiveSubagentRun !== true) {
    return [];
  }
  return directChildren(session, input).filter(
    (row) => row.status === "queued" || isUnfinishedSubagent(row),
  );
}

/** Header counts need child membership, not transcript handoffs or activity presentation. */
export function countRunningSubagents(input: SubagentSession): number {
  return unfinishedChildren(input).filter((row) => !isDashboardSessionKey(row.key)).length;
}

// Launch order stays stable as activity updates reorder the source roster.
function byLaunch(a: GatewaySessionRow, b: GatewaySessionRow) {
  return (
    (a.createdAt ?? a.startedAt ?? 0) - (b.createdAt ?? b.startedAt ?? 0) ||
    a.key.localeCompare(b.key)
  );
}

function unfinishedStatus(row: GatewaySessionRow): ChatSubagentActivity["status"] {
  return row.status === "queued" ? "queued" : isSessionRunStateActive(row) ? "running" : "waiting";
}

/**
 * Every direct subagent the pane's own child query returned, finished ones
 * included. Dashboard children are sessions in their own right and are left out.
 */
export function listSubagents(input: SubagentSession): ChatSubagentActivity[] {
  const session = input.selectedSession;
  if (!session || session.archived) {
    return [];
  }
  return directChildren(session, input)
    .filter((row) => !isDashboardSessionKey(row.key))
    .toSorted(byLaunch)
    .map((row): ChatSubagentActivity => {
      const status =
        row.status === "queued" || isUnfinishedSubagent(row)
          ? unfinishedStatus(row)
          : (endedWithoutFinishing(row) ?? "done");
      const digest = row.observerDigest;
      return {
        session: row,
        key: row.key,
        label: resolveSessionDisplayName(row.key, row),
        status,
        // A retained headline from the previous run is not current activity.
        activity:
          status === "running" && digest?.runId && row.activeRunIds?.includes(digest.runId)
            ? digest.headline.trim() || undefined
            : undefined,
        listed: isSubagentsPanelSession(row),
      };
    });
}

/**
 * Everything the transcript reads from the session's subagent roster: the
 * wait and where it is placed, the running count, and the keys that tell
 * memoized rows when any of it changed.
 */
export function projectSubagentStatus(
  input: SubagentSession & {
    runActive?: boolean;
    runWorking?: boolean;
    messages: readonly unknown[];
  },
  searchFiltering: boolean,
) {
  const session = input.selectedSession;
  const eligible = session && !session.archived && session.hasActiveSubagentRun === true;
  // Descendant activity alone is not a parent wait: plugin-owned children can
  // belong to a session that has never executed. Every settled parent turn has
  // a lifecycle end; a partial row must not invent that boundary from transcript text.
  const parentIdle =
    eligible && !input.runActive && !input.runWorking && !isSessionRunStateActive(session);
  const endedAt = session?.endedAt;
  const waitStartedAt =
    parentIdle &&
    typeof endedAt === "number" &&
    Number.isFinite(endedAt) &&
    endedAt > 0 &&
    endedAt >= (session?.startedAt ?? 0)
      ? endedAt
      : null;
  const pending = waitStartedAt !== null ? pendingSessionsYield(input.messages) : null;
  const yieldedAt = pending?.timestamp ?? null;
  const handoffRunId =
    yieldedAt !== null &&
    typeof session?.startedAt === "number" &&
    yieldedAt > session.startedAt &&
    waitStartedAt !== null &&
    yieldedAt <= waitStartedAt
      ? pending?.runId
      : undefined;
  const unfinished = unfinishedChildren(input);
  // Dashboard children count as sessions in the Subagents count; the waiting
  // line names every child the handoff waits on.
  const children = unfinished.filter((row) => !isDashboardSessionKey(row.key));
  const running = children.length;
  const hydrated = input.subagentSessionsHydrated && !input.subagentSessionsPending;
  // A hydrated roster with no unfinished children ends the wait.
  const wait: ChatSubagentWait | null =
    waitStartedAt !== null && (!hydrated || unfinished.length > 0)
      ? {
          startedAt: waitStartedAt,
          ...(handoffRunId ? { runId: handoffRunId } : {}),
          runningCount: hydrated ? running : 0,
          ...(hydrated && unfinished.length > running
            ? { sessionCount: unfinished.length - running }
            : {}),
          sessions:
            hydrated && session
              ? listHandoffSessions(directChildren(session, input), {
                  from: yieldedAt ?? waitStartedAt,
                })
              : [],
        }
      : null;
  // The line can lead to the Subagents panel only when that panel lists every
  // subagent it mentions.
  const listed =
    (wait !== null || running > 0) &&
    unfinished.every((row) => isDashboardSessionKey(row.key) || isSubagentsPanelSession(row));
  return {
    wait,
    // Only a loaded handoff places the wait inside its run; search omits it.
    placedWait:
      !searchFiltering && wait?.runId
        ? { startedAt: wait.startedAt, runId: wait.runId }
        : undefined,
    running,
    listed,
    // Key only the working line's facts so unrelated roster patches stay memoized.
    statusKey: JSON.stringify(
      wait
        ? [wait.startedAt, wait.runId, wait.runningCount, wait.sessionCount, wait.sessions, listed]
        : [running, listed],
    ),
    // Seeded rows can already match; rows that list children wait for the pane's own query.
    rowsKey: `${input.subagentSessionsHydrated ? "hydrated" : "seeded"}\n${spawnedSubagentsRenderKey(input.subagentSessions)}`,
  };
}
