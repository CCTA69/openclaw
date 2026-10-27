import type { PreparedSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";

/** Resolve the process-tool isolation key for exec/process session state. */
export function resolveProcessToolScopeKey(params: {
  scopeKey?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): string | undefined {
  const scopeKey = params.scopeKey?.trim() || params.sessionKey?.trim() || params.sessionId?.trim();
  if (scopeKey) {
    return scopeKey;
  }
  const agentId = params.agentId?.trim();
  return agentId ? `agent:${agentId}` : undefined;
}

/** Resolve ancestor visibility from session-owned lineage, retaining its live authority. */
export function prepareProcessToolScope(
  defaults: {
    scopeKey?: string;
    sessionKey?: string;
    agentId?: string;
    sessionStore?: string;
  },
  assertCallerCurrent: () => void,
) {
  const scopeKey = defaults.scopeKey;
  const agentId = defaults.agentId;
  const ancestors = new Set<string>();
  const authorities: PreparedSessionSourceAuthority[] = [];
  const assertCurrent = () => {
    assertCallerCurrent();
    for (const authority of authorities) {
      authority.assertCurrent();
    }
  };
  const release = async () => {
    if (authorities.length === 0) {
      return;
    }
    const { releaseSessionSourceAuthorities } =
      await import("../config/sessions/session-source-authority.js");
    await releaseSessionSourceAuthorities(authorities);
  };
  const scope = {
    isInScope: (candidate?: { scopeKey?: string; agentId?: string } | null): boolean => {
      assertCurrent();
      if (!scopeKey) {
        return true;
      }
      if (candidate?.scopeKey === scopeKey) {
        return !agentId || !candidate.agentId || candidate.agentId === agentId;
      }
      return Boolean(
        agentId &&
        candidate?.agentId === agentId &&
        candidate.scopeKey &&
        ancestors.has(candidate.scopeKey),
      );
    },
    assertCurrent,
    [Symbol.asyncDispose]: release,
  };
  const prepare = async (scopeAgentId: string, initialSessionKey: string) => {
    try {
      assertCurrent();
      const [
        { resolveSessionStorePathCore },
        { withSessionEntryReadOnlyInWorker },
        { captureSessionEntrySourceAssertion },
        { parseAgentSessionKey },
      ] = await Promise.all([
        import("../config/sessions/paths.js"),
        import("../config/sessions/session-entry-read-runtime.js"),
        import("../config/sessions/session-entry-source-authority.js"),
        import("../routing/session-key.js"),
      ]);
      assertCurrent();
      const storePath = resolveSessionStorePathCore(defaults.sessionStore, {
        agentId: scopeAgentId,
      });
      let key: string | undefined = initialSessionKey;
      const visited = new Set<string>();
      while (key && (parseAgentSessionKey(key)?.agentId ?? scopeAgentId) === scopeAgentId) {
        if (visited.has(key) || visited.size >= 32) {
          throw new Error("Process session ancestry is invalid.");
        }
        visited.add(key);
        const sessionKey: string = key;
        const entry: SessionEntry | undefined = await withSessionEntryReadOnlyInWorker(
          { agentId: scopeAgentId, sessionKey, storePath, hydrateSkillPromptRefs: false },
          assertCurrent,
          async (read, owner) => {
            if (!read.ok) {
              throw read.error;
            }
            if (!read.value) {
              return undefined;
            }
            const source = captureSessionEntrySourceAssertion({
              scope: {
                agentId: scopeAgentId,
                sessionKey,
                storePath: owner.source?.path ?? storePath,
              },
              readSource: owner.source,
              expected: read.value,
              fields: ["sessionId", "lifecycleRevision", "parentSessionKey", "spawnedBy"],
              assertCurrent: assertCallerCurrent,
              assertHostCurrent: assertCallerCurrent,
              refuse: () => {
                throw new Error("Process session ancestry changed; retry the process action.");
              },
            });
            authorities.push(await source.prepareSessionSource());
            assertCurrent();
            return read.value;
          },
        );
        assertCurrent();
        if (!entry) {
          break;
        }
        ancestors.add(sessionKey);
        key = entry.parentSessionKey ?? entry.spawnedBy;
      }
      return scope;
    } catch (error) {
      await release();
      throw error;
    }
  };
  // Exact/custom scopes need no asynchronous preparation before selecting a process.
  return agentId && defaults.sessionKey && scopeKey === defaults.sessionKey
    ? prepare(agentId, defaults.sessionKey)
    : scope;
}
