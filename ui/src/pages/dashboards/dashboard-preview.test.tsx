/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { stubManualIntersectionObserver } from "../chat/components/chat-media-observer.test-support.ts";
import { DashboardPreview } from "./dashboard-preview.tsx";

// mock-isolation: Exercise the lazy error boundary without registering the Board renderer or its providers.
vi.mock("../../components/board/board-document.tsx", () => ({
  OpenClawBoardDocument() {
    throw new Error("Preview unavailable");
  },
}));

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("resumes near-viewport rendering and its error boundary after being remounted", async () => {
  const observations: { target: Element; notify: (isIntersecting: boolean) => void }[] = [];
  stubManualIntersectionObserver((target, notify) => observations.push({ target, notify }));
  let setVisible!: (value: boolean) => void;
  const { container, unmount } = mountSolid(() => {
    const [visible, set] = createSignal(true);
    setVisible = set;
    return (
      <Show when={visible()}>
        <DashboardPreview />
      </Show>
    );
  });

  flush();
  expect(observations).toHaveLength(1);
  expect(container.textContent).not.toContain("Preview unavailable");
  observations[0]!.notify(false);
  flush();
  expect(container.textContent).not.toContain("Preview unavailable");
  observations[0]!.notify(true);
  flush();
  await waitForSolid(() => expect(container.textContent).toContain("Preview unavailable"));

  observations[0]!.notify(false);
  flush();
  expect(container.textContent).not.toContain("Preview unavailable");

  setVisible(false);
  flush();
  expect(container.textContent).not.toContain("Preview unavailable");

  setVisible(true);
  flush();
  expect(observations).toHaveLength(2);
  expect(observations[1]!.target).not.toBe(observations[0]!.target);
  observations[0]!.notify(true);
  flush();
  expect(container.textContent).not.toContain("Preview unavailable");
  observations[1]!.notify(true);
  flush();
  await waitForSolid(() => expect(container.textContent).toContain("Preview unavailable"));

  unmount();
  observations[1]!.notify(true);
  flush();
  expect(container.childElementCount).toBe(0);
});
