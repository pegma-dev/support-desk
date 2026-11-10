import type { CollectionStore } from "@pegma/storage-core";

/** Preserve the real collection's prototype and receiver for all delegation. */
export function delegateCollection<T>(
  target: CollectionStore<T>,
  overrides: Partial<CollectionStore<T>>,
): CollectionStore<T> {
  return new Proxy(target, {
    get(object, property) {
      const source = Object.prototype.hasOwnProperty.call(overrides, property)
        ? overrides
        : object;
      const value: unknown = Reflect.get(source, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}
