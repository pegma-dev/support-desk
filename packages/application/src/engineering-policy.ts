import {
  auditEvent,
  auditRecordId,
  defineAudit,
  type AuditEvent,
} from "@pegma/audit";
import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import type { Clock } from "@pegma/spine";
import {
  defineCollection,
  type EntityKey,
  type Store,
  type StoredRecord,
  type TransactionAction,
} from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  supportPermissions,
} from "./index.js";
import {
  dataArray,
  encodedBytes,
  fields,
  fingerprint,
  integer,
  text,
  timestamp,
} from "./assistant-turn-records.js";
import type {
  EngineeringPolicyApplication,
  EngineeringPolicyCommand,
  EngineeringPolicyPort,
  EngineeringPolicyResult,
  EngineeringPolicySnapshot,
  EngineeringRepositoryDescriptor,
  EngineeringRepositoryPolicy,
  PutEngineeringPolicyCommand,
} from "./engineering-types.js";

export interface EngineeringPolicyOptions {
  readonly maxRepositories?: number;
  readonly maxRecords?: number;
}
export interface EngineeringPolicyServiceOptions extends EngineeringPolicyOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly maxConflictAttempts?: number;
}

interface PolicyHeadRecord extends EngineeringPolicySnapshot {
  readonly kind: "engineering_policy";
  readonly partition: "instance";
  readonly id: "policy";
}
interface PolicyCommandRecord {
  readonly kind: "engineering_policy_command";
  readonly partition: "instance";
  readonly id: string;
  readonly fingerprint: string;
  readonly result: EngineeringPolicyResult;
}
interface PolicyAuditRecord {
  readonly kind: "audit";
  readonly partition: "instance";
  readonly id: string;
  readonly event: AuditEvent;
}
export type EngineeringPolicyRecord =
  PolicyHeadRecord | PolicyCommandRecord | PolicyAuditRecord;

export const engineeringPolicyAuditActions = Object.freeze({
  changed: "support.engineering.policy_changed",
  disabled: "support.engineering.exports_disabled",
} as const);

const partition = "instance";
const headKey: EntityKey = Object.freeze({ partition, id: "policy" });
const emergencyRows = 2;
const maximumRecordBytes = 60_000;
const hardMaximumRepositories = 20;

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${field} must be boolean`);
  return value;
}
function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new TypeError(`${field} must be a SHA-256 fingerprint`);
  return value;
}
function uniqueStrings(
  value: unknown,
  field: string,
  maximum: number,
  characters: number,
): readonly string[] {
  const result = dataArray(value, field, maximum).map((item) =>
    text(item, field, characters),
  );
  if (new Set(result).size !== result.length)
    throw new TypeError(`${field} must be unique`);
  return Object.freeze(result);
}
function repository(value: unknown): EngineeringRepositoryDescriptor {
  const input = fields(value, "engineering repository", [
    "repositoryId",
    "owner",
    "name",
    "visibility",
    "responsibilities",
    "product",
    "component",
    "version",
    "allowedLabels",
    "allowedTemplates",
    "publicationMode",
    "enabled",
  ]);
  if (input.visibility !== "public" && input.visibility !== "private")
    throw new TypeError("Repository visibility must be public or private");
  if (input.publicationMode !== "approval_required")
    throw new TypeError("Engineering exports require staff approval");
  const repositoryId = text(input.repositoryId, "repositoryId");
  const owner = text(input.owner, "repository.owner");
  const name = text(input.name, "repository.name");
  for (const identifier of [repositoryId, owner, name])
    if (identifier.trim() !== identifier || identifier.includes("://"))
      throw new TypeError(
        "Repository identity must use separate opaque ID, owner and name fields",
      );
  if (owner.includes("/") || name.includes("/"))
    throw new TypeError("Repository owner and name must be separate fields");
  return Object.freeze({
    repositoryId,
    owner,
    name,
    visibility: input.visibility,
    responsibilities: text(
      input.responsibilities,
      "repository.responsibilities",
      2_000,
    ),
    product: text(input.product, "repository.product", 1_000),
    component: text(input.component, "repository.component", 1_000),
    version: text(input.version, "repository.version", 1_000),
    allowedLabels: uniqueStrings(
      input.allowedLabels,
      "repository.allowedLabels",
      32,
      100,
    ),
    allowedTemplates: uniqueStrings(
      input.allowedTemplates,
      "repository.allowedTemplates",
      8,
      200,
    ),
    publicationMode: "approval_required",
    enabled: boolean(input.enabled, "repository.enabled"),
  });
}
function policy(value: unknown): EngineeringRepositoryPolicy {
  const input = fields(value, "engineering policy", [
    "enabled",
    "repositories",
  ]);
  const repositories = dataArray(
    input.repositories,
    "engineering policy.repositories",
    hardMaximumRepositories,
  ).map(repository);
  if (
    new Set(repositories.map((item) => item.repositoryId)).size !==
    repositories.length
  )
    throw new TypeError(
      "Repository policy must have unique immutable repository IDs",
    );
  return Object.freeze({
    enabled: boolean(input.enabled, "engineering policy.enabled"),
    repositories: Object.freeze(repositories),
  });
}
function result(value: unknown): EngineeringPolicyResult {
  const input = fields(value, "engineering policy result", [
    "generation",
    "policyHash",
    "enabled",
  ]);
  return Object.freeze({
    generation: integer(input.generation, "engineering policy generation"),
    policyHash: hash(input.policyHash, "policyHash"),
    enabled: boolean(input.enabled, "engineering policy result.enabled"),
  });
}
function record(value: unknown): EngineeringPolicyRecord {
  const envelope = fields(
    value,
    "engineering policy record",
    ["kind", "partition", "id"],
    ["generation", "policyHash", "policy", "fingerprint", "result", "event"],
  );
  if (envelope.partition !== partition)
    throw new TypeError("Engineering policy must use the instance partition");
  text(envelope.id, "engineering policy record.id", 1_024);
  if (envelope.kind === "engineering_policy") {
    fields(value, "engineering policy head", [
      "kind",
      "partition",
      "id",
      "generation",
      "policyHash",
      "policy",
    ]);
    if (envelope.id !== headKey.id)
      throw new TypeError("Engineering policy head key mismatch");
    return Object.freeze({
      kind: "engineering_policy",
      partition,
      id: "policy",
      generation: integer(
        envelope.generation,
        "engineering policy generation",
        1,
      ),
      policyHash: hash(envelope.policyHash, "policyHash"),
      policy: policy(envelope.policy),
    });
  }
  if (envelope.kind === "engineering_policy_command") {
    fields(value, "engineering policy receipt", [
      "kind",
      "partition",
      "id",
      "fingerprint",
      "result",
    ]);
    if (!(envelope.id as string).startsWith("command:"))
      throw new TypeError("Engineering policy receipt key mismatch");
    text((envelope.id as string).slice("command:".length), "stored commandId");
    const accepted = result(envelope.result);
    integer(accepted.generation, "stored engineering policy generation", 1);
    return Object.freeze({
      kind: "engineering_policy_command",
      partition,
      id: envelope.id as string,
      fingerprint: hash(envelope.fingerprint, "command fingerprint"),
      result: accepted,
    });
  }
  if (envelope.kind === "audit") {
    fields(value, "engineering policy audit", [
      "kind",
      "partition",
      "id",
      "event",
    ]);
    const event = auditEvent(envelope.event as AuditEvent);
    if (
      event.subject !== partition ||
      envelope.id !== auditRecordId(event.id) ||
      !Object.values(engineeringPolicyAuditActions).includes(
        event.action as typeof engineeringPolicyAuditActions.changed,
      )
    )
      throw new TypeError("Engineering policy audit envelope mismatch");
    text(event.id, "stored audit commandId");
    if (event.actor.kind !== "principal")
      throw new TypeError(
        "Engineering policy changes require a principal actor",
      );
    text(event.actor.principalId, "stored audit principalId");
    timestamp(event.occurredAt, "stored audit occurredAt");
    const details = fields(event.details, "engineering policy audit details", [
      "commandId",
      "correlationId",
      "generation",
      "policyHash",
      "enabled",
    ]);
    if (details.commandId !== event.id || details.generation !== event.sequence)
      throw new TypeError(
        "Engineering policy Audit must bind its command and generation",
      );
    text(details.correlationId, "stored audit correlationId");
    integer(details.generation, "stored audit generation", 1);
    hash(details.policyHash, "stored audit policyHash");
    boolean(details.enabled, "stored audit enabled");
    return Object.freeze({
      kind: "audit",
      partition,
      id: envelope.id as string,
      event,
    });
  }
  throw new TypeError("Unknown engineering policy record kind");
}
function stored(value: EngineeringPolicyRecord): StoredRecord {
  const normalized = record(value);
  const encoded = {
    partition,
    id: normalized.id,
    json: JSON.stringify(normalized),
  };
  if (encodedBytes(encoded) > maximumRecordBytes)
    throw new SupportDeskLimitError("serialized_record", maximumRecordBytes);
  return encoded;
}

/** The policy, causal Audit and replay receipt share one declared partition. */
export const engineeringPolicyRecords =
  defineCollection<EngineeringPolicyRecord>({
    name: "support-desk.engineering-policy.v1",
    key: (value) => ({ partition: value.partition, id: value.id }),
    codec: {
      encode: stored,
      decode(encoded) {
        if (
          encoded.partition !== partition ||
          typeof encoded.id !== "string" ||
          typeof encoded.json !== "string"
        )
          throw new TypeError("Engineering policy storage envelope is invalid");
        if (encodedBytes(encoded) > maximumRecordBytes)
          throw new SupportDeskLimitError(
            "serialized_record",
            maximumRecordBytes,
          );
        const decoded = record(JSON.parse(encoded.json));
        if (decoded.id !== encoded.id)
          throw new TypeError("Engineering policy storage key mismatch");
        return decoded;
      },
    },
  });

export const engineeringPolicyAudit = defineAudit<EngineeringPolicyRecord>({
  collection: engineeringPolicyRecords,
  toRecord(event) {
    return record({
      kind: "audit",
      partition: event.subject,
      id: auditRecordId(event.id),
      event,
    });
  },
  toEvent(value) {
    if (value.kind !== "audit") return null;
    const normalized = record(value);
    return normalized.kind === "audit" ? normalized.event : null;
  },
});

function acknowledgement(
  snapshot: EngineeringPolicySnapshot,
): EngineeringPolicyResult {
  return Object.freeze({
    generation: snapshot.generation,
    policyHash: snapshot.policyHash,
    enabled: snapshot.policy.enabled,
  });
}
function snapshot(head: EngineeringPolicySnapshot): EngineeringPolicySnapshot {
  return Object.freeze({
    generation: head.generation,
    policyHash: head.policyHash,
    policy: policy(head.policy),
  });
}
function command(
  value: unknown,
  put: boolean,
): EngineeringPolicyCommand | PutEngineeringPolicyCommand {
  const input = fields(value, "engineering policy command", [
    "commandId",
    "correlationId",
    "expectedGeneration",
    ...(put ? ["policy"] : []),
  ]);
  const common = {
    commandId: text(input.commandId, "commandId"),
    correlationId: text(input.correlationId, "correlationId"),
    expectedGeneration: integer(input.expectedGeneration, "expectedGeneration"),
  };
  return Object.freeze(
    put ? { ...common, policy: policy(input.policy) } : common,
  );
}

export function createEngineeringPolicyServices(
  options: EngineeringPolicyServiceOptions,
): {
  readonly application: EngineeringPolicyApplication;
  readonly resolve: EngineeringPolicyPort["resolve"];
} {
  const records = options.store.collection(engineeringPolicyRecords);
  const maxRepositories = integer(
    options.maxRepositories ?? 8,
    "engineeringPolicy.maxRepositories",
    1,
    hardMaximumRepositories,
  );
  const maxRecords = integer(
    options.maxRecords ?? 256,
    "engineeringPolicy.maxRecords",
    5,
    1_024,
  );
  const maxAttempts = integer(
    options.maxConflictAttempts ?? 4,
    "maxConflictAttempts",
    1,
    20,
  );
  const authorizeRead = (access: AccessContext, actorId?: string): void => {
    const currentActor = text(access.principalId, "principalId");
    if (actorId !== undefined && currentActor !== actorId)
      throw new SupportDeskConflictError("Engineering policy actor changed");
    if (hasPermission(access, supportPermissions.engineeringProcess)) return;
    if (!hasPermission(access, supportPermissions.engineeringPolicyRead))
      throw new SupportDeskAuthorizationError(
        supportPermissions.engineeringPolicyRead,
      );
    if (!hasPermission(access, supportPermissions.queueRead))
      throw new SupportDeskAuthorizationError(supportPermissions.queueRead);
  };
  const authorizeManage = (access: AccessContext, actorId?: string): void => {
    const currentActor = text(access.principalId, "principalId");
    if (actorId !== undefined && currentActor !== actorId)
      throw new SupportDeskConflictError("Engineering policy actor changed");
    if (!hasPermission(access, supportPermissions.engineeringPolicyManage))
      throw new SupportDeskAuthorizationError(
        supportPermissions.engineeringPolicyManage,
      );
    if (!hasPermission(access, supportPermissions.queueRead))
      throw new SupportDeskAuthorizationError(supportPermissions.queueRead);
  };
  const empty = async (): Promise<EngineeringPolicySnapshot> => {
    const value: EngineeringRepositoryPolicy = Object.freeze({
      enabled: false,
      repositories: Object.freeze([]),
    });
    return Object.freeze({
      generation: 0,
      policyHash: await fingerprint(value),
      policy: value,
    });
  };
  const readHead = async () => {
    const head = await records.getVersioned(headKey);
    if (head === null) return null;
    if (
      head.value.kind !== "engineering_policy" ||
      head.value.policyHash !== (await fingerprint(head.value.policy))
    )
      throw new TypeError("Engineering policy head fingerprint mismatch");
    return { value: head.value, version: head.version };
  };
  const replay = async (
    id: string,
    fingerprint: string,
  ): Promise<EngineeringPolicyResult | null> => {
    const previous = await records.get({ partition, id: `command:${id}` });
    if (previous === null) return null;
    if (
      previous.kind !== "engineering_policy_command" ||
      previous.fingerprint !== fingerprint
    )
      throw new SupportDeskConflictError(
        "Engineering policy command ID reused with different input",
      );
    return result(previous.result);
  };
  const mutate = async (
    access: AccessContext,
    raw: EngineeringPolicyCommand | PutEngineeringPolicyCommand,
    disable: boolean,
  ): Promise<EngineeringPolicyResult> => {
    const actorId = text(access.principalId, "principalId");
    authorizeManage(access, actorId);
    const input = command(raw, !disable);
    if (
      !disable &&
      (input as PutEngineeringPolicyCommand).policy.repositories.length >
        maxRepositories
    )
      throw new SupportDeskLimitError(
        "engineering_policy_repositories",
        maxRepositories,
      );
    const requestHash = await fingerprint({
      operation: disable ? "disable" : "put",
      actorId,
      command: input,
    });
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      authorizeManage(access, actorId);
      const previous = await replay(input.commandId, requestHash);
      if (previous !== null) {
        authorizeManage(access, actorId);
        return previous;
      }
      const head = await readHead();
      const current = head === null ? await empty() : snapshot(head.value);
      if (current.generation !== input.expectedGeneration)
        throw new SupportDeskConflictError(
          "Engineering policy generation changed",
        );
      if (disable && !current.policy.enabled) {
        authorizeManage(access, actorId);
        return acknowledgement(current);
      }
      const nextGeneration = integer(
        current.generation + 1,
        "engineering policy generation",
        1,
      );
      const nextPolicy = disable
        ? Object.freeze({ ...current.policy, enabled: false })
        : (input as PutEngineeringPolicyCommand).policy;
      const next: PolicyHeadRecord = {
        kind: "engineering_policy",
        partition,
        id: "policy",
        generation: nextGeneration,
        policyHash: await fingerprint(nextPolicy),
        policy: nextPolicy,
      };
      stored(next);
      // An accepted enabled head must still fit its future emergency disable,
      // including a generation-width increase. Personal metadata stays in Audit.
      if (nextPolicy.enabled)
        stored({
          ...next,
          generation: Number.MAX_SAFE_INTEGER,
          policy: Object.freeze({ ...nextPolicy, enabled: false }),
        });
      if (nextPolicy.enabled && nextGeneration === Number.MAX_SAFE_INTEGER)
        throw new SupportDeskConflictError(
          "Engineering policy generation has no remaining disable fence",
        );
      const rows = await records.list(partition);
      const added = head === null ? 3 : 2;
      const maximum = disable ? maxRecords : maxRecords - emergencyRows;
      if (rows.length + added > maximum)
        throw new SupportDeskLimitError(
          "engineering_policy_records",
          maxRecords,
        );
      const now = options.clock.now();
      timestamp(now, "engineering policy occurredAt");
      const accepted = acknowledgement(next);
      const receipt: PolicyCommandRecord = {
        kind: "engineering_policy_command",
        partition,
        id: `command:${input.commandId}`,
        fingerprint: requestHash,
        result: accepted,
      };
      const audit = engineeringPolicyAudit.action({
        id: input.commandId,
        occurredAt: now,
        actor: { kind: "principal", principalId: actorId },
        action: disable
          ? engineeringPolicyAuditActions.disabled
          : engineeringPolicyAuditActions.changed,
        subject: partition,
        sequence: next.generation,
        details: {
          commandId: input.commandId,
          correlationId: input.correlationId,
          generation: next.generation,
          policyHash: next.policyHash,
          enabled: next.policy.enabled,
        },
      });
      stored(receipt);
      if (audit.action === "delete")
        throw new TypeError("Policy Audit must append a record");
      stored(audit.value);
      const actions: TransactionAction<EngineeringPolicyRecord>[] = [
        head === null
          ? { action: "insert", value: next }
          : { action: "putIfUnchanged", version: head.version, value: next },
        audit,
        { action: "insert", value: receipt },
      ];
      authorizeManage(access, actorId);
      if ((await records.transact(partition, actions)).committed) {
        authorizeManage(access, actorId);
        return accepted;
      }
    }
    authorizeManage(access, actorId);
    const previous = await replay(input.commandId, requestHash);
    if (previous !== null) {
      authorizeManage(access, actorId);
      return previous;
    }
    throw new SupportDeskConflictError(
      "Engineering policy did not commit within its conflict bound",
    );
  };
  const read: EngineeringPolicyApplication["readRepositoryPolicy"] = async (
    access,
  ) => {
    const actorId = text(access.principalId, "principalId");
    authorizeRead(access, actorId);
    const head = await readHead();
    const current = head === null ? await empty() : snapshot(head.value);
    authorizeRead(access, actorId);
    return current;
  };
  const application = Object.freeze<EngineeringPolicyApplication>({
    readRepositoryPolicy: read,
    putRepositoryPolicy: (access, input) => mutate(access, input, false),
    disableEngineeringExports: (access, input) => mutate(access, input, true),
  });
  return Object.freeze({ application, resolve: read });
}
