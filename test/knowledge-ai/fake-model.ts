import type { ModelReply, ModelRequest } from "./types.js";

export type ModelStep =
  | { readonly kind: "reply"; readonly value: ModelReply }
  | { readonly kind: "reject"; readonly message: string }
  | { readonly kind: "defer"; readonly id: string };

/** Scripted transport double. It never reads corpus cases or their oracles. */
export function createScriptedModel(script: readonly ModelStep[]) {
  const steps = structuredClone(script);
  const recorded: ModelRequest[] = [];
  const pending = new Map<
    string,
    {
      resolve: (value: ModelReply) => void;
      reject: (reason: Error) => void;
    }
  >();
  let offset = 0;

  return {
    get requests(): readonly ModelRequest[] {
      return structuredClone(recorded);
    },
    get pendingIds(): readonly string[] {
      return [...pending.keys()];
    },
    async generate(request: ModelRequest): Promise<ModelReply> {
      recorded.push(structuredClone(request));
      const step = steps[offset++];
      if (step === undefined) throw new Error("No scripted model step");
      if (step.kind === "reply") return structuredClone(step.value);
      if (step.kind === "reject") throw new Error(step.message);
      if (pending.has(step.id))
        throw new Error(`Duplicate deferred model step: ${step.id}`);
      return new Promise<ModelReply>((resolve, reject) => {
        pending.set(step.id, { resolve, reject });
      });
    },
    complete(id: string, reply: ModelReply): void {
      const call = pending.get(id);
      if (call === undefined)
        throw new Error(`Unknown deferred model step: ${id}`);
      pending.delete(id);
      call.resolve(structuredClone(reply));
    },
    reject(id: string, error: Error): void {
      const call = pending.get(id);
      if (call === undefined)
        throw new Error(`Unknown deferred model step: ${id}`);
      pending.delete(id);
      call.reject(error);
    },
  };
}
