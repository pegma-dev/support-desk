import type { AccessContext } from "@pegma/authorization-core";
import type { Clock } from "@pegma/spine";
import type { CollectionStore, VersionedRecord } from "@pegma/storage-core";
import type { Ticket } from "@pegma/support-desk-contracts";
import type { SupportDeskLimits, SupportRecord } from "./index.js";
import type {
  EngineeringSourceRecord,
  EngineeringWorkRecord,
  ResolvedEngineeringOptions,
} from "./engineering-records.js";
import type {
  EngineeringCommand,
  EngineeringPolicyPort,
} from "./engineering-types.js";

export type EngineeringAction = Parameters<
  CollectionStore<SupportRecord>["transact"]
>[1][number];
export type EngineeringTicketVersion = VersionedRecord<
  Extract<SupportRecord, { kind: "ticket" }>
>;
export type EngineeringSourceVersion = VersionedRecord<EngineeringSourceRecord>;
export type EngineeringWorkVersion = VersionedRecord<EngineeringWorkRecord>;
export interface EngineeringLoaded {
  readonly ticket: EngineeringTicketVersion;
  readonly source: EngineeringSourceVersion;
  readonly rows: readonly SupportRecord[];
}
export interface EngineeringDependencies {
  readonly records: CollectionStore<SupportRecord>;
  readonly clock: Clock;
  readonly limits: SupportDeskLimits;
  readonly options: ResolvedEngineeringOptions;
  readonly maxConflictAttempts: number;
  readonly policy: EngineeringPolicyPort;
  audit(
    command: EngineeringCommand,
    ticket: Pick<Ticket, "id" | "revision">,
    actorId: string,
    now: string,
    action: string,
  ): EngineeringAction;
  admission(
    ticket: Ticket,
    rows: readonly SupportRecord[],
    additional: number,
  ): void;
  /** Consume only engineering's own permanent-withdrawal reserve. */
  withdrawalAdmission(
    ticket: Ticket,
    rows: readonly SupportRecord[],
    additional: number,
  ): void;
  /** Consume only this work row's prepaid terminal Audit/receipt reserve. */
  completionAdmission(
    ticket: Pick<Ticket, "id" | "revision">,
    rows: readonly SupportRecord[],
    additional: number,
    workId: string,
  ): void;
}
export type EngineeringLoader = (
  ticketId: string,
) => Promise<EngineeringLoaded>;
export type EngineeringLoad = EngineeringLoader;
