import type { Clock } from "@pegma/spine";
import type { Store } from "@pegma/storage-core";
import type { SupportDeskApplication } from "@pegma/support-desk-application";
import type {
  PublicPackageManifest,
  ReleasePackageDefinition,
  runNpm,
} from "./release-packages.mjs";

export const CONSUMER_TOOLCHAIN: Readonly<{
  typescript: "7.0.2";
  "@types/node": "26.6.6";
  "@pegma/storage-core": "0.4.0";
}>;
export const PREVIOUS_APPLICATION: Readonly<{
  alias: "@pegma/support-desk-application-previous";
  specifier: "npm:@pegma/support-desk-application@0.1.1";
  name: "@pegma/support-desk-application";
  version: "0.1.1";
}>;
export function consumerVerificationPath(output: string): string;
export interface ConsumerArtifactRecord {
  readonly name: string;
  readonly directory: string;
  readonly version: string;
  readonly tarballPath: string;
}
export interface ConsumerPackageRecord extends ConsumerArtifactRecord {
  readonly manifest: PublicPackageManifest;
}
export interface ConsumerArtifactBinding {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly size: number;
  readonly sha256: string;
  readonly shasum: string;
  readonly integrity: string;
}
export interface PreviousConsumerArtifact {
  readonly alias: "@pegma/support-desk-application-previous";
  readonly name: "@pegma/support-desk-application";
  readonly version: "0.1.1";
  readonly resolved: string;
  readonly integrity: string;
}
export interface ConsumerReceipt {
  readonly schemaVersion: 1;
  readonly synthetic: true;
  readonly sourceRepository: "pegma-dev/support-desk";
  readonly sourceCommit: string;
  readonly candidateVersion: string;
  readonly artifacts: readonly ConsumerArtifactBinding[];
  readonly runtime: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly v8: string;
  };
  readonly store: {
    readonly package: "@pegma/storage-core";
    readonly version: "0.4.0";
    readonly adapter: "createMemoryStore";
    readonly durable: false;
  };
  readonly consumers: readonly Readonly<Record<string, unknown>>[];
}
export function consumerArtifactBindings(
  records: readonly ConsumerArtifactRecord[],
  inventory: readonly ReleasePackageDefinition[],
): Promise<ConsumerArtifactBinding[]>;
export function verifyConsumerReceipt(
  receipt: unknown,
  options: {
    readonly sourceCommit: string;
    readonly records: readonly ConsumerArtifactRecord[];
    readonly inventory: readonly ReleasePackageDefinition[];
  },
): Promise<ConsumerReceipt>;
export function consumerPlans(
  records: readonly ConsumerPackageRecord[],
  inventory: readonly ReleasePackageDefinition[],
): {
  readonly version: string;
  readonly base: Readonly<Record<string, string>>;
  readonly ai: Readonly<Record<string, string>>;
};
export interface BaseConsumerResult {
  readonly mode: "omitted" | "disabled";
  readonly webTicketId: string;
  readonly emailTicketId: string;
  readonly freshTicketId: string;
  readonly customerMessages: 4;
  readonly staffNotesPerTicket: 2;
  readonly queueTickets: number;
  readonly omittedOrDisabledAi: true;
  readonly noteIsolation: true;
  readonly legacyWriter: "0.1.1" | null;
  readonly legacyMigrationScope: "web-records-only" | null;
  readonly emailWriter: "candidate";
  readonly forwardOnly: true;
}
export interface PreviousConsumerModule {
  createSupportDeskApplication(options: {
    readonly store: Store;
    readonly clock: Clock;
  }): Pick<
    SupportDeskApplication,
    | "createCustomerTicket"
    | "addNote"
    | "replyAsStaff"
    | "readCustomerTicket"
    | "listStaffQueue"
  >;
}
export function exerciseBaseConsumer(
  modules: {
    readonly application: typeof import("@pegma/support-desk-application");
    readonly storage: Pick<
      typeof import("@pegma/storage-core"),
      "createMemoryStore"
    >;
    readonly templates: typeof import("@pegma/support-desk-templates");
    readonly previousApplication?: PreviousConsumerModule;
  },
  mode?: "omitted" | "disabled",
): Promise<BaseConsumerResult>;
export function inspectConsumerInstallation(
  directory: string,
  records: readonly Pick<ConsumerPackageRecord, "name" | "version">[],
  options?: { readonly noAi?: boolean; readonly previous?: boolean },
): Promise<{
  packageCount: number;
  optionalAiInstalled: boolean;
  previousApplication: "0.1.1" | null;
  previousArtifact: PreviousConsumerArtifact | null;
  previousDependencies: readonly {
    name: string;
    version: string;
    expected: string;
  }[];
}>;
export function verifyReleaseConsumers(options: {
  readonly root: string;
  readonly sourceCommit: string;
  readonly records: readonly ConsumerPackageRecord[];
  readonly inventory: readonly ReleasePackageDefinition[];
  readonly runNpm: typeof runNpm;
  exportSpecifiers(manifest: PublicPackageManifest): readonly string[];
}): Promise<ConsumerReceipt>;
