import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertTrustedPublishingEnvironment,
  describeReleaseFailure,
  inspectReleaseTarball,
  preflightRegistry,
  preflightRegistryRelease,
  publishRegistryRelease,
  verifyPreparedRelease,
  verifyProvenanceAudit,
  verifyRegistryRelease,
} from "../scripts/release-verification.mjs";
import {
  releaseArtifactFixture,
  releaseAuditCertificate,
  releaseAuditFixture,
  releaseAuditStatement,
  releaseDigest,
  releaseFixtureTarball,
  releasePublishingEnvironment,
  releasePublisherFixture,
  releaseRegistryFixture,
  setReleaseAuditStatement,
  releaseVerificationCommit,
  releaseVerificationPackages,
  releaseVerificationVersion,
  useReleasePublishingEnvironment,
} from "../test/release-verification-fixtures.js";

type Fixture = ReturnType<typeof releaseArtifactFixture>;
const fixtures = new Set<Fixture>();
let preflightSequence = 0;
function fixture() {
  const value = releaseArtifactFixture();
  fixtures.add(value);
  return value;
}
function options(f: Fixture) {
  return {
    manifest: f.manifestPath,
    manifestSha256: f.originalManifestSha256,
    releaseTag: `v${releaseVerificationVersion}`,
    expectedReleaseCommit: releaseVerificationCommit,
    // Controlled Actions transport outputs, supplied independently of receipt contents.
    preparedArtifactId: "4242000123",
    preparedArtifactSha256: releaseDigest(
      "sha256",
      Buffer.from("controlled-original-actions-archive"),
    ),
  };
}
async function preparePublication(
  f: Fixture,
  publisher: ReturnType<typeof releasePublisherFixture>,
) {
  const unprivileged = [
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "RELEASE_ENVIRONMENT",
  ] as const;
  const previous = unprivileged.map((key) => [key, process.env[key]] as const);
  for (const key of unprivileged) vi.stubEnv(key, undefined);
  let receipt: Awaited<ReturnType<typeof preflightRegistryRelease>>;
  try {
    receipt = await preflightRegistryRelease(
      { ...options(f), npmCli: publisher.npmCli },
      publisher.preflightPorts,
    );
  } finally {
    for (const [key, value] of previous) vi.stubEnv(key, value);
  }
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  preflightSequence += 1;
  const path = join(f.root, `registry-preflight-${preflightSequence}.json`);
  writeFileSync(path, bytes);
  return {
    ...options(f),
    npmCli: publisher.npmCli,
    preflightReceipt: path,
    preflightReceiptSha256: releaseDigest("sha256", bytes),
  };
}
function writeManifest(f: Fixture) {
  const bytes = Buffer.from(`${JSON.stringify(f.manifest, null, 2)}\n`);
  writeFileSync(f.manifestPath, bytes);
  return { ...options(f), manifestSha256: releaseDigest("sha256", bytes) };
}
function replacePackage(
  f: Fixture,
  index: number,
  packageJson: Record<string, unknown>,
) {
  const entry = f.packages[index]!;
  const packed = releaseFixtureTarball(packageJson);
  writeFileSync(join(f.directory, entry.record.tarball), packed.bytes);
  Object.assign(entry.record, {
    integrity: `sha512-${releaseDigest("sha512", packed.bytes, "base64")}`,
    shasum: releaseDigest("sha1", packed.bytes),
    files: packed.files,
  });
  return writeManifest(f);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const value of fixtures) value.dispose();
  fixtures.clear();
});

describe("actual publication orchestration with controlled external acceptance", () => {
  it("preflights the entire mixed set before publishing only absent packages in dependency order", async () => {
    const f = fixture();
    const publisher = releasePublisherFixture(f);
    useReleasePublishingEnvironment();
    const present = f.packages.slice(0, 3).map(({ record }) => record.name);
    const absent = f.packages.filter(
      ({ record }) => !present.includes(record.name),
    );
    for (const { record } of absent) publisher.hide(record.name);
    const prepared = await preparePublication(f, publisher);
    const result = await publishRegistryRelease(prepared, publisher.ports);
    expect(result).toEqual({
      published: absent.map(({ record }) => record.name),
      skipped: present,
      manifestSha256: f.originalManifestSha256,
    });
    expect(publisher.uploads.map(({ name }) => name)).toEqual(
      absent.map(({ record }) => record.name),
    );
    const firstUpload = publisher.trace.findIndex(
      (entry) => entry.kind === "publish",
    );
    expect(firstUpload).toBeGreaterThan(0);
    for (const { record } of f.packages)
      expect(publisher.trace.slice(0, firstUpload)).toContainEqual({
        kind: "fetch",
        url: publisher.metadataUrl(record.name),
      });
    for (const { name } of publisher.uploads)
      expect(present).not.toContain(name);
    expect(publisher.state.consumerDependencies).toEqual(
      Object.fromEntries(present.map((name) => [name, "0.2.6"])),
    );
    expect(
      publisher.preflightRun.mock.calls.map(([, args]) => args[1]),
    ).toEqual(["--version", "install", "audit"]);
    for (const [, , processOptions] of publisher.preflightRun.mock.calls) {
      expect(processOptions.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
      expect(processOptions.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    }
    expect(
      publisher.run.mock.calls.some(
        ([, args]) => args[1] === "install" || args[1] === "audit",
      ),
    ).toBe(false);
    expect(publisher.state.imports).toBe(0);
  });

  it("uploads exact copied originals with the precise provenance argv and an OIDC-only child environment", async () => {
    const f = fixture();
    const publisher = releasePublisherFixture(f);
    const oidc = useReleasePublishingEnvironment();
    vi.stubEnv(
      "SYNTHETIC_RELEASE_AMBIENT_SECRET",
      "must-not-reach-the-publish-child",
    );
    for (const { record } of f.packages) publisher.hide(record.name);
    const prepared = await preparePublication(f, publisher);
    expect(
      JSON.parse(readFileSync(prepared.preflightReceipt, "utf8")),
    ).toMatchObject({
      authentication: "none-existing",
      npmVersion: null,
      existingPackages: [],
    });
    expect(publisher.preflightRun).not.toHaveBeenCalled();
    const result = await publishRegistryRelease(prepared, publisher.ports);
    expect(result.published).toEqual(
      f.packages.map(({ record }) => record.name),
    );
    expect(result.skipped).toEqual([]);
    expect(publisher.uploads).toHaveLength(5);
    publisher.uploads.forEach((upload, index) => {
      const original = f.packages[index]!;
      expect(upload.name).toBe(original.record.name);
      expect(upload.binary).toBe(process.execPath);
      expect(upload.path).toBe(join(upload.cwd, original.record.tarball));
      expect(publisher.isCopiedUpload(upload.path)).toBe(true);
      expect(upload.args).toEqual([
        publisher.npmCli,
        "publish",
        upload.path,
        "--access",
        "public",
        "--provenance",
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org/",
      ]);
      expect(upload.bytes).toEqual(original.bytes);
      expect(upload.sha256).toBe(releaseDigest("sha256", original.bytes));
      expect(upload.integrity).toBe(original.record.integrity);
      expect(upload.userConfig).toBe("");
      expect(upload.globalConfig).toBe("");
      expect(upload.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe(
        oidc.ACTIONS_ID_TOKEN_REQUEST_URL,
      );
      expect(upload.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(
        oidc.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      );
      expect(upload.env.GITHUB_REPOSITORY).toBe("pegma-dev/support-desk");
      expect(upload.env.GITHUB_SHA).toBe(releaseVerificationCommit);
      expect(upload.env.GITHUB_WORKFLOW_REF).toBe(oidc.GITHUB_WORKFLOW_REF);
      expect(upload.env.NODE_AUTH_TOKEN).toBeUndefined();
      expect(upload.env.NPM_TOKEN).toBeUndefined();
      expect(upload.env.SYNTHETIC_RELEASE_AMBIENT_SECRET).toBeUndefined();
      expect(upload.env.npm_config_registry).toBe(
        "https://registry.npmjs.org/",
      );
      expect(upload.env.npm_config_ignore_scripts).toBe("true");
      expect(readFileSync(join(f.directory, original.record.tarball))).toEqual(
        original.bytes,
      );
    });
    expect(readFileSync(f.manifestPath)).toEqual(f.manifestBytes);
  });

  it("never invokes publication for a completely present exact release", async () => {
    const f = fixture();
    const publisher = releasePublisherFixture(f);
    useReleasePublishingEnvironment();
    const prepared = await preparePublication(f, publisher);
    expect(await publishRegistryRelease(prepared, publisher.ports)).toEqual({
      published: [],
      skipped: f.packages.map(({ record }) => record.name),
      manifestSha256: f.originalManifestSha256,
    });
    expect(publisher.uploads).toEqual([]);
    expect(
      publisher.run.mock.calls.some(([, args]) => args[1] === "publish"),
    ).toBe(false);
  });

  it("blocks every publication when a later existing package fails whole-set byte preflight", async () => {
    const f = fixture();
    const publisher = releasePublisherFixture(f);
    useReleasePublishingEnvironment();
    for (const index of [1, 3, 4])
      publisher.hide(f.packages[index]!.record.name);
    const prepared = await preparePublication(f, publisher);
    const last = f.packages[2]!.record.name;
    const bytes = Buffer.from(
      publisher.tarballs.get(publisher.tarballUrl(last))!,
    );
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    publisher.tarballs.set(publisher.tarballUrl(last), bytes);
    await expect(
      publishRegistryRelease(prepared, publisher.ports),
    ).rejects.toThrow();
    expect(publisher.uploads).toEqual([]);
    expect(publisher.run).not.toHaveBeenCalled();
  });

  it.each([
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "NPM_AUTH_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ])(
    "refuses actual publication before registry access with unapproved %s authority",
    async (key) => {
      const f = fixture();
      const publisher = releasePublisherFixture(f);
      useReleasePublishingEnvironment();
      const prepared = await preparePublication(f, publisher);
      vi.stubEnv(
        key,
        key === "ACTIONS_ID_TOKEN_REQUEST_TOKEN"
          ? ""
          : "synthetic-unapproved-token",
      );
      await expect(
        publishRegistryRelease(prepared, publisher.ports),
      ).rejects.toThrow();
      expect(publisher.fetch).not.toHaveBeenCalled();
      expect(publisher.run).not.toHaveBeenCalled();
      expect(publisher.uploads).toEqual([]);
    },
  );

  it.each(["exit", "throw"] as const)(
    "stops after uncertain acceptance (%s) and resumes only still-absent packages from the unchanged artifact",
    async (uncertainty) => {
      const f = fixture();
      const publisher = releasePublisherFixture(f);
      useReleasePublishingEnvironment();
      for (const { record } of f.packages) publisher.hide(record.name);
      publisher.publication.uncertainPackage = f.packages[1]!.record.name;
      publisher.publication.uncertainty = uncertainty;
      const expected = await preparePublication(f, publisher);
      const failure = await publishRegistryRelease(
        expected,
        publisher.ports,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain("PRIVATE_SYNTHETIC");
      expect(publisher.uploads.map(({ name }) => name)).toEqual(
        f.packages.slice(0, 2).map(({ record }) => record.name),
      );
      expect(
        publisher.documents.has(
          publisher.metadataUrl(f.packages[1]!.record.name),
        ),
      ).toBe(true);
      publisher.publication.uncertainPackage = undefined;
      await expect(
        publishRegistryRelease(expected, publisher.ports),
      ).rejects.toThrow();
      expect(publisher.uploads).toHaveLength(2);
      const refreshed = await preparePublication(f, publisher);
      expect(refreshed.manifestSha256).toBe(expected.manifestSha256);
      const recovered = await publishRegistryRelease(
        refreshed,
        publisher.ports,
      );
      expect(recovered).toEqual({
        published: f.packages.slice(2).map(({ record }) => record.name),
        skipped: f.packages.slice(0, 2).map(({ record }) => record.name),
        manifestSha256: f.originalManifestSha256,
      });
      expect(publisher.uploads.map(({ name }) => name)).toEqual(
        f.packages.map(({ record }) => record.name),
      );
      for (const original of f.packages) {
        expect(
          publisher.uploads.filter(({ name }) => name === original.record.name),
        ).toHaveLength(1);
        expect(
          readFileSync(join(f.directory, original.record.tarball)),
        ).toEqual(original.bytes);
      }
      expect(readFileSync(f.manifestPath)).toEqual(f.manifestBytes);
    },
  );

  it("does not skip or republish an uncertain accepted version whose visible bytes differ on retry", async () => {
    const f = fixture();
    const publisher = releasePublisherFixture(f);
    useReleasePublishingEnvironment();
    for (const { record } of f.packages) publisher.hide(record.name);
    const first = f.packages[0]!.record.name;
    publisher.publication.uncertainPackage = first;
    const expected = await preparePublication(f, publisher);
    await expect(
      publishRegistryRelease(expected, publisher.ports),
    ).rejects.toThrow();
    const altered = Buffer.from(
      publisher.tarballs.get(publisher.tarballUrl(first))!,
    );
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 0xff;
    publisher.tarballs.set(publisher.tarballUrl(first), altered);
    publisher.publication.uncertainPackage = undefined;
    await expect(preparePublication(f, publisher)).rejects.toThrow();
    await expect(
      publishRegistryRelease(expected, publisher.ports),
    ).rejects.toThrow();
    expect(publisher.uploads.map(({ name }) => name)).toEqual([first]);
  });

  it("rejects an original archive changed after preflight instead of copying or publishing its replacement", async () => {
    const f = fixture();
    const publisher = releasePublisherFixture(f);
    useReleasePublishingEnvironment();
    for (const { record } of f.packages) publisher.hide(record.name);
    const prepared = await preparePublication(f, publisher);
    const invoke = publisher.run.getMockImplementation()!;
    let changed = false;
    publisher.run.mockImplementation(async (...args) => {
      if (!changed && args[1][1] === "--version") {
        changed = true;
        const altered = Buffer.from(f.packages[0]!.bytes);
        altered[altered.length - 1] = altered[altered.length - 1]! ^ 0xff;
        writeFileSync(
          join(f.directory, f.packages[0]!.record.tarball),
          altered,
        );
      }
      return invoke(...args);
    });
    await expect(
      publishRegistryRelease(prepared, publisher.ports),
    ).rejects.toThrow();
    expect(changed).toBe(true);
    expect(publisher.uploads).toEqual([]);
    expect(readFileSync(f.manifestPath)).toEqual(f.manifestBytes);
  });
});

describe("unprivileged authentication before irreversible recovery", () => {
  it.each(["crypto-failure", "missing-provenance", "foreign-source"] as const)(
    "blocks all remaining uploads when existing exact bytes have %s",
    async (failure) => {
      const f = fixture();
      const publisher = releasePublisherFixture(f);
      useReleasePublishingEnvironment();
      for (const { record } of f.packages.slice(1)) publisher.hide(record.name);
      if (failure === "crypto-failure") publisher.state.auditStatus = 1;
      if (failure === "missing-provenance")
        publisher.audit.verified[0]!.attestationBundles = [];
      if (failure === "foreign-source") {
        const statement = releaseAuditStatement(publisher.audit);
        statement.predicate.buildDefinition.externalParameters.workflow.repository =
          "https://github.com/foreign/support-desk";
        setReleaseAuditStatement(publisher.audit, statement);
      }
      await expect(preparePublication(f, publisher)).rejects.toThrow();
      expect(
        publisher.preflightRun.mock.calls.some(
          ([, args]) => args[1] === "audit" && args[2] === "signatures",
        ),
      ).toBe(true);
      await expect(
        publishRegistryRelease(
          {
            ...options(f),
            npmCli: publisher.npmCli,
            preflightReceipt: join(f.root, "no-authenticated-receipt.json"),
            preflightReceiptSha256: "0".repeat(64),
          },
          publisher.ports,
        ),
      ).rejects.toThrow();
      expect(publisher.uploads).toEqual([]);
      expect(publisher.run).not.toHaveBeenCalled();
    },
  );

  it.each([
    "missing-file",
    "missing-digest",
    "tampered-bytes",
    "unverified-existing",
    "source",
    "manifest",
    "artifact-id",
    "artifact-digest",
    "added-existing",
    "removed-existing",
  ] as const)(
    "refuses %s preflight evidence before any upload",
    async (failure) => {
      const f = fixture();
      const publisher = releasePublisherFixture(f);
      useReleasePublishingEnvironment();
      for (const { record } of f.packages.slice(1)) publisher.hide(record.name);
      if (failure === "added-existing")
        publisher.hide(f.packages[0]!.record.name);
      const prepared = await preparePublication(f, publisher);
      if (failure === "missing-file") unlinkSync(prepared.preflightReceipt);
      if (failure === "missing-digest") prepared.preflightReceiptSha256 = "";
      if (failure === "tampered-bytes")
        writeFileSync(
          prepared.preflightReceipt,
          `${readFileSync(prepared.preflightReceipt, "utf8")} `,
        );
      if (["unverified-existing", "source", "manifest"].includes(failure)) {
        const receipt = JSON.parse(
          readFileSync(prepared.preflightReceipt, "utf8"),
        );
        if (failure === "unverified-existing")
          receipt.authentication = "none-existing";
        if (failure === "source") receipt.identity.commit = "a".repeat(40);
        if (failure === "manifest") receipt.manifestSha256 = "b".repeat(64);
        const bytes = Buffer.from(JSON.stringify(receipt));
        writeFileSync(prepared.preflightReceipt, bytes);
        prepared.preflightReceiptSha256 = releaseDigest("sha256", bytes);
      }
      if (failure === "artifact-id") prepared.preparedArtifactId = "4242000999";
      if (failure === "artifact-digest")
        prepared.preparedArtifactSha256 = "c".repeat(64);
      if (failure === "added-existing")
        publisher.accept(f.packages[0]!.record.name, f.packages[0]!.bytes);
      if (failure === "removed-existing")
        publisher.hide(f.packages[0]!.record.name);
      await expect(
        publishRegistryRelease(prepared, publisher.ports),
      ).rejects.toThrow();
      expect(publisher.uploads).toEqual([]);
      expect(publisher.run).not.toHaveBeenCalled();
    },
  );

  it("rejects a receipt's altered original artifact binding even with an independently updated receipt digest", async () => {
    const f = fixture();
    const publisher = releasePublisherFixture(f);
    useReleasePublishingEnvironment();
    for (const { record } of f.packages) publisher.hide(record.name);
    const prepared = await preparePublication(f, publisher);
    const receipt = JSON.parse(readFileSync(prepared.preflightReceipt, "utf8"));
    expect(receipt.preparedArtifact).toEqual({
      id: prepared.preparedArtifactId,
      sha256: prepared.preparedArtifactSha256,
    });
    receipt.preparedArtifact.id = "4242000777";
    receipt.preparedArtifact.sha256 = "d".repeat(64);
    const bytes = Buffer.from(JSON.stringify(receipt));
    writeFileSync(prepared.preflightReceipt, bytes);
    prepared.preflightReceiptSha256 = releaseDigest("sha256", bytes);
    await expect(
      publishRegistryRelease(prepared, publisher.ports),
    ).rejects.toThrow();
    expect(publisher.uploads).toEqual([]);
    expect(publisher.run).not.toHaveBeenCalled();
  });

  it("refuses an existing subset whose required candidate dependencies are still absent before running npm", async () => {
    const f = fixture();
    const publisher = releasePublisherFixture(f);
    for (const [index, { record }] of f.packages.entries())
      if (index !== 3) publisher.hide(record.name);
    await expect(preparePublication(f, publisher)).rejects.toThrow();
    expect(publisher.preflightRun).not.toHaveBeenCalled();
    expect(publisher.uploads).toEqual([]);
  });

  it("rejects preflight under actual OIDC authority instead of installing with publish credentials", async () => {
    const f = fixture();
    const publisher = releasePublisherFixture(f);
    useReleasePublishingEnvironment();
    await expect(
      preflightRegistryRelease(
        {
          ...options(f),
          npmCli: publisher.npmCli,
        },
        publisher.preflightPorts,
      ),
    ).rejects.toThrow();
    expect(publisher.preflightRun).not.toHaveBeenCalled();
    expect(publisher.uploads).toEqual([]);
  });

  it("rechecks the existing set after crypto and refuses a newly visible unauthenticated package", async () => {
    const f = fixture();
    const publisher = releasePublisherFixture(f);
    for (const { record } of f.packages.slice(1)) publisher.hide(record.name);
    const invoke = publisher.preflightRun.getMockImplementation()!;
    publisher.preflightRun.mockImplementation(async (...args) => {
      const result = await invoke(...args);
      if (args[1][1] === "audit")
        publisher.accept(f.packages[2]!.record.name, f.packages[2]!.bytes);
      return result;
    });
    await expect(preparePublication(f, publisher)).rejects.toThrow();
    expect(publisher.uploads).toEqual([]);
    expect(publisher.run).not.toHaveBeenCalled();
  });

  it("stops remaining uploads if another package becomes visible after this publisher's first confirmed upload", async () => {
    const f = fixture();
    const publisher = releasePublisherFixture(f);
    useReleasePublishingEnvironment();
    for (const { record } of f.packages) publisher.hide(record.name);
    const prepared = await preparePublication(f, publisher);
    const invoke = publisher.run.getMockImplementation()!;
    publisher.run.mockImplementation(async (...args) => {
      const result = await invoke(...args);
      if (args[1][1] === "publish" && publisher.uploads.length === 1)
        publisher.accept(f.packages[2]!.record.name, f.packages[2]!.bytes);
      return result;
    });
    await expect(
      publishRegistryRelease(prepared, publisher.ports),
    ).rejects.toThrow();
    expect(publisher.uploads.map(({ name }) => name)).toEqual([
      f.packages[0]!.record.name,
    ]);
    expect(publisher.preflightRun).not.toHaveBeenCalled();
  });
});

describe("registry verification of the original bytes", () => {
  it("checks every exact registry tarball, authenticates source provenance and imports all public exports with pinned npm", async () => {
    const f = fixture();
    const registry = releaseRegistryFixture(f);
    const receipt = await verifyRegistryRelease(
      { ...options(f), npmCli: registry.npmCli, npmVersion: "11.18.0" },
      registry.ports,
    );
    expect(receipt).toMatchObject({
      verified: true,
      manifestSha256: f.originalManifestSha256,
      identity: {
        repository: "pegma-dev/support-desk",
        workflow: ".github/workflows/publish.yml",
        environment: "npm-publish",
        tag: "v0.2.6",
        commit: releaseVerificationCommit,
        version: "0.2.6",
      },
      packages: releaseVerificationPackages.map(({ name }) => name),
    });
    expect(receipt.distTags).toHaveLength(5);
    for (const observation of receipt.distTags) {
      expect(observation.version).toBe("0.2.6");
      expect(observation.tags).toEqual({ latest: "0.2.6" });
      expect(Number.isFinite(Date.parse(observation.observedAt))).toBe(true);
      expect(
        registry.fetch.mock.calls.some(
          ([url]) => url === registry.packageUrl(observation.name),
        ),
      ).toBe(true);
    }
    expect(registry.state.consumerDependencies).toEqual(
      Object.fromEntries(
        releaseVerificationPackages.map(({ name }) => [name, "0.2.6"]),
      ),
    );
    expect(registry.state.imports).toBe(1);
    expect(registry.state.consumerSource).toContain(
      'await import("@pegma/support-desk-templates/retiregolden")',
    );
    for (const { name } of releaseVerificationPackages) {
      expect(
        registry.fetch.mock.calls.some(
          ([url]) => url === registry.metadataUrl(name),
        ),
      ).toBe(true);
      expect(
        registry.fetch.mock.calls.some(
          ([url]) => url === registry.tarballUrl(name),
        ),
      ).toBe(true);
      expect(registry.state.consumerSource).toContain(
        `await import(${JSON.stringify(name)})`,
      );
    }
    const commands = registry.run.mock.calls.map(([, args]) => args.slice(1));
    expect(commands).toContainEqual(["--version"]);
    expect(
      commands.some(
        (args) => args[0] === "install" && args.includes("--ignore-scripts"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (args) =>
          args[0] === "audit" &&
          args.includes("signatures") &&
          args.includes("--include-attestations"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (args) => args.includes("pack") || args.includes("publish"),
      ),
    ).toBe(false);
    for (const [binary, , processOptions] of registry.run.mock.calls) {
      expect(binary).toBe(process.execPath);
      expect(processOptions.env.NODE_AUTH_TOKEN).toBeUndefined();
      expect(processOptions.env.NPM_TOKEN).toBeUndefined();
      expect(processOptions.env.npm_config_ignore_scripts).toBe("true");
      expect(processOptions.env.npm_config_registry).toBe(
        "https://registry.npmjs.org/",
      );
    }
    const repeated = await verifyRegistryRelease(
      { ...options(f), npmCli: registry.npmCli, npmVersion: "11.18.0" },
      registry.ports,
    );
    expect(repeated).toMatchObject({
      verified: true,
      identity: receipt.identity,
      manifestSha256: receipt.manifestSha256,
      packages: receipt.packages,
    });
    expect(registry.state.imports).toBe(2);
    expect(
      registry.run.mock.calls.some(
        ([, args]) => args.includes("publish") || args.includes("pack"),
      ),
    ).toBe(false);
    expect(readFileSync(f.manifestPath)).toEqual(f.manifestBytes);
    for (const { record, bytes } of f.packages)
      expect(readFileSync(join(f.directory, record.tarball))).toEqual(bytes);
  });

  it("preflights every existing package as skip only after checking its exact original bytes", async () => {
    const f = fixture();
    const registry = releaseRegistryFixture(f);
    const verified = await verifyPreparedRelease(options(f));
    expect(await preflightRegistry(verified, registry.ports)).toEqual(
      releaseVerificationPackages.map(({ name }) => ({
        name,
        version: "0.2.6",
        action: "skip",
      })),
    );
    expect(registry.run).not.toHaveBeenCalled();
    expect(registry.fetch).toHaveBeenCalledTimes(10);
  });

  it.each(["0.1.1", "0.2.1", "0.2.2", "0.2.3", "0.2.4", "0.2.5", "0.2.6"])(
    "records observed latest=%s without retagging or confusing it with immutable release identity",
    async (latest) => {
      const f = fixture();
      const registry = releaseRegistryFixture(f);
      for (const packument of registry.packuments.values())
        packument["dist-tags"].latest = latest;
      const receipt = await verifyRegistryRelease(
        { ...options(f), npmCli: registry.npmCli },
        registry.ports,
      );
      expect(receipt.identity.version).toBe("0.2.6");
      expect(
        receipt.distTags.map(({ name, version, tags }) => ({
          name,
          version,
          tags,
        })),
      ).toEqual(
        releaseVerificationPackages.map(({ name }) => ({
          name,
          version: "0.2.6",
          tags: { latest },
        })),
      );
      expect(
        registry.run.mock.calls.some(
          ([, args]) => args.includes("dist-tag") || args.includes("publish"),
        ),
      ).toBe(false);
    },
  );

  it.each(["missing", "wrong-name", "too-many-tags", "bad-target"] as const)(
    "withholds the final verification receipt for %s dist-tag evidence",
    async (failure) => {
      const f = fixture();
      const registry = releaseRegistryFixture(f);
      const url = registry.packageUrl(releaseVerificationPackages[0]!.name);
      const packument = registry.packuments.get(url)!;
      if (failure === "missing") registry.packuments.delete(url);
      if (failure === "wrong-name")
        Object.assign(packument, { name: "@foreign/support-desk-contracts" });
      if (failure === "too-many-tags")
        packument["dist-tags"] = Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`tag-${index}`, "0.2.2"]),
        );
      if (failure === "bad-target")
        packument["dist-tags"].latest = "bad\u0000target";
      await expect(
        verifyRegistryRelease(
          { ...options(f), npmCli: registry.npmCli },
          registry.ports,
        ),
      ).rejects.toThrow();
      expect(
        registry.run.mock.calls.some(
          ([, args]) => args.includes("dist-tag") || args.includes("publish"),
        ),
      ).toBe(false);
    },
  );

  it("distinguishes absent versions from metadata whose original tarball is not yet visible", async () => {
    const f = fixture();
    const registry = releaseRegistryFixture(f);
    const verified = await verifyPreparedRelease(options(f));
    const first = releaseVerificationPackages[0]!.name;
    registry.documents.delete(registry.metadataUrl(first));
    expect((await preflightRegistry(verified, registry.ports))[0]).toEqual({
      name: first,
      version: "0.2.6",
      action: "publish",
    });
    const missingBytes = releaseRegistryFixture(f);
    missingBytes.tarballs.delete(missingBytes.tarballUrl(first));
    await expect(
      preflightRegistry(verified, missingBytes.ports),
    ).rejects.toThrow();
    expect(missingBytes.run).not.toHaveBeenCalled();
  });

  it.each(["metadata", "tarball"] as const)(
    "retries transient %s visibility against the same original artifact without repacking",
    async (part) => {
      const f = fixture();
      const registry = releaseRegistryFixture(f);
      if (part === "metadata") registry.state.metadataFailures = 2;
      else registry.state.tarballFailures = 2;
      const before = f.packages.map(({ record }) =>
        readFileSync(join(f.directory, record.tarball)),
      );
      await expect(
        verifyRegistryRelease(
          { ...options(f), npmCli: registry.npmCli },
          registry.ports,
        ),
      ).resolves.toMatchObject({ verified: true });
      expect(
        registry.sleep.mock.calls.map(([milliseconds]) => milliseconds),
      ).toEqual([1_000, 2_000]);
      expect(readFileSync(f.manifestPath)).toEqual(f.manifestBytes);
      f.packages.forEach(({ record }, index) =>
        expect(readFileSync(join(f.directory, record.tarball))).toEqual(
          before[index],
        ),
      );
      expect(
        registry.run.mock.calls.some(
          ([, args]) => args.includes("pack") || args.includes("publish"),
        ),
      ).toBe(false);
    },
  );

  it("bounds permanent registry visibility failure before installing or accepting any receipt", async () => {
    const f = fixture();
    const registry = releaseRegistryFixture(f);
    registry.state.metadataFailures = 100;
    await expect(
      verifyRegistryRelease(
        { ...options(f), npmCli: registry.npmCli },
        registry.ports,
      ),
    ).rejects.toThrow();
    expect(registry.fetch).toHaveBeenCalledTimes(9);
    expect(
      registry.sleep.mock.calls.map(([milliseconds]) => milliseconds),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000]);
    expect(registry.run).not.toHaveBeenCalled();
    expect(readFileSync(f.manifestPath)).toEqual(f.manifestBytes);
  });

  it.each([
    "version",
    "integrity",
    "sha1",
    "dependency",
    "tarball-url",
    "bytes",
    "missing-signatures",
    "empty-signatures",
  ] as const)(
    "rejects different registry %s without running package code",
    async (part) => {
      const f = fixture();
      const registry = releaseRegistryFixture(f);
      const name = releaseVerificationPackages[0]!.name;
      const document = registry.documents.get(registry.metadataUrl(name))!;
      if (part === "version") document.version = "0.1.1";
      if (part === "integrity")
        document.dist.integrity = `sha512-${Buffer.alloc(64, 9).toString("base64")}`;
      if (part === "sha1") document.dist.shasum = "d".repeat(40);
      if (part === "dependency")
        Object.assign(document, { dependencies: { "@pegma/spine": "0.1.1" } });
      if (part === "tarball-url")
        document.dist.tarball =
          "https://untrusted.invalid/modified-release.tgz";
      if (part === "missing-signatures")
        Reflect.deleteProperty(document.dist, "signatures");
      if (part === "empty-signatures") document.dist.signatures = [];
      if (part === "bytes") {
        const bytes = Buffer.from(
          registry.tarballs.get(registry.tarballUrl(name))!,
        );
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
        registry.tarballs.set(registry.tarballUrl(name), bytes);
      }
      await expect(
        verifyRegistryRelease(
          { ...options(f), npmCli: registry.npmCli },
          registry.ports,
        ),
      ).rejects.toThrow();
      expect(registry.run).not.toHaveBeenCalled();
      expect(registry.state.imports).toBe(0);
      expect(
        registry.fetch.mock.calls.some(([url]) =>
          String(url).startsWith("https://untrusted.invalid/"),
        ),
      ).toBe(false);
    },
  );

  it("does not reinterpret a registry authorization/server failure as a missing version", async () => {
    const f = fixture();
    const registry = releaseRegistryFixture(f);
    registry.state.metadataStatus = 503;
    await expect(
      verifyRegistryRelease(
        { ...options(f), npmCli: registry.npmCli },
        registry.ports,
      ),
    ).rejects.toThrow();
    expect(registry.sleep).not.toHaveBeenCalled();
    expect(registry.run).not.toHaveBeenCalled();
  });

  it.each(["integrity", "resolved", "dependency", "link"] as const)(
    "rejects a clean-consumer lock with a different %s before signature acceptance or imports",
    async (part) => {
      const f = fixture();
      const registry = releaseRegistryFixture(f);
      registry.state.mutateLock = (lock) => {
        const installed =
          lock.packages[
            `node_modules/${releaseVerificationPackages[0]!.name}`
          ]!;
        if (part === "integrity") installed.integrity = "sha512-different";
        if (part === "resolved") installed.resolved = "file:modified-local.tgz";
        if (part === "dependency") installed.dependencies = {};
        if (part === "link") installed.link = true;
      };
      await expect(
        verifyRegistryRelease(
          { ...options(f), npmCli: registry.npmCli },
          registry.ports,
        ),
      ).rejects.toThrow();
      expect(
        registry.run.mock.calls.some(([, args]) => args.includes("audit")),
      ).toBe(false);
      expect(registry.state.imports).toBe(0);
    },
  );

  it.each([
    "wrong-npm",
    "audit-failure",
    "audit-json",
    "import-failure",
  ] as const)(
    "fails closed for %s instead of falling back to unverified consumers",
    async (failure) => {
      const f = fixture();
      const registry = releaseRegistryFixture(f);
      if (failure === "wrong-npm") registry.state.npmVersion = "11.17.0";
      if (failure === "audit-failure") registry.state.auditStatus = 1;
      if (failure === "audit-json") registry.state.auditJson = "{";
      if (failure === "import-failure") registry.state.importStatus = 1;
      await expect(
        verifyRegistryRelease(
          { ...options(f), npmCli: registry.npmCli },
          registry.ports,
        ),
      ).rejects.toThrow();
      if (failure !== "import-failure") expect(registry.state.imports).toBe(0);
    },
  );
});

describe("authenticated provenance policy", () => {
  it("accepts the real-DER test certificate and exact authenticated SLSA source statement", async () => {
    const f = fixture();
    const verified = await verifyPreparedRelease(options(f));
    expect(() =>
      verifyProvenanceAudit(releaseAuditFixture(f), verified),
    ).not.toThrow();
  });

  it.each([
    "invalid-signature",
    "missing-signature",
    "missing-package",
    "duplicate-package",
    "bootstrap-without-provenance",
  ] as const)("rejects %s after the external crypto audit", async (failure) => {
    const f = fixture();
    const registry = releaseRegistryFixture(f);
    if (failure === "invalid-signature")
      registry.audit.invalid.push({
        name: releaseVerificationPackages[0]!.name,
      });
    if (failure === "missing-signature")
      registry.audit.missing.push({
        name: releaseVerificationPackages[0]!.name,
      });
    if (failure === "missing-package") registry.audit.verified.pop();
    if (failure === "duplicate-package")
      registry.audit.verified.push(
        structuredClone(registry.audit.verified[0]!),
      );
    if (failure === "bootstrap-without-provenance")
      registry.audit.verified[4]!.attestationBundles = [];
    await expect(
      verifyRegistryRelease(
        { ...options(f), npmCli: registry.npmCli },
        registry.ports,
      ),
    ).rejects.toThrow();
    expect(registry.state.imports).toBe(0);
  });

  it.each([
    "repository",
    "tag",
    "commit",
    "workflow",
    "event",
    "builder",
    "subject-digest",
    "subject-name",
    "source-uri",
    "statement-type",
  ] as const)(
    "rejects cryptographically reported provenance for a different %s",
    async (field) => {
      const f = fixture();
      const registry = releaseRegistryFixture(f);
      const statement = releaseAuditStatement(registry.audit);
      const definition = statement.predicate.buildDefinition;
      if (field === "repository")
        definition.externalParameters.workflow.repository =
          "https://github.com/foreign/support-desk";
      if (field === "tag")
        definition.externalParameters.workflow.ref = "refs/tags/v0.1.1";
      if (field === "commit")
        definition.resolvedDependencies[0]!.digest.gitCommit = "d".repeat(40);
      if (field === "workflow")
        definition.externalParameters.workflow.path =
          ".github/workflows/unreviewed.yml";
      if (field === "event")
        definition.internalParameters.github.event_name = "workflow_dispatch";
      if (field === "builder")
        statement.predicate.runDetails.builder.id =
          "https://github.com/actions/runner/self-hosted";
      if (field === "subject-digest")
        statement.subject[0]!.digest.sha512 = "e".repeat(128);
      if (field === "subject-name")
        statement.subject[0]!.name =
          "pkg:npm/%40foreign/support-desk-contracts@0.2.6";
      if (field === "source-uri")
        definition.resolvedDependencies[0]!.uri =
          "git+https://github.com/pegma-dev/support-desk@refs/heads/main";
      if (field === "statement-type")
        statement._type = "https://in-toto.io/Statement/v0.1";
      setReleaseAuditStatement(registry.audit, statement);
      await expect(
        verifyRegistryRelease(
          { ...options(f), npmCli: registry.npmCli },
          registry.ports,
        ),
      ).rejects.toThrow();
      expect(registry.state.imports).toBe(0);
    },
  );

  it.each(["issuer", "repository", "workflow", "tag", "malformed"] as const)(
    "rejects a real certificate with the wrong %s signer identity",
    async (field) => {
      const f = fixture();
      const registry = releaseRegistryFixture(f);
      let identity =
        "https://github.com/pegma-dev/support-desk/.github/workflows/publish.yml@refs/tags/v0.2.6";
      if (field === "repository")
        identity = identity.replace("pegma-dev", "foreign-org");
      if (field === "workflow")
        identity = identity.replace("publish.yml", "unreviewed.yml");
      if (field === "tag") identity = identity.replace("v0.2.6", "v0.1.1");
      registry.audit.verified[0]!.attestationBundles[0]!.bundle.verificationMaterial.certificate.rawBytes =
        field === "malformed"
          ? Buffer.from("not a certificate").toString("base64")
          : releaseAuditCertificate({
              identity,
              ...(field === "issuer"
                ? { issuer: "https://untrusted.invalid/oidc" }
                : {}),
            });
      await expect(
        verifyRegistryRelease(
          { ...options(f), npmCli: registry.npmCli },
          registry.ports,
        ),
      ).rejects.toThrow();
      expect(registry.state.imports).toBe(0);
    },
  );
});

describe("protected OIDC publication authority", () => {
  it("binds the exact repo, immutable tag/main commit, workflow and protected environment without inventing an environment provenance claim", async () => {
    const verified = await verifyPreparedRelease(options(fixture()));
    expect(() =>
      assertTrustedPublishingEnvironment(
        releasePublishingEnvironment(),
        verified.identity,
      ),
    ).not.toThrow();
  });

  it.each([
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_SHA",
    "GITHUB_WORKFLOW_REF",
    "RELEASE_ENVIRONMENT",
    "GITHUB_EVENT_NAME",
    "RUNNER_ENVIRONMENT",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
  ] as const)("rejects a different %s publication context", async (field) => {
    const verified = await verifyPreparedRelease(options(fixture()));
    const env = releasePublishingEnvironment();
    Object.assign(env, {
      [field]:
        field === "ACTIONS_ID_TOKEN_REQUEST_URL"
          ? "https://untrusted.invalid/oidc"
          : "different-context",
    });
    expect(() =>
      assertTrustedPublishingEnvironment(env, verified.identity),
    ).toThrow();
  });

  it.each([
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "NPM_AUTH_TOKEN",
    "NPM_AUTH",
    "YARN_NPM_AUTH_TOKEN",
    "npm_config_registry",
  ])(
    "rejects the %s fallback instead of treating it as trusted publishing",
    async (credential) => {
      const verified = await verifyPreparedRelease(options(fixture()));
      const env = {
        ...releasePublishingEnvironment(),
        [credential]: "synthetic-unapproved-credential",
      };
      expect(() =>
        assertTrustedPublishingEnvironment(env, verified.identity),
      ).toThrow();
    },
  );

  it("requires an actual OIDC request context and does not accept a token/bootstrap-only environment", async () => {
    const verified = await verifyPreparedRelease(options(fixture()));
    expect(() =>
      assertTrustedPublishingEnvironment(
        { NODE_AUTH_TOKEN: "synthetic-token", RELEASE_TAG: "v0.2.6" },
        verified.identity,
      ),
    ).toThrow();
    expect(() =>
      assertTrustedPublishingEnvironment(
        {
          ...releasePublishingEnvironment(),
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
        },
        verified.identity,
      ),
    ).toThrow();
  });
});

describe("source-bound original release artifact", () => {
  it("preserves a safe controlled manifest digest stage and code", async () => {
    const f = fixture();
    const error = await verifyPreparedRelease({
      ...options(f),
      manifestSha256: "f".repeat(64),
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ReleaseVerificationError");
    expect(Object.isFrozen(error)).toBe(true);
    expect(describeReleaseFailure(error)).toMatchObject({
      stage: "prepared",
      code: "manifest_digest_mismatch",
    });
  });

  it("collapses an unexpected native prepared-file failure to a safe stage without leaking its path", async () => {
    const f = fixture();
    const privatePath = join(
      f.directory,
      "PRIVATE_RELEASE_PATH_DO_NOT_LOG.json",
    );
    const error = await verifyPreparedRelease({
      ...options(f),
      manifest: privatePath,
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    const description = describeReleaseFailure(error);
    expect(description).toMatchObject({
      stage: "prepared",
      code: "prepared_verification_failed",
    });
    expect(JSON.stringify(description)).not.toContain(
      "PRIVATE_RELEASE_PATH_DO_NOT_LOG",
    );
    expect(JSON.stringify(description)).not.toContain(f.root);
  });

  it("does not trust externally forged diagnostic branding or untrusted error text", () => {
    const forged = Object.assign(new Error("PRIVATE_EXTERNAL_RELEASE_ERROR"), {
      name: "ReleaseVerificationError",
      stage: "prepared",
      code: "manifest_digest_mismatch",
    });
    const description = describeReleaseFailure(forged);
    expect(description).toEqual({
      stage: "release",
      code: "unexpected_failure",
      message:
        "Release verification failed at an external or unavailable boundary.",
    });
    expect(Object.isFrozen(description)).toBe(true);
    expect(JSON.stringify(description)).not.toContain(
      "PRIVATE_EXTERNAL_RELEASE_ERROR",
    );
  });

  it("reads real gzip/tar artifacts and accepts the independently pinned exact five-package candidate", async () => {
    expect(releaseVerificationVersion).toBe("0.2.6");
    const f = fixture();
    expect(
      f.manifest.packages.map(({ name, version }) => ({ name, version })),
    ).toEqual(
      releaseVerificationPackages.map(({ name }) => ({
        name,
        version: "0.2.6",
      })),
    );
    for (const entry of f.packages) {
      const inspected = inspectReleaseTarball(entry.bytes);
      expect(inspected.packageJson).toEqual(entry.packageJson);
      expect(inspected.files).toEqual(entry.record.files);
    }
    await expect(verifyPreparedRelease(options(f))).resolves.toBeDefined();
  });

  it("rejects a changed original manifest even when its parsed package inventory is unchanged", async () => {
    const f = fixture();
    writeFileSync(
      f.manifestPath,
      Buffer.concat([f.manifestBytes, Buffer.from(" ")]),
    );
    await expect(verifyPreparedRelease(options(f))).rejects.toThrow();
  });

  it("rejects tarball tampering against the original independent manifest pin", async () => {
    const f = fixture();
    const entry = f.packages[0]!;
    writeFileSync(
      join(f.directory, entry.record.tarball),
      Buffer.concat([entry.bytes, Buffer.from("tampered")]),
    );
    await expect(verifyPreparedRelease(options(f))).rejects.toThrow();
  });

  it.each([
    "release-tag",
    "source-commit",
    "manifest-pin",
    "missing-manifest-pin",
  ] as const)(
    "rejects a stale or different trusted %s identity",
    async (field) => {
      const f = fixture();
      const expected = options(f);
      if (field === "release-tag") expected.releaseTag = "v0.2.1";
      if (field === "source-commit")
        expected.expectedReleaseCommit = "d".repeat(40);
      if (field === "manifest-pin") expected.manifestSha256 = "f".repeat(64);
      if (field === "missing-manifest-pin") expected.manifestSha256 = "";
      await expect(verifyPreparedRelease(expected)).rejects.toThrow();
    },
  );

  it("rejects a missing original tarball without recreating it", async () => {
    const f = fixture();
    const path = join(f.directory, f.packages[0]!.record.tarball);
    unlinkSync(path);
    await expect(verifyPreparedRelease(options(f))).rejects.toThrow();
    expect(() => readFileSync(path)).toThrow();
  });

  it.each([
    "missing",
    "duplicate",
    "different-name",
    "mixed-version",
    "not-selected",
  ] as const)(
    "rejects a coherently pinned %s package inventory",
    async (variant) => {
      const f = fixture();
      if (variant === "missing") f.manifest.packages.pop();
      if (variant === "duplicate")
        f.manifest.packages[4] = { ...f.manifest.packages[0]! };
      if (variant === "different-name")
        Object.assign(f.manifest.packages[4]!, {
          name: "@foreign/support-desk-ai",
        });
      if (variant === "mixed-version")
        f.manifest.packages[4]!.version = "0.1.1";
      if (variant === "not-selected") f.manifest.packages[4]!.publish = false;
      await expect(verifyPreparedRelease(writeManifest(f))).rejects.toThrow();
    },
  );

  it.each([
    [1, "@pegma/support-desk-contracts", "^0.2.0"],
    [3, "@pegma/support-desk-core", "0.1.1"],
    [4, "@pegma/support-desk-application", "workspace:*"],
    [4, "@pegma/knowledge-base-application", "0.1.1"],
  ] as const)(
    "rejects a freshly hashed archive with wrong dependency %s/%s@%s",
    async (index, dependency, version) => {
      const f = fixture();
      const packageJson = f.packages[index]!.packageJson;
      const prepared = replacePackage(f, index, {
        ...packageJson,
        dependencies: { ...packageJson.dependencies, [dependency]: version },
      });
      expect(prepared.manifestSha256).not.toBe(f.originalManifestSha256);
      await expect(verifyPreparedRelease(prepared)).rejects.toThrow();
    },
  );

  it("does not repair or repack altered prepared bytes while verifying", async () => {
    const f = fixture();
    const entry = f.packages[0]!;
    const altered = Buffer.from(entry.bytes);
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 0xff;
    const path = join(f.directory, entry.record.tarball);
    writeFileSync(path, altered);
    await expect(verifyPreparedRelease(options(f))).rejects.toThrow();
    expect(readFileSync(path)).toEqual(altered);
    expect(readFileSync(f.manifestPath)).toEqual(f.manifestBytes);
  });
});
