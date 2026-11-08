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
export interface ConsumerPackageRecord {
  readonly name: string;
  readonly directory: string;
  readonly version: string;
  readonly tarballPath: string;
  readonly manifest: PublicPackageManifest;
}
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
  previousDependencies: readonly {
    name: string;
    version: string;
    expected: string;
  }[];
}>;
export function verifyReleaseConsumers(options: {
  readonly root: string;
  readonly records: readonly ConsumerPackageRecord[];
  readonly inventory: readonly ReleasePackageDefinition[];
  readonly runNpm: typeof runNpm;
  exportSpecifiers(manifest: PublicPackageManifest): readonly string[];
}): Promise<{
  schemaVersion: 1;
  synthetic: true;
  candidateVersion: string;
  consumers: readonly Readonly<Record<string, unknown>>[];
}>;
