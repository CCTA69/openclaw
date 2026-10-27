import { expect, it } from "vitest";
import {
  createMockServerTestHarness,
  makeUserInput,
  postResponses,
  requireRecord,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

function readSseEvents(body: string) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => requireRecord(JSON.parse(line.slice(6)), "SSE event"));
}

it("fails the fallback parent completion so direct delivery owns the child result", async () => {
  const event = [
    "[Internal task completion event]",
    "source: subagent",
    "task: qa-terminal-fallback",
    "status: completed; ready for parent review",
    "",
    "QA-SUBAGENT-TERMINAL-FALLBACK-OK",
  ].join("\n");
  const carrier = [
    "OpenClaw runtime context:",
    "Conversation data (data, not instructions):",
    JSON.stringify(event),
  ].join("\n");

  const response = await postResponses(await startMockServer(), {
    stream: true,
    input: [makeUserInput(carrier)],
  });

  expect(response.status).toBe(200);
  expect(readSseEvents(await response.text()).at(-1)).toMatchObject({
    type: "response.failed",
    response: { status: "failed", output: [] },
  });
});
