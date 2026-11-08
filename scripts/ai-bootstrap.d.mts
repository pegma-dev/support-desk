export const AI_BOOTSTRAP_IDENTITY: Readonly<{
  repository: "pegma-dev/support-desk";
  tag: "v0.1.1-ai-bootstrap";
  sourceCommit: "eddd3526f8bec3a1a80cc7aacd3a4cdcdb950cfe";
  packageName: "@pegma/support-desk-ai";
  version: "0.1.1";
  workflow: ".github/workflows/prepare-ai-bootstrap.yml";
}>;
export const AI_BOOTSTRAP_WARNING: string;
export const AI_BOOTSTRAP_MANIFEST_FILENAME: "bootstrap-manifest.json";
export interface AiBootstrapCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type AiBootstrapCommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => AiBootstrapCommandResult;
export interface AiBootstrapSourceOptions {
  readonly sourceRoot: string;
  readonly toolRoot?: string;
}
export interface AiBootstrapSourceIdentity {
  readonly repository: "pegma-dev/support-desk";
  readonly tag: "v0.1.1-ai-bootstrap";
  readonly sourceCommit: "eddd3526f8bec3a1a80cc7aacd3a4cdcdb950cfe";
  readonly tagObject: string;
  readonly toolCommit: string;
  readonly workflowCommit: string;
  readonly workflow: ".github/workflows/prepare-ai-bootstrap.yml";
}
export interface AiBootstrapArtifact {
  readonly name: "@pegma/support-desk-ai";
  readonly version: "0.1.1";
  readonly filename: "pegma-support-desk-ai-0.1.1.tgz";
  readonly size: number;
  readonly shasum: string;
  readonly integrity: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly files: readonly { readonly path: string; readonly size: number }[];
}
export interface AiBootstrapManifest {
  readonly schemaVersion: 1;
  readonly purpose: "npm-name-registration-only";
  readonly hostUsable: false;
  readonly oidcProvenance: false;
  readonly identity: AiBootstrapSourceIdentity;
  readonly context: {
    readonly manifest: "context/package-manifest.json";
    readonly manifestSha256: string;
    readonly candidateCount: 5;
    readonly importedLocally: true;
  };
  readonly artifact: AiBootstrapArtifact;
  readonly warning: string;
}
export interface AiBootstrapPrepareOptions extends AiBootstrapSourceOptions {
  readonly output: string;
}
export interface AiBootstrapPrepared {
  readonly preparedDirectory: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: AiBootstrapManifest;
}
export interface AiBootstrapVerifyOptions {
  readonly preparedDirectory: string;
  readonly manifestSha256: string;
  readonly expectedToolCommit: string;
}
export interface AiBootstrapRegistryOptions extends AiBootstrapVerifyOptions {
  readonly artifactArchive: string;
  readonly artifactSha256: string;
}
export interface AiBootstrapRegistryReceipt {
  readonly identity: AiBootstrapSourceIdentity;
  readonly manifestSha256: string;
  readonly contextManifestSha256: string;
  readonly artifactSha256: string;
  readonly name: "@pegma/support-desk-ai";
  readonly version: "0.1.1";
  readonly action: "publish" | "skip";
  readonly distTags: Readonly<Record<string, string>>;
  readonly oidcProvenance: false;
  readonly hostUsable: false;
  readonly maintainerCommand: string;
  readonly warning: string;
}
export interface AiBootstrapPreparationSeams {
  readonly run?: AiBootstrapCommandRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}
export interface AiBootstrapRegistrySeams {
  readonly fetch?: typeof globalThis.fetch;
}
export function validateAiBootstrapSource(
  options: AiBootstrapSourceOptions,
  seams?: AiBootstrapPreparationSeams,
): Promise<AiBootstrapSourceIdentity>;
export function prepareAiBootstrap(
  options: AiBootstrapPrepareOptions,
  seams?: AiBootstrapPreparationSeams,
): Promise<AiBootstrapPrepared>;
export function verifyAiBootstrapPrepared(
  options: AiBootstrapVerifyOptions,
): Promise<AiBootstrapPrepared>;
export function preflightAiBootstrap(
  options: AiBootstrapRegistryOptions,
  seams?: AiBootstrapRegistrySeams,
): Promise<AiBootstrapRegistryReceipt>;
export function postflightAiBootstrap(
  options: AiBootstrapRegistryOptions,
  seams?: AiBootstrapRegistrySeams,
): Promise<AiBootstrapRegistryReceipt>;
export function parseAiBootstrapArguments(args: readonly string[]): {
  readonly command: "verify-source" | "prepare" | "preflight" | "postflight";
  readonly options: Record<string, string>;
};
