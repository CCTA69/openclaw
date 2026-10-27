import { execFile } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { WorkerTaskPoolCore } from "@openclaw/worker-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNestedGitEnv } from "../../test/helpers/temp-repo.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import * as diagnostics from "./diagnostic-events.js";
import type { GitWorkerCommand } from "./git-worker-contract.js";
import { runGitWorkerOperation } from "./git-worker.js";
import { getTrackedWorkerLifecycleSnapshot } from "./worker-cpu.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 3,
}));

const logs = vi.hoisted(() => ({ info: vi.fn(), isEnabled: () => true }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      ...(subsystem === "git/worker" ? logs : {}),
    }),
  };
});

afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  vi.useRealTimers();
  vi.restoreAllMocks();
  logs.info.mockClear();
  tempDirs.cleanup();
});

const tempDirs = createTempDirTracker();
const execFileAsync = promisify(execFile);

type IdleCase = {
  owner: string;
  floor: boolean;
  gitRepo?: true;
  command: (root: string) => GitWorkerCommand;
  expected: unknown;
};

const idleCases: IdleCase[] = [
  {
    owner: "reads",
    floor: false,
    command: () => ({ type: "repository.identities", input: { roots: [] } }),
    expected: [],
  },
  {
    owner: "summary",
    floor: false,
    gitRepo: true,
    command: (cwd) => ({ type: "checkout.diff", input: { cwd, summaryOnly: true } }),
    expected: expect.objectContaining({ files: [], additions: 0, deletions: 0 }),
  },
  {
    owner: "content",
    floor: true,
    gitRepo: true,
    command: (cwd) => ({ type: "checkout.diff", input: { cwd } }),
    expected: expect.objectContaining({ files: [], additions: 0, deletions: 0 }),
  },
  {
    owner: "workspace",
    floor: true,
    command: (root) => ({
      type: "workspace.manifest.nodes",
      input: { payload: new TextEncoder().encode(JSON.stringify({ root, paths: [] })) },
    }),
    expected: {
      value: [],
      hashes: [],
      metrics: { contentHashCount: 0, memoHitCount: 0 },
    },
  },
  {
    owner: "worktrees",
    floor: false,
    command: (root) => ({ type: "worktree.directory-size", input: { root } }),
    expected: 0,
  },
  {
    owner: "worktreeMaintenance",
    floor: false,
    command: () => ({ type: "worktree.eviction-repositories", input: { repoRoots: [] } }),
    expected: [],
  },
];

it.each(idleCases)("preserves the $owner idle policy (floor=$floor)", async (entry) => {
  const root = tempDirs.make("openclaw-git-idle-policy-");
  if (entry.gitRepo) {
    const options = { cwd: root, env: createNestedGitEnv() };
    await execFileAsync("git", ["init", "--template=", "--initial-branch=main"], options);
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-m",
        "synthetic",
      ],
      options,
    );
  }
  const lifecycle = () =>
    getTrackedWorkerLifecycleSnapshot().workerLifecycle.find(
      (worker) => worker.script === "git-operation.worker.js",
    );
  const starts = () => lifecycle()?.started ?? 0;
  const exits = (reason: string) =>
    lifecycle()?.retired.find((retirement) => retirement.reason === reason)?.count ?? 0;
  const live = () => {
    const row = lifecycle();
    return row
      ? row.started - row.retired.reduce((sum, retirement) => sum + retirement.count, 0)
      : 0;
  };
  const before = starts();
  const idleBefore = exits("idle_timeout");
  const run = async () => {
    expect(await runGitWorkerOperation(entry.command(root))).toEqual(entry.expected);
  };
  // Existing mock availableParallelism=3 makes reads a two-worker pool.
  const initialWorkers = entry.owner === "reads" ? 2 : 1;
  const poll = () => Promise.all(Array.from({ length: initialWorkers }, run));

  expect(live()).toBe(0);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  await poll();
  expect(starts() - before).toBe(initialWorkers);
  if (entry.owner === "reads") {
    for (const pollMs of [45_000, 60_001, 90_000]) {
      await vi.advanceTimersByTimeAsync(pollMs);
      await poll();
      expect(starts() - before).toBe(initialWorkers);
    }
  }

  await vi.advanceTimersByTimeAsync(entry.owner === "reads" ? 120_001 : 60_001);
  if (!entry.floor) {
    await vi.waitFor(() => expect(exits("idle_timeout") - idleBefore).toBe(initialWorkers));
    expect(live()).toBe(0);
  }
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(starts() - before).toBe(initialWorkers); // Retirement never replenishes eagerly.
  expect(live()).toBe(entry.floor ? 1 : 0);
  await run();
  expect(starts() - before).toBe(initialWorkers + Number(!entry.floor));

  if (entry.floor) {
    const pressureBefore = exits("memory_pressure");
    const startsBeforePressure = starts();
    channel("openclaw.memory.critical").publish({});
    await vi.waitFor(() => expect(exits("memory_pressure") - pressureBefore).toBe(1));
    expect(live()).toBe(0);
    expect(starts()).toBe(startsBeforePressure);
    await run();
    expect(starts()).toBe(startsBeforePressure + 1);
  }
  await drainGlobalSingletonLifecycleState();
  expect(live()).toBe(0);
});

const cwd = "/private/checkouts/diagnostic-fixture";
const branchFacts = {
  type: "pull-request.branch-facts",
  input: {
    root: cwd,
    branch: "fixture",
    mergedHeads: [],
    refreshIndex: true,
    comparison: { statsBase: null, creatable: true, equalPushedTips: false, complete: true },
  },
} as const;
const checkoutDiff = { type: "checkout.diff", input: { cwd, summaryOnly: true } } as const;

it.each([
  [
    branchFacts,
    ["--no-lazy-fetch", "-c", "diff.private=secret", "diff", "--shortstat"],
    "diff",
    "--shortstat",
  ],
  [branchFacts, ["diff", "--patch", "--no-index"], "diff", "--no-index"],
  [branchFacts, ["private-command"], "other", undefined],
  [checkoutDiff, ["diff", "--raw"], "diff", "--raw"],
] as const)(
  "prints %j attribution and a %j %s %s timeout in the journal message",
  async (request, slowArgs, command, diffMode) => {
    const operation = request.type;
    let clock = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(diagnostics, "areDiagnosticsEnabledForProcess").mockReturnValue(true);
    const privateRef = "refs/heads/private-branch";
    const value =
      operation === "checkout.diff"
        ? { files: [], additions: 0, deletions: 0 }
        : { creatable: true, stats: null };
    const run = vi.fn(async (_cwd: string, args: string[]) => {
      const timeout = args[0] !== "merge-base";
      clock += timeout ? 120_000 : 50;
      return {
        stdout: Buffer.from(timeout ? "" : "fixture output"),
        stderr: Buffer.from(timeout ? "private failure" : ""),
        code: timeout ? null : 0,
        signal: null,
        killed: timeout,
        termination: timeout ? ("timeout" as const) : ("exit" as const),
        timeoutMs: 120_000,
        windowsEncoding: null,
      };
    });
    // Exercise the real broker and logger without a worker boot or wall-clock timeout.
    vi.spyOn(WorkerTaskPoolCore.prototype, "run").mockImplementation(async (input, options) => {
      clock += 400;
      if (typeof input === "function") {
        await input();
      }
      clock += 100;
      const signal = new AbortController().signal;
      for (const args of [
        ["merge-base", privateRef, "HEAD"],
        [...slowArgs, privateRef],
      ]) {
        await options.onRequest!(
          {
            type: "git.batch",
            input: { requests: [{ type: "git.text", input: { cwd, args, options: {} } }] },
          },
          { signal, yieldSignal: signal },
        );
      }
      return { ok: true, value };
    });
    await expect(
      runGitWorkerOperation(request, { git: { text: run, buffered: run } }),
    ).resolves.toEqual(value);

    expect(logs.info).toHaveBeenCalledOnce();
    const [message, fields] = logs.info.mock.calls[0]!;
    expect(message).toMatch(/^slow Git content read \{/);
    expect(JSON.parse(message.slice("slow Git content read ".length))).toEqual(fields);
    expect(fields).toMatchObject({
      operation,
      ...(operation === "checkout.diff" ? { scope: "all", summaryOnly: true } : {}),
      checkoutId: expect.stringMatching(/^[a-f0-9]{16}$/),
      checkoutClass: operation === "checkout.diff" ? "unspecified" : "managed",
      workerQueueWaitMs: 400,
      durationMs: 120_550,
      gitTimeoutCount: 1,
      slowestGitCommand: {
        command,
        ...(diffMode ? { diffMode } : {}),
        durationMs: 120_000,
        termination: "timeout",
      },
      outcome: "returned",
    });
    if (operation !== "checkout.diff") {
      expect(fields).not.toHaveProperty("scope");
      expect(fields).not.toHaveProperty("summaryOnly");
    }
    const journal = `${message}\n${JSON.stringify(fields)}`;
    for (const privateValue of [
      cwd,
      privateRef,
      "secret",
      "private failure",
      "fixture output",
      "private-command",
    ]) {
      expect(journal).not.toContain(privateValue);
    }
  },
);
