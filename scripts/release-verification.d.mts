export interface ReleaseIdentity {
  repository: "pegma-dev/support-desk";
  workflow: ".github/workflows/publish.yml";
  environment: "npm-publish";
  tag: string;
  commit: string;
  version: string;
}
export interface PreparedReleaseOptions {
  manifest: string;
  manifestSha256: string;
  releaseTag: string;
  expectedReleaseCommit: string;
  npmCli?: string;
  npmVersion?: string;
}
export interface PreparedPackage {
  name: string;
  version: string;
  directory: string;
  tarball: string;
  integrity: string;
  shasum: string;
  publish: boolean;
  files: readonly { path: string; size: number }[];
  size: number;
  dependencies: Readonly<Record<string, string>>;
  exports: readonly string[];
}
export interface VerifiedRelease {
  identity: Readonly<ReleaseIdentity>;
  manifestPath: string;
  manifestSha256: string;
  packages: readonly Readonly<PreparedPackage>[];
}
export interface ReleasePorts {
  fetch?: typeof globalThis.fetch;
  run?: (
    binary: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ) =>
    | Promise<{ status: number | null; stdout: string; stderr?: string }>
    | {
        status: number | null;
        stdout: string;
        stderr?: string;
      };
  sleep?: (milliseconds: number) => Promise<void>;
}
export const RELEASE_REPOSITORY: "pegma-dev/support-desk";
export const RELEASE_WORKFLOW: ".github/workflows/publish.yml";
export const RELEASE_ENVIRONMENT: "npm-publish";
export const RELEASE_NPM_VERSION: "11.18.0";
export function inspectReleaseTarball(bytes: Uint8Array): {
  packageJson: Record<string, unknown>;
  files: { path: string; size: number }[];
};
export function verifyPreparedRelease(
  options: PreparedReleaseOptions,
): Promise<Readonly<VerifiedRelease>>;
export function preflightRegistry(
  verified: VerifiedRelease,
  ports?: Pick<ReleasePorts, "fetch">,
): Promise<{ name: string; version: string; action: "publish" | "skip" }[]>;
export function verifyProvenanceAudit(
  audit: unknown,
  verified: VerifiedRelease,
): void;
export function assertTrustedPublishingEnvironment(
  env: Record<string, string | undefined>,
  identity: ReleaseIdentity,
): void;
export function verifyRegistryRelease(
  options: PreparedReleaseOptions,
  ports?: ReleasePorts,
): Promise<{
  verified: true;
  identity: Readonly<ReleaseIdentity>;
  manifestSha256: string;
  packages: string[];
}>;
export function publishRegistryRelease(
  options: PreparedReleaseOptions,
  ports?: ReleasePorts,
): Promise<{ published: string[]; skipped: string[]; manifestSha256: string }>;
