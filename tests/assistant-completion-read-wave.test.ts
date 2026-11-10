import { registerAssistantCompletionReadWaveCases } from "../test/assistant-completion-read-wave-fixtures.js";
import { handlingStores } from "../test/handling-fixtures.js";

for (const [name, createStore] of handlingStores)
  registerAssistantCompletionReadWaveCases(name, createStore);
