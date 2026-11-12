import type { ResolutionLearningStagedDeliveryApplication } from "./resolution-learning-types.js";

const direct = new WeakMap<
  object,
  ResolutionLearningStagedDeliveryApplication
>();

/** Internal factory registration; no structural flag can grant the handoff. */
export function registerResolutionLearningDelivery(
  capability: ResolutionLearningStagedDeliveryApplication,
): ResolutionLearningStagedDeliveryApplication {
  direct.set(capability, { ...capability });
  return capability;
}

export function hasDirectResolutionLearningDelivery(
  capability: unknown,
): capability is ResolutionLearningStagedDeliveryApplication {
  if (typeof capability !== "object" || capability === null) return false;
  const methods = direct.get(capability);
  return (
    methods !== undefined &&
    (["prepare", "write", "complete"] as const).every((name) => {
      const property = Object.getOwnPropertyDescriptor(capability, name);
      return (
        property !== undefined &&
        "value" in property &&
        typeof property.value === "function" &&
        property.value === methods[name]
      );
    })
  );
}
