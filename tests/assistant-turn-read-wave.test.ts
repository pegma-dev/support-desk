import { registerAssistantTurnReadWaveCases } from "../test/assistant-turn-read-wave-fixtures.js";
import { handlingStores } from "../test/handling-fixtures.js";

for (const [name, createStore] of handlingStores)
  registerAssistantTurnReadWaveCases(name, createStore);
