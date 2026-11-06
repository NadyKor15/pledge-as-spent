import type { AgLlmAdapter, AgLlmRequest, AgLlmResponse } from "ag-studio";
import { afterComplete } from "./adapter";
import type { AgentId } from "./wire";

// Model turns written down from a live run, played back for tests, the debug page and screenshots:
// the agent loop, the book's tools, the delegation and the guard all run for real; only the model's
// answers come from the recording.

export interface RecordedTurn {
  agentId: AgentId;
  /** Order of the turn within its agent (0, 1, 2…). */
  n: number;
  request: { instructionsChars: number; inputItems: number; lastItem: string; tools: string[] };
  response: Pick<AgLlmResponse, "output" | "status" | "usage" | "model">;
}

/** Writes each turn the inner adapter answers. */
export function recordingAdapter(inner: AgLlmAdapter, agentId: AgentId, sink: (t: RecordedTurn) => void): AgLlmAdapter {
  let n = 0;
  return {
    executeTurn(request: AgLlmRequest, options) {
      const i = n++;
      const h = inner.executeTurn(request, options);
      void h.complete.then(
        (r) => {
          const last = request.input[request.input.length - 1] as { type: string; role?: string; name?: string } | undefined;
          sink({
            agentId,
            n: i,
            request: { instructionsChars: request.instructions?.length ?? 0, inputItems: request.input.length, lastItem: last ? `${last.type}${last.role ? `:${last.role}` : ""}` : "", tools: (request.tools ?? []).map((t) => t.name) },
            response: { output: r.output, status: r.status, usage: r.usage, model: r.model },
          });
        },
        () => {},
      );
      return h;
    },
  };
}

export class RecordingExhausted extends Error {}

/** Plays an agent's recorded turns in order. One more turn than was recorded is an error, not an invented answer. */
export function replayAdapter(turns: readonly RecordedTurn[], agentId: AgentId): AgLlmAdapter {
  const mine = turns.filter((t) => t.agentId === agentId).sort((a, b) => a.n - b.n);
  let n = 0;
  return {
    executeTurn() {
      const t = mine[n++];
      const complete = t
        ? Promise.resolve({ id: `replay_${agentId}_${t.n}`, createdAt: Date.now(), ...t.response } as AgLlmResponse)
        : Promise.reject(new RecordingExhausted(`No recorded ${agentId} turn ${n - 1}.`));
      return afterComplete(complete);
    },
  };
}
