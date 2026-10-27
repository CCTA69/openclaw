import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { handleNavigationClick } from "../../../lib/navigation-click.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { HandoffDisplay } from "../chat-sessions-yield.ts";
import type {
  ChatHandoffSession,
  ChatSubagentWait,
  HandoffSessionLinks,
} from "../chat-subagent-wait.ts";
import "./chat-handoff-sessions.css";

function needsInputLabel(count: number) {
  return count === 1
    ? t("chat.sessionsNeedInputOne")
    : t("chat.sessionsNeedInput", { count: String(count) });
}

/** A child's name: a link to its session when this viewer can open it, else text. */
function HandoffSessionName(props: {
  session: ChatHandoffSession;
  links?: HandoffSessionLinks;
  class: string;
}) {
  const link = createMemo(() => props.links?.(props.session.key));
  return (
    <Show when={link()} fallback={<span class={props.class}>{props.session.label}</span>}>
      {(target) => (
        <a
          class={[props.class, "chat-handoff-sessions__link"]}
          href={target().href}
          onClick={(event) => handleNavigationClick(event, () => target().open())}
        >
          {props.session.label}
        </a>
      )}
    </Show>
  );
}

/** Each child with a status in words; the dot only repeats it. */
function HandoffSessionList(props: {
  id: string;
  sessions: readonly ChatHandoffSession[];
  links?: HandoffSessionLinks;
}) {
  return (
    <ul id={props.id} class="chat-handoff-sessions">
      <For each={props.sessions} keyed={(session) => session.key}>
        {(session) => (
          <li
            class="chat-handoff-sessions__row"
            data-status={session().status}
            data-session-key={session().key}
            title={session().note}
          >
            <span class="chat-handoff-sessions__dot" aria-hidden="true" />
            <HandoffSessionName
              session={session()}
              links={props.links}
              class="chat-handoff-sessions__name"
            />{" "}
            <span class="chat-handoff-sessions__status">
              {t(`chat.handoffSessionStatus.${session().status}`)}
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

/**
 * The working line while a handoff waits on its children: one child is named
 * in place; several get a list, open until the reader closes it.
 */
export function ChatSubagentWaitLine(props: {
  wait: ChatSubagentWait;
  startMs: number;
  links?: HandoffSessionLinks;
}) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(true);
  const only = createMemo(() =>
    props.wait.sessions.length === 1 ? props.wait.sessions[0] : undefined,
  );
  const attention = createMemo(
    () => props.wait.sessions.filter((session) => session.status === "attention").length,
  );
  const elapsed = () => (
    <>
      <span aria-hidden="true">·</span>{" "}
      <ElapsedTime class="chat-working-indicator__elapsed" startMs={props.startMs} />
    </>
  );
  return (
    <div class="chat-subagent-wait">
      <Show
        when={only()}
        fallback={
          <>
            <button
              type="button"
              class="chat-subagent-wait__toggle"
              aria-expanded={open() ? "true" : "false"}
              aria-controls={id}
              onClick={() => setOpen(!open())}
            >
              <span>
                {t("chat.waitingOnSessions", { count: String(props.wait.sessions.length) })}
              </span>{" "}
              <Show when={attention() > 0}>
                <span aria-hidden="true">·</span>{" "}
                <span class="chat-subagent-wait__attention">
                  {needsInputLabel(attention())}
                </span>{" "}
              </Show>
              {elapsed()}
              <Icon name="chevronRight" class="chat-subagent-wait__chevron" />
            </button>
            <Show when={open()}>
              <HandoffSessionList id={id} sessions={props.wait.sessions} links={props.links} />
            </Show>
          </>
        }
      >
        {(session) => {
          const [before, after = ""] = t("chat.waitingOnSubagent", { name: "\u0000" }).split(
            "\u0000",
          );
          return (
            <span class="chat-subagent-wait__line">
              <span>
                {before}
                <HandoffSessionName
                  session={session()}
                  links={props.links}
                  class="chat-subagent-wait__name"
                />
                {after}
              </span>{" "}
              <Show when={session().status === "attention"}>
                <span aria-hidden="true">·</span>{" "}
                <span class="chat-subagent-wait__attention" title={session().note}>
                  {t("chat.handoffSessionStatus.attention")}
                </span>{" "}
              </Show>
              {elapsed()}
            </span>
          );
        }}
      </Show>
    </div>
  );
}

/**
 * Where a resumed handoff picks up again: how long it waited, and the children
 * it waited on, closed until asked for.
 */
export function ChatHandoffResume(props: {
  handoff: HandoffDisplay & { resumedAt: number };
  sessions: readonly ChatHandoffSession[];
  links?: HandoffSessionLinks;
}) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const label = () =>
    t("chat.handoffResumed", {
      duration:
        formatDurationCompact(Math.max(1_000, props.handoff.resumedAt - props.handoff.yieldedAt), {
          includeSeconds: true,
        }) ?? "",
    });
  const count = () =>
    props.sessions.length === 1
      ? t("chat.handoffSessionsOne")
      : t("chat.handoffSessions", { count: String(props.sessions.length) });
  return (
    <div class="chat-handoff-resume">
      <Show
        when={props.sessions.length > 0}
        fallback={<div class="chat-handoff-resume__rule">{label()}</div>}
      >
        <button
          type="button"
          class="chat-handoff-resume__rule"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={id}
          onClick={() => setOpen(!open())}
        >
          <span>{label()}</span> <span aria-hidden="true">·</span> <span>{count()}</span>
          <Icon name="chevronRight" class="chat-subagent-wait__chevron" />
        </button>
        <Show when={open()}>
          <HandoffSessionList id={id} sessions={props.sessions} links={props.links} />
        </Show>
      </Show>
    </div>
  );
}
