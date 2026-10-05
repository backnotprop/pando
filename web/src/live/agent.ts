// An agent session's live transcript (pando-agents' live socket, contract
// AgentLiveFrame): the first frame carries every message so far, each later
// one the messages after its `from`. A reconnect gets a full frame again.
// While the socket is down, the transcript is read instead (`fallback`).
import { type AgentMessage, decodeAgentLiveFrame, Routes } from "@pando/contract";
import { useQuery } from "@tanstack/react-query";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { agentsKey } from "../api/agents";
import { get } from "../api/client";
import type { MonorepoRef } from "../api/names";
import { fallback } from "./rows";
import { keepOpen } from "./socket";

export function useAgentMessages(m: MonorepoRef, n: number | null): readonly AgentMessage[] | null {
  const [messages, setMessages] = useState<readonly AgentMessage[] | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    setMessages(null);

    if (n === null) return;

    const stop = keepOpen(() => Routes.agentLivePath(m.owner, m.name, n), {
      up: setLive,
      frame: (data) => {
        const frame = Option.getOrNull(decodeAgentLiveFrame(data));

        if (frame) setMessages((had) => [...(had ?? []).slice(0, frame.from), ...frame.messages]);
      },
    });

    return () => {
      stop();
      setLive(false);
    };
  }, [m.owner, m.name, n]);

  const read = useQuery({
    queryKey: [...agentsKey(m), "transcript", n],
    queryFn: () => {
      const route = Routes.agentTranscript(m.owner, m.name, n ?? 0);

      return get(route.response, route.path).then((t) => t.messages);
    },
    enabled: n !== null && !live,
    refetchInterval: fallback(live),
  });

  return messages ?? read.data ?? null;
}
