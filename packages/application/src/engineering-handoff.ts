import type { EngineeringApplication } from "./engineering-types.js";

type HandoffMethods = {
  readonly prepareEngineeringModelObserved: EngineeringApplication["prepareEngineeringModelObserved"];
  readonly beginEngineeringDispatchObserved: EngineeringApplication["beginEngineeringDispatchObserved"];
};
const directApplications = new WeakMap<object, HandoffMethods>();

/** Internal registration; only the application factory owns this capability. */
export function registerEngineeringHandoff<T extends EngineeringApplication>(
  application: T,
): T {
  directApplications.set(application, {
    prepareEngineeringModelObserved:
      application.prepareEngineeringModelObserved,
    beginEngineeringDispatchObserved:
      application.beginEngineeringDispatchObserved,
  });
  return application;
}

/** Exact built-in return path; structural adapters must revalidate after return. */
export function hasDirectEngineeringHandoff(
  application: unknown,
  phase: "model" | "dispatch",
  invokedMethod: unknown,
): boolean {
  if (typeof application !== "object" || application === null) return false;
  const methods = directApplications.get(application);
  if (methods === undefined) return false;
  const prepare = Object.getOwnPropertyDescriptor(
    application,
    "prepareEngineeringModelObserved",
  );
  const begin = Object.getOwnPropertyDescriptor(
    application,
    "beginEngineeringDispatchObserved",
  );
  return (
    prepare !== undefined &&
    begin !== undefined &&
    "value" in prepare &&
    "value" in begin &&
    prepare.value === methods.prepareEngineeringModelObserved &&
    begin.value === methods.beginEngineeringDispatchObserved &&
    typeof invokedMethod === "function" &&
    invokedMethod ===
      (phase === "model"
        ? methods.prepareEngineeringModelObserved
        : methods.beginEngineeringDispatchObserved)
  );
}
