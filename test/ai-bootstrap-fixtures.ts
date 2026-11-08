import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { vi } from "vitest";
import type { AiBootstrapCommandRunner } from "../scripts/ai-bootstrap.mjs";

export const reviewedAiBootstrapSource =
  "eddd3526f8bec3a1a80cc7aacd3a4cdcdb950cfe";
export const reviewedAiBootstrapTag = "v0.1.1-ai-bootstrap";
export const reviewedAiBootstrapName = "@pegma/support-desk-ai";
export const reviewedAiBootstrapVersion = "0.1.1";
export const reviewedAiBootstrapInventory = [
  { directory: "contracts", name: "@pegma/support-desk-contracts" },
  { directory: "core", name: "@pegma/support-desk-core" },
  { directory: "templates", name: "@pegma/support-desk-templates" },
  { directory: "application", name: "@pegma/support-desk-application" },
  { directory: "ai", name: reviewedAiBootstrapName },
] as const;

export const reviewedAiBootstrapDependencies: Readonly<Record<string, string>> =
  Object.freeze({
    "@pegma/authorization-core": "0.4.0",
    "@pegma/knowledge-base-application": "0.1.2",
    "@pegma/knowledge-base-contracts": "0.1.2",
    "@pegma/spine": "0.1.2",
    "@pegma/support-desk-application": "0.1.1",
  });

export interface BootstrapArchiveEntry {
  readonly path: string;
  readonly body?: string | Uint8Array;
  readonly type?: "0" | "2" | "5";
  readonly linkpath?: string;
}

/** A real gzip/ustar fixture, independent of npm, Git, credentials and networks. */
export function bootstrapTarball(entries: readonly BootstrapArchiveEntry[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    function field(offset: number, length: number, value: string) {
      if (Buffer.byteLength(value) > length)
        throw new Error("Fixture tar field exceeds its fixed header");
      header.write(value, offset, length, "utf8");
    }
    field(0, 100, entry.path);
    field(100, 8, "0000644\0");
    field(108, 8, "0000000\0");
    field(116, 8, "0000000\0");
    field(124, 12, `${body.length.toString(8).padStart(11, "0")}\0`);
    field(136, 12, "00000000000\0");
    header.fill(32, 148, 156);
    field(156, 1, entry.type ?? "0");
    if (entry.linkpath !== undefined) field(157, 100, entry.linkpath);
    field(257, 6, "ustar\0");
    field(263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

export function bootstrapHashes(bytes: Uint8Array) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

export function bootstrapPackage(directory: string, name: string) {
  const dependencies: Record<string, string> =
    directory === "ai"
      ? { ...reviewedAiBootstrapDependencies }
      : directory === "contracts"
        ? { "@pegma/spine": "0.1.2" }
        : directory === "core"
          ? { "@pegma/support-desk-contracts": "0.1.1" }
          : directory === "application"
            ? {
                "@pegma/audit": "0.2.0",
                "@pegma/authorization-core": "0.4.0",
                "@pegma/mail": "0.1.1",
                "@pegma/spine": "0.1.2",
                "@pegma/storage-core": "0.4.0",
                "@pegma/support-desk-contracts": "0.1.1",
                "@pegma/support-desk-core": "0.1.1",
              }
            : {};
  return {
    name,
    version: reviewedAiBootstrapVersion,
    license: "MIT",
    type: "module",
    publishConfig: { access: "public" },
    engines: { node: ">=22" },
    repository: {
      type: "git",
      url: "git+https://github.com/pegma-dev/support-desk.git",
      directory: `packages/${directory}`,
    },
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    dependencies,
  };
}

export function bootstrapCandidate(directory: string, name: string) {
  const manifest = bootstrapPackage(directory, name);
  const entries = [
    {
      path: "package/package.json",
      body: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    { path: "package/README.md", body: `# Synthetic ${name}\n` },
    { path: "package/LICENSE", body: "MIT synthetic fixture license\n" },
    {
      path: "package/dist/index.js",
      body: "export const bootstrapFixture = true;\n",
    },
    {
      path: "package/dist/index.d.ts",
      body: "export declare const bootstrapFixture: true;\n",
    },
  ];
  const bytes = bootstrapTarball(entries);
  const hashes = bootstrapHashes(bytes);
  return {
    manifest,
    entries,
    bytes,
    record: {
      name,
      version: reviewedAiBootstrapVersion,
      directory,
      tarball: `${name.slice(1).replace("/", "-")}-${reviewedAiBootstrapVersion}.tgz`,
      integrity: hashes.integrity,
      shasum: hashes.shasum,
      publish: true,
      files: entries
        .map(({ path, body }) => ({
          path: path.slice("package/".length),
          size: Buffer.byteLength(body),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    },
  };
}

/** Store-only ZIP with a real central directory and CRCs, matching downloaded artifacts. */
export function bootstrapZip(
  entries: readonly { readonly path: string; readonly body: Uint8Array }[],
) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const body = Buffer.from(entry.body);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1)
        crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(body.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(entries.length, 8);
  footer.writeUInt16LE(entries.length, 10);
  footer.writeUInt32LE(directory.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, footer]);
}

/** Real prepared bytes; external identity and registry responses remain test-owned. */
export async function aiBootstrapPreparedFixture(warning: string) {
  const workspace = await mkdtemp(join(tmpdir(), "pegma-ai-bootstrap-test-"));
  const preparedDirectory = join(workspace, "prepared artifact");
  const contextDirectory = join(preparedDirectory, "context");
  await mkdir(contextDirectory, { recursive: true });
  const candidates = reviewedAiBootstrapInventory.map(({ directory, name }) =>
    bootstrapCandidate(directory, name),
  );
  for (const candidate of candidates)
    await writeFile(
      join(contextDirectory, candidate.record.tarball),
      candidate.bytes,
    );
  const context = {
    schemaVersion: 1,
    gitCommit: reviewedAiBootstrapSource,
    releaseTag: null,
    packages: candidates.map((candidate) => candidate.record),
  };
  const contextPath = join(contextDirectory, "package-manifest.json");
  await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`);
  const ai = candidates[4]!;
  await writeFile(join(preparedDirectory, ai.record.tarball), ai.bytes);
  const toolCommit = "b".repeat(40);
  const manifest = {
    schemaVersion: 1,
    purpose: "npm-name-registration-only",
    hostUsable: false,
    oidcProvenance: false,
    identity: {
      repository: "pegma-dev/support-desk",
      tag: reviewedAiBootstrapTag,
      sourceCommit: reviewedAiBootstrapSource,
      tagObject: "a".repeat(40),
      toolCommit,
      workflowCommit: toolCommit,
      workflow: ".github/workflows/prepare-ai-bootstrap.yml",
    },
    context: {
      manifest: "context/package-manifest.json",
      manifestSha256: bootstrapHashes(await readFile(contextPath)).sha256,
      candidateCount: 5,
      importedLocally: true,
    },
    artifact: {
      name: reviewedAiBootstrapName,
      version: reviewedAiBootstrapVersion,
      filename: ai.record.tarball,
      size: ai.bytes.length,
      integrity: ai.record.integrity,
      shasum: ai.record.shasum,
      dependencies: { ...reviewedAiBootstrapDependencies },
      files: structuredClone(ai.record.files),
    },
    warning,
  };
  const manifestPath = join(preparedDirectory, "bootstrap-manifest.json");
  const artifactArchive = join(workspace, "downloaded-artifact.zip");
  let manifestSha256 = "";
  let artifactSha256 = "";
  async function rewriteManifest() {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    manifestSha256 = bootstrapHashes(await readFile(manifestPath)).sha256;
    return manifestSha256;
  }
  async function rewriteContext() {
    await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`);
    manifest.context.manifestSha256 = bootstrapHashes(
      await readFile(contextPath),
    ).sha256;
    await rewriteManifest();
  }
  async function archiveEntries() {
    const paths = [
      "bootstrap-manifest.json",
      "context/package-manifest.json",
      ...candidates.map(({ record }) => `context/${record.tarball}`),
      ai.record.tarball,
    ];
    return Promise.all(
      paths.map(async (path) => ({
        path,
        body: await readFile(join(preparedDirectory, path)),
      })),
    );
  }
  async function rewriteArchive(
    entries?: readonly { readonly path: string; readonly body: Uint8Array }[],
  ) {
    const bytes = bootstrapZip(entries ?? (await archiveEntries()));
    await writeFile(artifactArchive, bytes);
    artifactSha256 = bootstrapHashes(bytes).sha256;
    return artifactSha256;
  }
  await rewriteManifest();
  await rewriteArchive();
  return {
    workspace,
    preparedDirectory,
    contextDirectory,
    contextPath,
    manifestPath,
    artifactArchive,
    candidates,
    ai,
    context,
    manifest,
    toolCommit,
    rewriteManifest,
    rewriteContext,
    archiveEntries,
    rewriteArchive,
    get verifyOptions() {
      return {
        preparedDirectory,
        manifestSha256,
        expectedToolCommit: toolCommit,
      };
    },
    get registryOptions() {
      return {
        preparedDirectory,
        manifestSha256,
        expectedToolCommit: toolCommit,
        artifactArchive,
        artifactSha256,
      };
    },
    async dispose() {
      const root = resolve(workspace);
      const withinTemp = relative(resolve(tmpdir()), root);
      if (
        withinTemp.startsWith("..") ||
        withinTemp === "" ||
        dirname(root) !== resolve(tmpdir())
      )
        throw new Error(
          "Refusing fixture cleanup outside its unique temporary workspace",
        );
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function aiBootstrapSourceFixture(
  sourceDirectoryName = "reviewed source",
) {
  const workspace = await mkdtemp(join(tmpdir(), "pegma-ai-bootstrap-source-"));
  const sourceRoot = join(workspace, sourceDirectoryName);
  const toolRoot = join(workspace, "reviewed tools");
  const output = join(workspace, "prepared output");
  await mkdir(sourceRoot);
  await mkdir(toolRoot);
  const candidates = reviewedAiBootstrapInventory.map(({ directory, name }) =>
    bootstrapCandidate(directory, name),
  );
  for (const candidate of candidates) {
    const directory = join(sourceRoot, "packages", candidate.record.directory);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(candidate.manifest, null, 2)}\n`,
    );
  }
  const publicRuleset: {
    target: string;
    enforcement: string;
    conditions: { ref_name: { include: string[]; exclude: string[] } };
    rules: { type: string }[];
    bypass_actors?: {
      actor_id: number;
      actor_type: string;
      bypass_mode: string;
    }[];
  } = {
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: ["creation", "update", "deletion", "non_fast_forward"].map(
      (type) => ({ type }),
    ),
  };
  const state = {
    sourceHead: reviewedAiBootstrapSource,
    toolHead: "b".repeat(40),
    sourceOrigin: "https://github.com/pegma-dev/support-desk.git",
    toolOrigin: "https://github.com/pegma-dev/support-desk.git",
    sourceDirty: false,
    toolDirty: false,
    sourceOnMain: true,
    toolOnMain: true,
    tagType: "tag",
    taggedCommit: reviewedAiBootstrapSource,
    tagObject: "a".repeat(40),
    remoteTagObject: "a".repeat(40),
    validSignature: true,
    rulesetStatus: 200,
    ruleset: publicRuleset,
  };
  const env: Record<string, string | undefined> = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "pegma-dev/support-desk",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: state.toolHead,
    GITHUB_WORKFLOW_SHA: state.toolHead,
    GITHUB_WORKFLOW_REF:
      "pegma-dev/support-desk/.github/workflows/prepare-ai-bootstrap.yml@refs/heads/main",
  };
  let afterPack: (() => void) | undefined;
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  const run = vi.fn<AiBootstrapCommandRunner>((command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    const success = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    const failed = () => ({
      status: 1,
      stdout: "",
      stderr: "Synthetic refused read-only inspection",
    });
    if (command === "git") {
      if (options.cwd !== sourceRoot && options.cwd !== toolRoot)
        throw new Error("Unexpected fake Git checkout");
      const source = options.cwd === sourceRoot;
      const exact = (...expected: string[]) =>
        args.join("\n") === expected.join("\n");
      if (exact("remote", "get-url", "origin"))
        return success(source ? state.sourceOrigin : state.toolOrigin);
      if (exact("status", "--porcelain"))
        return success(
          (source ? state.sourceDirty : state.toolDirty)
            ? " M changed-source"
            : "",
        );
      if (
        exact("merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main")
      )
        return (source ? state.sourceOnMain : state.toolOnMain)
          ? success()
          : failed();
      if (exact("rev-parse", "HEAD"))
        return success(source ? state.sourceHead : state.toolHead);
      const ref = `refs/tags/${reviewedAiBootstrapTag}`;
      if (source && exact("cat-file", "-t", ref)) return success(state.tagType);
      if (source && exact("rev-parse", `${ref}^{commit}`))
        return success(state.taggedCommit);
      if (source && exact("rev-parse", ref)) return success(state.tagObject);
      if (source && exact("verify-tag", "--raw", ref))
        return state.validSignature ? success() : failed();
      if (source && exact("ls-remote", "--refs", "origin", ref))
        return success(`${state.remoteTagObject}\t${ref}`);
      throw new Error(`Unexpected fake Git arguments: ${JSON.stringify(args)}`);
    }
    if (
      command === process.execPath &&
      args[0] === join(sourceRoot, "scripts/release-packages.mjs") &&
      args[1] === "pack"
    ) {
      const expected = [
        join(sourceRoot, "scripts/release-packages.mjs"),
        "pack",
        "--root",
        sourceRoot,
        "--require-clean",
        "--require-main-ancestor",
        "--output",
        join(output, "context"),
      ];
      if (
        JSON.stringify(args) !== JSON.stringify(expected) ||
        options.cwd !== sourceRoot
      )
        throw new Error(
          "Bootstrap preparation attempted an unexpected command or output path",
        );
      mkdirSync(join(output, "context"), { recursive: true });
      for (const candidate of candidates)
        writeFileSync(
          join(output, "context", candidate.record.tarball),
          candidate.bytes,
        );
      writeFileSync(
        join(output, "context", "package-manifest.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            gitCommit: reviewedAiBootstrapSource,
            releaseTag: null,
            packages: candidates.map((candidate) => candidate.record),
          },
          null,
          2,
        )}\n`,
      );
      afterPack?.();
      return success();
    }
    throw new Error(
      `Bootstrap test exposes no command capability for ${command}`,
    );
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (
      url !==
      "https://api.github.com/repos/pegma-dev/support-desk/rulesets/20011989"
    )
      throw new Error("Unexpected bootstrap protection request");
    if (
      (init?.method ?? "GET") !== "GET" ||
      new Headers(init?.headers).has("authorization")
    )
      throw new Error(
        "Bootstrap protection lookup must remain public and read-only",
      );
    return new Response(JSON.stringify(state.ruleset), {
      status: state.rulesetStatus,
    });
  });
  return {
    workspace,
    sourceRoot,
    toolRoot,
    output,
    candidates,
    state,
    env,
    run,
    calls,
    fetch,
    options: { sourceRoot, toolRoot, output },
    onPack(hook: typeof afterPack) {
      afterPack = hook;
    },
    async dispose() {
      const root = resolve(workspace);
      if (
        dirname(root) !== resolve(tmpdir()) ||
        !root.startsWith(join(resolve(tmpdir()), "pegma-ai-bootstrap-source-"))
      )
        throw new Error(
          "Refusing bootstrap source fixture cleanup outside its temporary workspace",
        );
      await rm(root, { recursive: true, force: true });
    },
  };
}
