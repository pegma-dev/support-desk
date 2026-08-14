export interface ReleasePackageDefinition {
  readonly directory: string;
  readonly name: string;
}

export interface ValidationOptions {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly releasePrerelease?: boolean | string;
  readonly expectedReleaseCommit?: string;
  readonly requireClean?: boolean;
  readonly requireMainAncestor?: boolean;
  readonly requireReleaseTag?: boolean;
}

export interface ReleaseCommandOptions extends ValidationOptions {
  readonly manifest?: string;
  readonly output?: string;
}

export interface PublicPackageManifest {
  readonly name: string;
  readonly version: string;
  readonly [key: string]: unknown;
}

export interface ValidatedPackage {
  readonly definition: ReleasePackageDefinition;
  readonly manifest: PublicPackageManifest;
  readonly packageDirectory: string;
}

export interface ValidationResult {
  readonly root: string;
  readonly packages: readonly ValidatedPackage[];
  readonly releaseTag: string | undefined;
}

export const RELEASE_PACKAGES: readonly ReleasePackageDefinition[];

export interface PnpmLockDependency {
  readonly specifier?: string;
  readonly version?: string;
}

export type PnpmLockImporter = {
  readonly [section: string]:
    { readonly [name: string]: PnpmLockDependency } | undefined;
};

export function parseArguments(
  arguments_: readonly string[],
): ReleaseCommandOptions;

export function parsePnpmLockfileImporters(text: string): {
  readonly [importer: string]: PnpmLockImporter;
};

export function unquoteYamlScalar(value: string): string;

export function resolvedVersionSatisfies(
  specifier: string,
  resolvedVersion: string,
): boolean;

export function lockDependencyMatches(
  lockDependency: PnpmLockDependency | undefined,
  specifier: string,
  options?: { readonly workspace?: boolean },
): boolean;

export function runNpm(
  arguments_: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly capture?: boolean;
    readonly allowFailure?: boolean;
  },
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export function validateRepository(
  options?: ValidationOptions,
): Promise<ValidationResult>;

export function validateReleaseTag(options?: {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly expectedReleaseCommit?: string;
}): { headCommit: string; releaseTag: string };

export function decidePublication(
  localIntegrity: string,
  registryIntegrity: string | null,
): "publish" | "skip";

export function prepareRelease(
  options?: ReleaseCommandOptions,
): Promise<{ manifestPath: string; manifest: unknown }>;

export function publishPreparedRelease(
  options?: ReleaseCommandOptions,
): Promise<void>;
