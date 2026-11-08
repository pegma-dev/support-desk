import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { vi } from "vitest";
import type { ReleasePorts } from "../scripts/release-verification.mjs";

export const releaseVerificationVersion = "0.2.0";
/** Read only the checkout's public commit identity; no Git process or config. */
export function releaseCheckoutCommit(root = process.cwd()) {
  const dotGit = join(root, ".git");
  const gitDirectory = statSync(dotGit).isDirectory()
    ? dotGit
    : resolve(
        root,
        readFileSync(dotGit, "utf8")
          .trim()
          .replace(/^gitdir: /, ""),
      );
  const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();
  if (/^[0-9a-f]{40,64}$/.test(head)) return head;
  if (!head.startsWith("ref: refs/"))
    throw new Error("Synthetic release fixture needs a committed checkout");
  const reference = head.slice(5);
  const commonPath = join(gitDirectory, "commondir");
  const commonDirectory = existsSync(commonPath)
    ? resolve(gitDirectory, readFileSync(commonPath, "utf8").trim())
    : gitDirectory;
  for (const directory of [gitDirectory, commonDirectory]) {
    const loose = join(directory, reference);
    if (existsSync(loose)) {
      const commit = readFileSync(loose, "utf8").trim();
      if (/^[0-9a-f]{40,64}$/.test(commit)) return commit;
    }
    const packed = join(directory, "packed-refs");
    if (existsSync(packed)) {
      const commit = readFileSync(packed, "utf8")
        .split(/\r?\n/)
        .find((line) => line.endsWith(` ${reference}`))
        ?.split(" ")[0];
      if (commit !== undefined && /^[0-9a-f]{40,64}$/.test(commit))
        return commit;
    }
  }
  throw new Error(
    "Synthetic release fixture could not resolve its checkout commit",
  );
}
export const releaseVerificationCommit = releaseCheckoutCommit();
export const releaseVerificationPackages = [
  {
    directory: "contracts",
    name: "@pegma/support-desk-contracts",
    dependencies: { "@pegma/spine": "0.1.2" },
  },
  {
    directory: "core",
    name: "@pegma/support-desk-core",
    dependencies: {
      "@pegma/support-desk-contracts": releaseVerificationVersion,
    },
  },
  {
    directory: "templates",
    name: "@pegma/support-desk-templates",
    dependencies: {},
  },
  {
    directory: "application",
    name: "@pegma/support-desk-application",
    dependencies: {
      "@pegma/audit": "0.2.0",
      "@pegma/authorization-core": "0.4.0",
      "@pegma/mail": "0.1.1",
      "@pegma/spine": "0.1.2",
      "@pegma/storage-core": "0.4.0",
      "@pegma/support-desk-contracts": releaseVerificationVersion,
      "@pegma/support-desk-core": releaseVerificationVersion,
    },
  },
  {
    directory: "ai",
    name: "@pegma/support-desk-ai",
    dependencies: {
      "@pegma/authorization-core": "0.4.0",
      "@pegma/knowledge-base-application": "0.1.2",
      "@pegma/knowledge-base-contracts": "0.1.2",
      "@pegma/spine": "0.1.2",
      "@pegma/support-desk-application": releaseVerificationVersion,
    },
  },
] as const;

export function releaseDigest(
  algorithm: "sha1" | "sha256" | "sha512",
  bytes: Uint8Array,
  encoding: "hex" | "base64" = "hex",
) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

/** Real deterministic ustar/gzip bytes, without npm, Git, a shell or a network. */
export function releaseFixtureTarball(manifest: Record<string, unknown>) {
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "README.md": "Synthetic release verification package.\n",
    LICENSE: "MIT synthetic release verification fixture.\n",
    "dist/index.js": "export const syntheticRelease = true;\n",
    "dist/index.d.ts": "export declare const syntheticRelease = true;\n",
  };
  if (
    typeof manifest.exports === "object" &&
    manifest.exports !== null &&
    "./retiregolden" in manifest.exports
  ) {
    files["dist/retiregolden.js"] =
      "export const syntheticRetireGolden = true;\n";
    files["dist/retiregolden.d.ts"] =
      "export declare const syntheticRetireGolden = true;\n";
  }
  const chunks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const content = Buffer.from(text);
    const header = Buffer.alloc(512);
    const write = (value: string, offset: number, length: number) => {
      if (Buffer.byteLength(value) >= length)
        throw new Error("Synthetic tar field exceeds its bound");
      header.write(value, offset, length, "utf8");
    };
    const octal = (value: number, offset: number, length: number) =>
      write(value.toString(8).padStart(length - 1, "0"), offset, length);
    write(`package/${name}`, 0, 100);
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(content.length, 124, 12);
    octal(0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    write("ustar", 257, 6);
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(
      header,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1_024));
  return {
    bytes: gzipSync(Buffer.concat(chunks)),
    files: Object.entries(files)
      .map(([path, content]) => ({ path, size: Buffer.byteLength(content) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

/** The manifest pin is captured before any registry fixture or tampering occurs. */
export function releaseArtifactFixture() {
  const temporaryParent = realpathSync(tmpdir());
  const prefix = join(temporaryParent, "support-desk-release-verification-");
  const root = mkdtempSync(prefix);
  const directory = join(root, ".release");
  mkdirSync(directory);
  const packages = releaseVerificationPackages.map((definition) => {
    const packageJson = {
      name: definition.name,
      version: releaseVerificationVersion,
      license: "MIT",
      type: "module",
      engines: { node: ">=22" },
      publishConfig: { access: "public" },
      repository: {
        type: "git",
        url: "git+https://github.com/pegma-dev/support-desk.git",
        directory: `packages/${definition.directory}`,
      },
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        ...(definition.directory === "templates"
          ? {
              "./retiregolden": {
                types: "./dist/retiregolden.d.ts",
                import: "./dist/retiregolden.js",
              },
            }
          : {}),
      },
      files: ["dist/**"],
      dependencies: structuredClone(definition.dependencies),
    };
    const packed = releaseFixtureTarball(packageJson);
    const tarball = `${definition.name.slice(1).replace("/", "-")}-${releaseVerificationVersion}.tgz`;
    writeFileSync(join(directory, tarball), packed.bytes);
    const packageDirectory = join(root, "packages", definition.directory);
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      join(packageDirectory, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    const record = {
      name: definition.name,
      version: releaseVerificationVersion,
      directory: definition.directory,
      tarball,
      integrity: `sha512-${releaseDigest("sha512", packed.bytes, "base64")}`,
      shasum: releaseDigest("sha1", packed.bytes),
      publish: true,
      files: packed.files,
    };
    return { record, packageJson, bytes: packed.bytes };
  });
  const manifest = {
    schemaVersion: 1,
    gitCommit: releaseVerificationCommit,
    releaseTag: `v${releaseVerificationVersion}`,
    packages: packages.map((entry) => entry.record),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = join(directory, "package-manifest.json");
  writeFileSync(manifestPath, manifestBytes);
  const originalManifestSha256 = releaseDigest("sha256", manifestBytes);
  return {
    root,
    directory,
    packages,
    manifest,
    manifestPath,
    manifestBytes,
    originalManifestSha256,
    dispose() {
      if (!resolve(root).startsWith(resolve(prefix)))
        throw new Error(
          "Synthetic release cleanup escaped its temporary directory",
        );
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function der(tag: number, value: Uint8Array) {
  const content = Buffer.from(value);
  let length: Buffer;
  if (content.length < 128) length = Buffer.from([content.length]);
  else {
    const octets: number[] = [];
    let remaining = content.length;
    while (remaining > 0) {
      octets.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    }
    length = Buffer.from([0x80 | octets.length, ...octets]);
  }
  return Buffer.concat([Buffer.from([tag]), length, content]);
}
const sequence = (...values: Uint8Array[]) => der(0x30, Buffer.concat(values));
const oid = (hex: string) => der(0x06, Buffer.from(hex, "hex"));
const auditKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

/** Real DER, self-signed only for the controlled external npm-audit test double. */
export function releaseAuditCertificate(
  options: { identity?: string; issuer?: string } = {},
) {
  const algorithm = sequence(oid("2a8648ce3d040302"));
  const name = sequence(
    der(
      0x31,
      sequence(
        oid("550403"),
        der(0x0c, Buffer.from("Synthetic release audit fixture")),
      ),
    ),
  );
  const extensions = der(
    0xa3,
    sequence(
      sequence(
        oid("551d11"),
        der(
          0x04,
          sequence(
            der(
              0x86,
              Buffer.from(
                options.identity ??
                  "https://github.com/pegma-dev/support-desk/.github/workflows/publish.yml@refs/tags/v0.2.0",
              ),
            ),
          ),
        ),
      ),
      sequence(
        oid("2b0601040183bf300101"),
        der(
          0x04,
          Buffer.from(
            options.issuer ?? "https://token.actions.githubusercontent.com",
          ),
        ),
      ),
    ),
  );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    algorithm,
    name,
    sequence(
      der(0x17, Buffer.from("260101000000Z")),
      der(0x17, Buffer.from("491231235959Z")),
    ),
    name,
    auditKey.publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  return sequence(
    tbs,
    algorithm,
    der(
      0x03,
      Buffer.concat([
        Buffer.from([0]),
        sign("sha256", tbs, auditKey.privateKey),
      ]),
    ),
  ).toString("base64");
}

export interface ReleaseAuditStatement {
  _type: string;
  subject: { name: string; digest: { sha512: string } }[];
  predicateType: string;
  predicate: {
    buildDefinition: {
      buildType: string;
      externalParameters: {
        workflow: { repository: string; path: string; ref: string };
      };
      internalParameters: { github: { event_name: string } };
      resolvedDependencies: { uri: string; digest: { gitCommit: string } }[];
    };
    runDetails: { builder: { id: string } };
  };
}
export interface ReleaseAudit {
  invalid: unknown[];
  missing: unknown[];
  verified: {
    name: string;
    version: string;
    location: string;
    registry: string;
    attestationBundles: {
      predicateType: string;
      bundle: {
        verificationMaterial: { certificate: { rawBytes: string } };
        dsseEnvelope: {
          payloadType: string;
          payload: string;
          signatures: { keyid: string; sig: string }[];
        };
      };
    }[];
  }[];
}

export function releaseAuditFixture(
  f: ReturnType<typeof releaseArtifactFixture>,
): ReleaseAudit {
  const certificate = releaseAuditCertificate();
  return {
    invalid: [],
    missing: [],
    verified: f.packages.map(({ record }) => {
      const statement: ReleaseAuditStatement = {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [
          {
            name: `pkg:npm/${record.name.split("/").map(encodeURIComponent).join("/")}@${record.version}`,
            digest: {
              sha512: Buffer.from(record.integrity.slice(7), "base64").toString(
                "hex",
              ),
            },
          },
        ],
        predicate: {
          buildDefinition: {
            buildType:
              "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
            externalParameters: {
              workflow: {
                repository: "https://github.com/pegma-dev/support-desk",
                path: ".github/workflows/publish.yml",
                ref: "refs/tags/v0.2.0",
              },
            },
            internalParameters: { github: { event_name: "release" } },
            resolvedDependencies: [
              {
                uri: "git+https://github.com/pegma-dev/support-desk@refs/tags/v0.2.0",
                digest: { gitCommit: releaseVerificationCommit },
              },
            ],
          },
          runDetails: {
            builder: { id: "https://github.com/actions/runner/github-hosted" },
          },
        },
      };
      return {
        name: record.name,
        version: record.version,
        location: `node_modules/${record.name}`,
        registry: "https://registry.npmjs.org/",
        attestationBundles: [
          {
            predicateType: statement.predicateType,
            bundle: {
              verificationMaterial: { certificate: { rawBytes: certificate } },
              dsseEnvelope: {
                payloadType: "application/vnd.in-toto+json",
                payload: Buffer.from(JSON.stringify(statement)).toString(
                  "base64",
                ),
                signatures: [
                  {
                    keyid: "synthetic-sigstore-key",
                    sig: "synthetic-authenticated-signature",
                  },
                ],
              },
            },
          },
        ],
      };
    }),
  };
}

export function releaseAuditStatement(
  audit: ReleaseAudit,
  index = 0,
): ReleaseAuditStatement {
  return JSON.parse(
    Buffer.from(
      audit.verified[index]!.attestationBundles[0]!.bundle.dsseEnvelope.payload,
      "base64",
    ).toString("utf8"),
  ) as ReleaseAuditStatement;
}
export function setReleaseAuditStatement(
  audit: ReleaseAudit,
  statement: ReleaseAuditStatement,
  index = 0,
) {
  audit.verified[index]!.attestationBundles[0]!.bundle.dsseEnvelope.payload =
    Buffer.from(JSON.stringify(statement)).toString("base64");
}

export function releaseRegistryFixture(
  f: ReturnType<typeof releaseArtifactFixture>,
) {
  const registry = "https://registry.npmjs.org/";
  const metadataUrl = (name: string) =>
    `${registry}${encodeURIComponent(name)}/0.2.0`;
  const packageUrl = (name: string) => `${registry}${encodeURIComponent(name)}`;
  const tarballUrl = (name: string) =>
    `${registry}${name}/-/${name.split("/").at(-1)}-0.2.0.tgz`;
  const documents = new Map(
    f.packages.map(({ record, packageJson }) => [
      metadataUrl(record.name),
      {
        ...packageJson,
        dist: {
          integrity: record.integrity,
          shasum: record.shasum,
          tarball: tarballUrl(record.name),
          signatures: [
            {
              keyid: "SHA256:synthetic-registry-signing-key",
              sig: "synthetic-signature",
            },
          ],
          attestations: {
            url: `${registry}-/npm/v1/attestations/${encodeURIComponent(record.name)}@0.2.0`,
            provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          },
        },
      },
    ]),
  );
  const tarballs = new Map(
    f.packages.map(({ record, bytes }) => [
      tarballUrl(record.name),
      Buffer.from(bytes),
    ]),
  );
  const packuments = new Map(
    f.packages.map(({ record }) => [
      packageUrl(record.name),
      {
        name: record.name,
        "dist-tags": { latest: "0.2.0" } as Record<string, string>,
      },
    ]),
  );
  const audit = releaseAuditFixture(f);
  type LockEntry = {
    version: string;
    resolved: string;
    integrity: string;
    dependencies: Record<string, string>;
    link?: boolean;
  };
  type Lock = { lockfileVersion: number; packages: Record<string, LockEntry> };
  const state = {
    metadataFailures: 0,
    tarballFailures: 0,
    metadataStatus: 200,
    installStatus: 0,
    auditStatus: 0,
    importStatus: 0,
    npmVersion: "11.18.0",
    imports: 0,
    auditJson: undefined as string | undefined,
    consumerSource: "",
    consumerDependencies: {} as Record<string, string>,
    mutateLock: undefined as ((lock: Lock) => void) | undefined,
  };
  const npmCli = join(f.root, "npm-cli.js");
  writeFileSync(
    npmCli,
    "// Controlled external-process fixture; never executed.\n",
  );
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const document = documents.get(url);
    if (document !== undefined) {
      if (state.metadataFailures > 0) {
        state.metadataFailures -= 1;
        return new Response("missing", { status: 404 });
      }
      return new Response(JSON.stringify(document), {
        status: state.metadataStatus,
      });
    }
    const packument = packuments.get(url);
    if (packument !== undefined)
      return new Response(JSON.stringify(packument), { status: 200 });
    const bytes = tarballs.get(url);
    if (bytes !== undefined) {
      if (state.tarballFailures > 0) {
        state.tarballFailures -= 1;
        return new Response("missing", { status: 404 });
      }
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      });
    }
    return new Response("missing", { status: 404 });
  });
  const run = vi.fn<NonNullable<ReleasePorts["run"]>>(
    async (_binary, args, processOptions) => {
      if (args.length === 1 && args[0]!.endsWith("consumer.mjs")) {
        state.imports += 1;
        state.consumerSource = readFileSync(args[0]!, "utf8");
        return { status: state.importStatus, stdout: "" };
      }
      if (args[0] !== npmCli)
        throw new Error(
          "Unexpected external process in synthetic release verification",
        );
      const command = args.slice(1);
      if (command[0] === "--version")
        return { status: 0, stdout: `${state.npmVersion}\n` };
      if (command[0] === "install") {
        if (!command.includes("--ignore-scripts"))
          throw new Error("Synthetic consumer refuses lifecycle execution");
        state.consumerDependencies = (
          JSON.parse(
            readFileSync(join(processOptions.cwd, "package.json"), "utf8"),
          ) as { dependencies: Record<string, string> }
        ).dependencies;
        const lock: Lock = {
          lockfileVersion: 3,
          packages: Object.fromEntries(
            f.packages
              .filter(({ record }) =>
                Object.hasOwn(state.consumerDependencies, record.name),
              )
              .map(({ record, packageJson }) => [
                `node_modules/${record.name}`,
                {
                  version: record.version,
                  resolved: tarballUrl(record.name),
                  integrity: record.integrity,
                  dependencies: structuredClone(packageJson.dependencies),
                },
              ]),
          ),
        };
        state.mutateLock?.(lock);
        writeFileSync(
          join(processOptions.cwd, "package-lock.json"),
          JSON.stringify(lock),
        );
        return { status: state.installStatus, stdout: "{}" };
      }
      if (
        command[0] === "audit" &&
        command[1] === "signatures" &&
        command.includes("--include-attestations")
      )
        return {
          status: state.auditStatus,
          stdout:
            state.auditJson ??
            JSON.stringify({
              ...audit,
              verified: audit.verified.filter(({ name }) =>
                Object.hasOwn(state.consumerDependencies, name),
              ),
            }),
        };
      throw new Error(
        "Synthetic release verification forbids publish, pack and unknown commands",
      );
    },
  );
  const sleep = vi.fn<NonNullable<ReleasePorts["sleep"]>>(async () => {});
  return {
    documents,
    tarballs,
    packuments,
    audit,
    state,
    npmCli,
    metadataUrl,
    packageUrl,
    tarballUrl,
    ports: { fetch, run, sleep },
    fetch,
    run,
    sleep,
  };
}

/** Set the real runtime guard's inputs; never supplies an authorization bypass. */
export function useReleasePublishingEnvironment() {
  for (const key of Object.keys(process.env))
    if (
      /^npm_config_/iu.test(key) ||
      [
        "NODE_AUTH_TOKEN",
        "NPM_TOKEN",
        "NPM_AUTH_TOKEN",
        "NPM_AUTH",
        "YARN_NPM_AUTH_TOKEN",
      ].includes(key)
    )
      vi.stubEnv(key, undefined);
  const env = releasePublishingEnvironment();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return env;
}

/** Controlled external acceptance only; publication policy remains in the real CLI. */
export function releasePublisherFixture(
  f: ReturnType<typeof releaseArtifactFixture>,
) {
  const registry = releaseRegistryFixture(f);
  const originals = new Map(
    [...registry.documents].map(([url, document]) => [
      url,
      structuredClone(document),
    ]),
  );
  const trace: (
    { kind: "fetch"; url: string } | { kind: "publish"; name: string }
  )[] = [];
  const uploads: {
    name: string;
    binary: string;
    args: string[];
    path: string;
    cwd: string;
    bytes: Buffer;
    sha256: string;
    integrity: string;
    env: Record<string, string>;
    userConfig: string;
    globalConfig: string;
  }[] = [];
  const publication = {
    uncertainPackage: undefined as string | undefined,
    uncertainty: "exit" as "exit" | "throw",
  };
  const hide = (name: string) => {
    registry.documents.delete(registry.metadataUrl(name));
    registry.tarballs.delete(registry.tarballUrl(name));
  };
  const accept = (name: string, bytes: Buffer) => {
    const document = originals.get(registry.metadataUrl(name));
    if (document === undefined)
      throw new Error("Unknown synthetic publication package");
    registry.documents.set(
      registry.metadataUrl(name),
      structuredClone(document),
    );
    registry.tarballs.set(registry.tarballUrl(name), Buffer.from(bytes));
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    trace.push({ kind: "fetch", url });
    return registry.fetch(input, init);
  });
  const run = vi.fn<NonNullable<ReleasePorts["run"]>>(
    async (binary, args, processOptions) => {
      if (args[1] === "install" || args[1] === "audit")
        throw new Error(
          "OIDC publication must not run registry crypto consumers",
        );
      if (args[0] === registry.npmCli && args[1] === "--version")
        return { status: 0, stdout: `${registry.state.npmVersion}\n` };
      if (args[0] !== registry.npmCli || args[1] !== "publish")
        throw new Error(
          "Synthetic publisher only permits pinned npm publication",
        );
      const path = args[2];
      if (path === undefined)
        throw new Error("Synthetic publication needs a copied tarball");
      const entry = f.packages.find(
        ({ record }) => record.tarball === basename(path),
      );
      if (entry === undefined)
        throw new Error("Unexpected synthetic publication archive");
      const bytes = readFileSync(path);
      trace.push({ kind: "publish", name: entry.record.name });
      uploads.push({
        name: entry.record.name,
        binary,
        args: [...args],
        path,
        cwd: processOptions.cwd,
        bytes,
        sha256: releaseDigest("sha256", bytes),
        integrity: `sha512-${releaseDigest("sha512", bytes, "base64")}`,
        env: { ...processOptions.env },
        userConfig: readFileSync(
          processOptions.env.npm_config_userconfig!,
          "utf8",
        ),
        globalConfig: readFileSync(
          processOptions.env.npm_config_globalconfig!,
          "utf8",
        ),
      });
      accept(entry.record.name, bytes);
      if (publication.uncertainPackage === entry.record.name) {
        if (publication.uncertainty === "throw")
          throw new Error("PRIVATE_SYNTHETIC_AFTER_ACCEPTANCE_FAILURE");
        return {
          status: 1,
          stdout: "",
          stderr: "PRIVATE_SYNTHETIC_AFTER_ACCEPTANCE_FAILURE",
        };
      }
      return { status: 0, stdout: "{}" };
    },
  );
  return {
    ...registry,
    trace,
    uploads,
    publication,
    hide,
    accept,
    preflightPorts: registry.ports,
    preflightRun: registry.run,
    fetch,
    run,
    ports: { fetch, run, sleep: registry.sleep },
    isCopiedUpload(path: string) {
      return dirname(path) !== f.directory;
    },
  };
}

export function releasePublishingEnvironment() {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "release",
    GITHUB_REPOSITORY: "pegma-dev/support-desk",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REF: "refs/tags/v0.2.0",
    GITHUB_SHA: releaseVerificationCommit,
    GITHUB_WORKFLOW_SHA: releaseVerificationCommit,
    GITHUB_WORKFLOW_REF:
      "pegma-dev/support-desk/.github/workflows/publish.yml@refs/tags/v0.2.0",
    RELEASE_ENVIRONMENT: "npm-publish",
    RUNNER_ENVIRONMENT: "github-hosted",
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://synthetic.actions.githubusercontent.com/oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-request-token",
  };
}
