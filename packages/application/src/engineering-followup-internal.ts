import type { Clock } from "@pegma/spine";
import type { CollectionStore, VersionedRecord } from "@pegma/storage-core";
import type { Ticket } from "@pegma/support-desk-contracts";
import type { SupportDeskLimits, SupportRecord } from "./index.js";
import type {
  EngineeringAction,
  EngineeringSourceVersion,
  EngineeringTicketVersion,
  EngineeringWorkVersion,
} from "./engineering-internal.js";
import type { EngineeringSourceRecord } from "./engineering-records.js";
import type { EngineeringCommand } from "./engineering-types.js";
import type {
  EngineeringFollowupHeadRecord,
  EngineeringFollowupWorkRecord,
  ResolvedEngineeringFollowupOptions,
} from "./engineering-followup-records.js";
import type {
  EngineeringFollowupKey,
  EngineeringFollowupAssociation,
  EngineeringFollowupProofContext,
  VerifiedEngineeringFollowupContext,
} from "./engineering-followup-types.js";

export interface EngineeringFollowupLoaded {
  readonly ticket: EngineeringTicketVersion;
  readonly source: EngineeringSourceVersion;
  readonly head: VersionedRecord<EngineeringFollowupHeadRecord> | null;
  readonly rows: readonly SupportRecord[];
}
export type EngineeringFollowupLoad = (
  ticketId: string,
) => Promise<EngineeringFollowupLoaded>;
/** Private component-owned records used by one reassessment attempt, never caller data. */
export interface EngineeringFollowupReassessmentSeed {
  readonly loaded: EngineeringFollowupLoaded;
  readonly work: EngineeringFollowupWorkVersion;
  readonly association: EngineeringFollowupAssociation;
  readonly engineeringWork: EngineeringWorkVersion;
}
export type EngineeringFollowupReassessmentPurpose = "bundle" | "model_retry";
export interface EngineeringFollowupMutationPlan {
  readonly actions: readonly EngineeringAction[];
  readonly nextWorkRows: readonly EngineeringFollowupWorkRecord[];
}
export interface EngineeringFollowupSourceChangeContext {
  readonly rows: readonly SupportRecord[];
  readonly previousSource: EngineeringSourceRecord;
  readonly nextSource: EngineeringSourceRecord;
  readonly reason:
    "explicit_revocation" | "security_restriction" | "withdrawal";
}
export interface EngineeringFollowupDependencies {
  readonly records: CollectionStore<SupportRecord>;
  readonly clock: Clock;
  readonly limits: SupportDeskLimits;
  readonly options: ResolvedEngineeringFollowupOptions;
  readonly maxConflictAttempts: number;
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
    nextWorkRows: readonly EngineeringFollowupWorkRecord[],
    addedPhysicalRows: number,
    addsMessage?: boolean,
  ): void;
}
export interface EngineeringFollowupCurrent {
  readonly loaded: EngineeringFollowupLoaded;
  readonly work: VersionedRecord<EngineeringFollowupWorkRecord>;
  readonly proofContext: EngineeringFollowupProofContext;
  readonly proof: VerifiedEngineeringFollowupContext;
}
export type EngineeringFollowupWorkVersion =
  VersionedRecord<EngineeringFollowupWorkRecord>;
export type EngineeringFollowupWorkAt = (
  key: EngineeringFollowupKey,
) => Promise<EngineeringFollowupWorkVersion>;
