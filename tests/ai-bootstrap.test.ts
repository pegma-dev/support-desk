import { readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as bootstrap from "../scripts/ai-bootstrap.mjs";
import {
  AI_BOOTSTRAP_IDENTITY,
  AI_BOOTSTRAP_WARNING,
  parseAiBootstrapArguments,
  postflightAiBootstrap,
  prepareAiBootstrap,
  preflightAiBootstrap,
  validateAiBootstrapSource,
  verifyAiBootstrapPrepared,
} from "../scripts/ai-bootstrap.mjs";
import {
  aiBootstrapPreparedFixture,
  aiBootstrapSourceFixture,
  bootstrapHashes,
  bootstrapTarball,
  reviewedAiBootstrapDependencies,
  reviewedAiBootstrapInventory,
  reviewedAiBootstrapName,
  reviewedAiBootstrapSource,
  reviewedAiBootstrapTag,
  type BootstrapArchiveEntry,
} from "../test/ai-bootstrap-fixtures.js";

type Fixture = Awaited<ReturnType<typeof aiBootstrapPreparedFixture>>;
const fixtures: Fixture[] = [];
const sourceFixtures: Awaited<ReturnType<typeof aiBootstrapSourceFixture>>[] =
  [];
async function prepared() {
  const fixture = await aiBootstrapPreparedFixture(AI_BOOTSTRAP_WARNING);
  fixtures.push(fixture);
  return fixture;
}
async function source(sourceDirectoryName?: string) {
  const fixture = await aiBootstrapSourceFixture(sourceDirectoryName);
  sourceFixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  for (const fixture of sourceFixtures.splice(0)) await fixture.dispose();
});

async function replaceAi(
  f: Fixture,
  entries: readonly BootstrapArchiveEntry[],
) {
  const bytes = bootstrapTarball(entries);
  const hashes = bootstrapHashes(bytes);
  const files = entries
    .map((entry) => ({
      path: entry.path.slice("package/".length),
      size: Buffer.byteLength(entry.body ?? ""),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  Object.assign(f.context.packages[4]!, {
    integrity: hashes.integrity,
    shasum: hashes.shasum,
    files,
  });
  Object.assign(f.manifest.artifact, {
    integrity: hashes.integrity,
    shasum: hashes.shasum,
    size: bytes.length,
    files,
  });
  await writeFile(join(f.contextDirectory, f.ai.record.tarball), bytes);
  await writeFile(join(f.preparedDirectory, f.ai.record.tarball), bytes);
  await f.rewriteContext();
}

function registry(f: Fixture) {
  const tarballUrl =
    "https://registry.npmjs.org/@pegma/support-desk-ai/-/support-desk-ai-0.1.1.tgz";
  const state = {
    nameStatus: 404,
    versionStatus: undefined as number | undefined,
    includeVersion: true,
    malformedJson: false,
    distTags: { latest: "0.1.1", bootstrap: "0.1.1" } as Record<string, string>,
    metadata: {
      name: reviewedAiBootstrapName,
      version: "0.1.1",
      dependencies: { ...reviewedAiBootstrapDependencies },
      dist: {
        integrity: f.manifest.artifact.integrity,
        shasum: f.manifest.artifact.shasum,
        tarball: tarballUrl,
      },
    },
    tarballBytes: Buffer.from(f.ai.bytes),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (url.href === tarballUrl)
      return new Response(new Uint8Array(state.tarballBytes));
    expect(url.origin).toBe("https://registry.npmjs.org");
    const path = decodeURIComponent(url.pathname);
    if (path === "/@pegma/support-desk-ai") {
      return new Response(
        state.malformedJson
          ? "{"
          : JSON.stringify(
              state.nameStatus === 200
                ? {
                    name: state.metadata.name,
                    "dist-tags": state.distTags,
                    versions: state.includeVersion
                      ? { "0.1.1": state.metadata }
                      : {},
                  }
                : {
                    error:
                      state.nameStatus === 404
                        ? "Not found"
                        : "Registry unavailable",
                  },
            ),
        { status: state.nameStatus },
      );
    }
    if (path === "/@pegma/support-desk-ai/0.1.1") {
      const status =
        state.versionStatus ?? (state.nameStatus === 200 ? 200 : 404);
      return new Response(
        JSON.stringify(
          status === 200 ? state.metadata : { error: "Version not found" },
        ),
        { status },
      );
    }
    throw new Error(`Unexpected bootstrap registry request: ${url.href}`);
  });
  return { state, fetch, tarballUrl };
}

describe("AI first-name bootstrap boundaries", () => {
  it("locks the historical AI-only bootstrap to the distinct signed SD-05 tag rather than the advertised source candidate", () => {
    expect(AI_BOOTSTRAP_IDENTITY).toEqual({
      repository: "pegma-dev/support-desk",
      tag: reviewedAiBootstrapTag,
      sourceCommit: reviewedAiBootstrapSource,
      packageName: reviewedAiBootstrapName,
      version: "0.1.1",
      workflow: ".github/workflows/prepare-ai-bootstrap.yml",
    });
    expect(Object.isFrozen(AI_BOOTSTRAP_IDENTITY)).toBe(true);
    expect(AI_BOOTSTRAP_WARNING).toMatch(/host|compatib|registry/i);
    expect(
      Object.keys(bootstrap).filter((name) => /publish/i.test(name)),
    ).toEqual([]);
  });

  it.each([
    "publish",
    "release",
    "settings",
    "token",
    "configure-publisher",
    "npm publish",
  ])("exposes no %s command", (command) =>
    expect(() => parseAiBootstrapArguments([command])).toThrow(),
  );

  it.each([
    "--package",
    "--packages",
    "--source-directory",
    "--token",
    "--provenance",
    "--oidc",
    "--publish",
    "--allow-other-packages",
    "--tag",
  ])("refuses caller-controlled publication authority through %s", (flag) => {
    expect(() =>
      parseAiBootstrapArguments(["preflight", flag, "unexpected-authority"]),
    ).toThrow();
  });

  it.each(["prepare", "verify-source", "preflight", "postflight"])(
    "rejects malformed %s command input before any external capability exists",
    (command) => {
      expect(() =>
        parseAiBootstrapArguments([command, "--prepared-directory"]),
      ).toThrow();
      expect(() =>
        parseAiBootstrapArguments([command, "--unknown", "npm publish"]),
      ).toThrow();
    },
  );

  it("parses only the reviewed preparation and digest-bound registry options", () => {
    expect(
      parseAiBootstrapArguments([
        "verify-source",
        "--source-root",
        "/reviewed/source",
        "--tool-root",
        "/reviewed/tools",
      ]),
    ).toEqual({
      command: "verify-source",
      options: { sourceRoot: "/reviewed/source", toolRoot: "/reviewed/tools" },
    });
    expect(
      parseAiBootstrapArguments([
        "prepare",
        "--source-root",
        "/reviewed/source",
        "--output",
        "/prepared/artifact",
      ]),
    ).toEqual({
      command: "prepare",
      options: { sourceRoot: "/reviewed/source", output: "/prepared/artifact" },
    });
    const arguments_ = [
      "--prepared-dir",
      "/prepared/artifact",
      "--manifest-sha256",
      "a".repeat(64),
      "--expected-tool-commit",
      "b".repeat(40),
      "--artifact-archive",
      "/download/artifact.zip",
      "--artifact-sha256",
      "c".repeat(64),
    ];
    for (const command of ["preflight", "postflight"])
      expect(parseAiBootstrapArguments([command, ...arguments_]).command).toBe(
        command,
      );
    expect(() =>
      parseAiBootstrapArguments([
        "prepare",
        "--source-root",
        "/source",
        "--output",
        "/first",
        "--output",
        "/second",
      ]),
    ).toThrow();
    expect(() =>
      parseAiBootstrapArguments([
        "verify-source",
        "--source-root",
        "source\nnpm publish",
      ]),
    ).toThrow();
  });
});

describe("reviewed signed bootstrap source and preparation", () => {
  it("binds separate clean source and tool checkouts to main, the annotated signed tag and its immutable remote object", async () => {
    const f = await source();
    const identity = await validateAiBootstrapSource(f.options, {
      run: f.run,
      env: f.env,
      fetch: f.fetch,
    });
    expect(identity).toEqual({
      repository: "pegma-dev/support-desk",
      tag: reviewedAiBootstrapTag,
      sourceCommit: reviewedAiBootstrapSource,
      tagObject: "a".repeat(40),
      toolCommit: "b".repeat(40),
      workflowCommit: "b".repeat(40),
      workflow: ".github/workflows/prepare-ai-bootstrap.yml",
    });
    expect(f.calls).toContainEqual({
      command: "git",
      args: ["verify-tag", "--raw", `refs/tags/${reviewedAiBootstrapTag}`],
      cwd: f.sourceRoot,
    });
    expect(f.calls.filter(({ args }) => args[0] === "merge-base")).toHaveLength(
      2,
    );
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.calls.every(({ command }) => command === "git")).toBe(true);
  });

  it("accepts the equivalent credential-free checkout origin without a .git suffix", async () => {
    const f = await source();
    f.state.sourceOrigin = "https://github.com/pegma-dev/support-desk";
    f.state.toolOrigin = "https://github.com/pegma-dev/support-desk";
    await expect(
      validateAiBootstrapSource(f.options, {
        run: f.run,
        env: f.env,
        fetch: f.fetch,
      }),
    ).resolves.toMatchObject({ sourceCommit: reviewedAiBootstrapSource });
  });

  it.each([
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "NPM_AUTH_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
  ])(
    "refuses ambient %s authority without executing source code or exposing the credential",
    async (name) => {
      const f = await source();
      const credential = "SYNTHETIC_BOOTSTRAP_CREDENTIAL_MUST_NOT_BE_LOGGED";
      f.env[name] = credential;
      const result = await prepareAiBootstrap(f.options, {
        run: f.run,
        env: f.env,
        fetch: f.fetch,
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(result).toHaveProperty("error");
      if ("error" in result && result.error instanceof Error)
        expect(result.error.message).not.toContain(credential);
      expect(f.calls.some(({ command }) => command === process.execPath)).toBe(
        false,
      );
    },
  );

  it.each([
    "wrong source HEAD",
    "tag points elsewhere",
    "lightweight tag",
    "bad signature",
    "remote tag changed",
    "dirty source",
    "dirty tools",
    "source off main",
    "tools off main",
    "wrong source origin",
    "wrong tool origin",
  ])("refuses %s before executing the reviewed source packer", async (kind) => {
    const f = await source();
    if (kind === "wrong source HEAD") f.state.sourceHead = "c".repeat(40);
    if (kind === "tag points elsewhere") f.state.taggedCommit = "c".repeat(40);
    if (kind === "lightweight tag") f.state.tagType = "commit";
    if (kind === "bad signature") f.state.validSignature = false;
    if (kind === "remote tag changed") f.state.remoteTagObject = "c".repeat(40);
    if (kind === "dirty source") f.state.sourceDirty = true;
    if (kind === "dirty tools") f.state.toolDirty = true;
    if (kind === "source off main") f.state.sourceOnMain = false;
    if (kind === "tools off main") f.state.toolOnMain = false;
    if (kind === "wrong source origin")
      f.state.sourceOrigin = "https://github.com/untrusted/source.git";
    if (kind === "wrong tool origin")
      f.state.toolOrigin = "https://github.com/untrusted/tools.git";
    await expect(
      prepareAiBootstrap(f.options, { run: f.run, env: f.env, fetch: f.fetch }),
    ).rejects.toThrow();
    expect(f.calls.some(({ command }) => command === process.execPath)).toBe(
      false,
    );
  });

  it.each([
    "GITHUB_REPOSITORY",
    "GITHUB_EVENT_NAME",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
  ])(
    "rejects an Actions preparation with a different %s binding",
    async (name) => {
      const f = await source();
      f.env[name] = name.endsWith("SHA")
        ? "c".repeat(40)
        : "unreviewed-workflow-context";
      await expect(
        validateAiBootstrapSource(f.options, {
          run: f.run,
          env: f.env,
          fetch: f.fetch,
        }),
      ).rejects.toThrow();
    },
  );

  it.each([
    "protection unavailable",
    "disabled",
    "wrong tag selector",
    "mutable tags",
    "unreviewed bypass",
  ])(
    "fails closed when immutable release-tag protection is %s",
    async (kind) => {
      const f = await source();
      if (kind === "protection unavailable") f.state.rulesetStatus = 403;
      if (kind === "disabled") f.state.ruleset.enforcement = "disabled";
      if (kind === "wrong tag selector")
        f.state.ruleset.conditions.ref_name.include = ["refs/tags/other*"];
      if (kind === "mutable tags")
        f.state.ruleset.rules = f.state.ruleset.rules.filter(
          ({ type }) => type !== "update",
        );
      if (kind === "unreviewed bypass")
        f.state.ruleset.bypass_actors = [
          { actor_id: 999999, actor_type: "User", bypass_mode: "always" },
        ];
      await expect(
        prepareAiBootstrap(f.options, {
          run: f.run,
          env: f.env,
          fetch: f.fetch,
        }),
      ).rejects.toThrow();
      expect(f.calls.some(({ command }) => command === process.execPath)).toBe(
        false,
      );
    },
  );

  it("accepts anonymous public tag rules without inventing a verified hidden bypass policy", async () => {
    const f = await source();
    expect(f.state.ruleset).not.toHaveProperty("bypass_actors");
    const result = await prepareAiBootstrap(f.options, {
      run: f.run,
      env: f.env,
      fetch: f.fetch,
    });
    expect(result.manifest.warning).toContain(
      "do not verify a hidden bypass policy",
    );
    expect(result.manifest.warning).toContain(
      "independently verify the full current bypass policy",
    );
    expect(Object.keys(result.manifest.identity).sort()).toEqual([
      "repository",
      "sourceCommit",
      "tag",
      "tagObject",
      "toolCommit",
      "workflow",
      "workflowCommit",
    ]);
  });

  it("accepts an explicitly returned sole reviewed bypass actor while keeping the independent owner gate", async () => {
    const f = await source();
    f.state.ruleset.bypass_actors = [
      { actor_id: 2440101, actor_type: "User", bypass_mode: "always" },
    ];
    await expect(
      validateAiBootstrapSource(f.options, {
        run: f.run,
        env: f.env,
        fetch: f.fetch,
      }),
    ).resolves.toMatchObject({ sourceCommit: reviewedAiBootstrapSource });
  });

  it("prepares all five candidates for local imports but hands off exactly the one AI registration artifact", async () => {
    const f = await source();
    const result = await prepareAiBootstrap(f.options, {
      run: f.run,
      env: f.env,
      fetch: f.fetch,
    });
    expect(result.manifest.artifact.name).toBe(reviewedAiBootstrapName);
    expect(result.manifest.context.candidateCount).toBe(5);
    expect(result.manifest.artifact.dependencies).toEqual(
      reviewedAiBootstrapDependencies,
    );
    expect(result.manifest.hostUsable).toBe(false);
    expect(result.manifest.warning).toContain(
      "Registry @pegma/support-desk-application@0.1.1 lacks",
    );
    const packing = f.calls.filter(
      ({ command }) => command === process.execPath,
    );
    expect(packing).toHaveLength(1);
    expect(packing[0]!.args).toEqual([
      join(f.sourceRoot, "scripts/release-packages.mjs"),
      "pack",
      "--root",
      f.sourceRoot,
      "--require-clean",
      "--require-main-ancestor",
      "--output",
      join(f.output, "context"),
    ]);
    expect(
      f.calls.every(
        ({ args }) =>
          !args.includes("publish") && !args.includes("--provenance"),
      ),
    ).toBe(true);
    expect(f.calls.filter(({ args }) => args[0] === "verify-tag")).toHaveLength(
      2,
    );
    await expect(
      verifyAiBootstrapPrepared({
        preparedDirectory: f.output,
        manifestSha256: result.manifestSha256,
        expectedToolCommit: f.state.toolHead,
      }),
    ).resolves.toMatchObject({ manifestSha256: result.manifestSha256 });
  });

  it("rejects source movement after preparation instead of trusting the pre-build inspection", async () => {
    const f = await source();
    f.onPack(() => {
      f.state.sourceHead = "c".repeat(40);
    });
    await expect(
      prepareAiBootstrap(f.options, { run: f.run, env: f.env, fetch: f.fetch }),
    ).rejects.toThrow();
    expect(
      f.calls.filter(({ command }) => command === process.execPath),
    ).toHaveLength(1);
  });

  it("passes a shell-metacharacter directory as one literal argument without exposing another executable", async () => {
    const f = await source("reviewed source & literal npm publish");
    await prepareAiBootstrap(f.options, {
      run: f.run,
      env: f.env,
      fetch: f.fetch,
    });
    const pack = f.calls.find(({ command }) => command === process.execPath)!;
    expect(pack.args[0]).toBe(
      join(f.sourceRoot, "scripts/release-packages.mjs"),
    );
    expect(pack.args[3]).toBe(f.sourceRoot);
    expect(
      f.calls.every(
        ({ command }) => command === "git" || command === process.execPath,
      ),
    ).toBe(true);
  });

  it("rejects an overlapping tool checkout and output inside either trusted checkout", async () => {
    const f = await source();
    await expect(
      validateAiBootstrapSource(
        { sourceRoot: f.sourceRoot, toolRoot: f.sourceRoot },
        { run: f.run, env: f.env, fetch: f.fetch },
      ),
    ).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    for (const output of [
      join(f.sourceRoot, "output"),
      join(f.toolRoot, "output"),
    ])
      await expect(
        prepareAiBootstrap(
          { ...f.options, output },
          { run: f.run, env: f.env, fetch: f.fetch },
        ),
      ).rejects.toThrow();
    expect(f.calls.every(({ command }) => command === "git")).toBe(true);
  });

  it("refuses a linked source checkout before inspecting or executing it", async () => {
    const f = await source();
    const linked = join(f.workspace, "linked source");
    await symlink(
      f.sourceRoot,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      validateAiBootstrapSource(
        { ...f.options, sourceRoot: linked },
        { run: f.run, env: f.env, fetch: f.fetch },
      ),
    ).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["name", "version", "dependency"])(
    "refuses a source AI manifest with an unreviewed %s",
    async (kind) => {
      const f = await source();
      const path = join(f.sourceRoot, "packages", "ai", "package.json");
      const manifest = structuredClone(f.candidates[4]!.manifest);
      if (kind === "name") manifest.name = "@untrusted/package";
      if (kind === "version") manifest.version = "0.2.0";
      if (kind === "dependency")
        manifest.dependencies["@pegma/support-desk-application"] = "0.2.0";
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(
        prepareAiBootstrap(f.options, {
          run: f.run,
          env: f.env,
          fetch: f.fetch,
        }),
      ).rejects.toThrow();
      expect(f.calls.some(({ command }) => command === process.execPath)).toBe(
        false,
      );
    },
  );
});

describe("unprivileged bootstrap preparation workflow", () => {
  it("verifies the immutable source before running it and exposes no publication or credential authority", async () => {
    const workflow = await readFile(
      join(process.cwd(), ".github/workflows/prepare-ai-bootstrap.yml"),
      "utf8",
    );
    expect(workflow).toMatch(/permissions:\s*\n\s+contents:\s*read/u);
    expect(workflow).not.toMatch(/id-token\s*:\s*write/u);
    expect(workflow).not.toMatch(
      /(?:NODE_AUTH_TOKEN|NPM_AUTH_TOKEN|NPM_TOKEN|secrets\.)/u,
    );
    expect(workflow).not.toMatch(/^\s*(?:run:\s*)?(?:npm|pnpm)\s+publish\b/mu);
    expect(workflow).not.toMatch(/release-packages\.mjs\s+publish/u);
    expect(workflow).toContain("ref: refs/tags/v0.1.1-ai-bootstrap");
    expect(workflow).toContain(reviewedAiBootstrapSource);
    expect(
      workflow.indexOf("ai-bootstrap.mjs verify-source"),
    ).toBeGreaterThanOrEqual(0);
    expect(
      workflow.indexOf("run: pnpm install --frozen-lockfile"),
    ).toBeGreaterThanOrEqual(0);
    expect(workflow.indexOf("ai-bootstrap.mjs verify-source")).toBeLessThan(
      workflow.indexOf("run: pnpm install --frozen-lockfile"),
    );
    expect(
      workflow.match(/persist-credentials:\s*false/gu)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(workflow).toContain(
      "Full current bypass-policy readback is a release-owner gate outside this unprivileged preparation",
    );
  });
});

describe("prepared AI bootstrap artifact", () => {
  it("verifies real tarball bytes, the independently hashed five-candidate manifest and the AI-only copy", async () => {
    const f = await prepared();
    const result = await verifyAiBootstrapPrepared(f.verifyOptions);
    expect(result.manifestSha256).toBe(
      bootstrapHashes(await readFile(f.manifestPath)).sha256,
    );
    expect(result.manifest.identity.sourceCommit).toBe(
      reviewedAiBootstrapSource,
    );
    expect(result.manifest.context.candidateCount).toBe(5);
    expect(result.manifest.artifact.name).toBe(reviewedAiBootstrapName);
    expect(result.manifest.artifact.dependencies).toEqual(
      reviewedAiBootstrapDependencies,
    );
    expect(result.manifest.hostUsable).toBe(false);
    expect(result.manifest.oidcProvenance).toBe(false);
    expect(f.context.packages.map(({ name }) => name)).toEqual(
      reviewedAiBootstrapInventory.map(({ name }) => name),
    );
  });

  it.each([
    "manifest",
    "context manifest",
    "root AI tarball",
    "context AI tarball",
    "other candidate tarball",
  ])(
    "rejects altered %s bytes even when other prepared files remain intact",
    async (kind) => {
      const f = await prepared();
      const file =
        kind === "manifest"
          ? f.manifestPath
          : kind === "context manifest"
            ? f.contextPath
            : kind === "root AI tarball"
              ? join(f.preparedDirectory, f.ai.record.tarball)
              : join(
                  f.contextDirectory,
                  f.context.packages[kind === "context AI tarball" ? 4 : 0]!
                    .tarball,
                );
      await writeFile(
        file,
        Buffer.concat([await readFile(file), Buffer.from("tampered")]),
      );
      await expect(
        verifyAiBootstrapPrepared(f.verifyOptions),
      ).rejects.toThrow();
    },
  );

  it.each([
    "source commit",
    "tag",
    "repository",
    "workflow",
    "workflow commit",
    "tool commit",
    "tag object",
    "host usable",
    "OIDC provenance",
    "purpose",
    "candidate count",
    "context imported",
  ])("rejects a rehashed manifest with a false %s binding", async (kind) => {
    const f = await prepared();
    if (kind === "source commit")
      f.manifest.identity.sourceCommit = "c".repeat(40);
    if (kind === "tag") f.manifest.identity.tag = "v0.2.0";
    if (kind === "repository")
      f.manifest.identity.repository = "untrusted/other-repository";
    if (kind === "workflow")
      f.manifest.identity.workflow = ".github/workflows/publish.yml";
    if (kind === "workflow commit")
      f.manifest.identity.workflowCommit = "c".repeat(40);
    if (kind === "tool commit") f.manifest.identity.toolCommit = "c".repeat(40);
    if (kind === "tag object")
      f.manifest.identity.tagObject = "not-an-immutable-object";
    if (kind === "host usable") f.manifest.hostUsable = true;
    if (kind === "OIDC provenance") f.manifest.oidcProvenance = true;
    if (kind === "purpose")
      f.manifest.purpose = "synchronized-production-release";
    if (kind === "candidate count") f.manifest.context.candidateCount = 4;
    if (kind === "context imported") f.manifest.context.importedLocally = false;
    await f.rewriteManifest();
    await expect(verifyAiBootstrapPrepared(f.verifyOptions)).rejects.toThrow();
  });

  it.each(reviewedAiBootstrapInventory.slice(0, 4))(
    "cannot select $name for the one-name manual publication",
    async ({ name, directory }) => {
      const f = await prepared();
      f.manifest.artifact.name = name;
      f.manifest.artifact.filename = `pegma-support-desk-${directory}-0.1.1.tgz`;
      await f.rewriteManifest();
      await expect(
        verifyAiBootstrapPrepared(f.verifyOptions),
      ).rejects.toThrow();
    },
  );

  it.each([
    "missing package",
    "duplicate package",
    "reordered packages",
    "foreign package",
    "wrong source",
    "advertised release tag",
  ])(
    "rejects the independently rehashed context inventory with %s",
    async (kind) => {
      const f = await prepared();
      if (kind === "missing package") f.context.packages.pop();
      if (kind === "duplicate package")
        f.context.packages[1] = { ...f.context.packages[0]! };
      if (kind === "reordered packages") f.context.packages.reverse();
      if (kind === "foreign package")
        f.context.packages[0]!.name = "@untrusted/other";
      if (kind === "wrong source") f.context.gitCommit = "c".repeat(40);
      if (kind === "advertised release tag")
        Object.assign(f.context, { releaseTag: "v0.2.0" });
      await f.rewriteContext();
      await expect(
        verifyAiBootstrapPrepared(f.verifyOptions),
      ).rejects.toThrow();
    },
  );

  it.each([
    "../outside.tgz",
    "..\\outside.tgz",
    "/outside.tgz",
    "C:\\outside.tgz",
    "\\\\server\\share\\outside.tgz",
  ])(
    "cannot resolve a prepared tarball outside the artifact workspace via %s",
    async (filename) => {
      const f = await prepared();
      f.manifest.artifact.filename = filename;
      await f.rewriteManifest();
      await expect(
        verifyAiBootstrapPrepared(f.verifyOptions),
      ).rejects.toThrow();
    },
  );

  it("rejects a context directory junction or symlink even when its bytes match all hashes", async () => {
    const f = await prepared();
    const outside = join(f.workspace, "outside artifact context");
    await rename(f.contextDirectory, outside);
    await symlink(
      outside,
      f.contextDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(verifyAiBootstrapPrepared(f.verifyOptions)).rejects.toThrow();
  });

  it.each([
    "test source",
    "source directory",
    "parent traversal",
    "archive symlink",
    "wrong dependency",
    "extra dependency",
    "package version",
  ])(
    "rejects a self-consistently rehashed AI tarball containing %s",
    async (kind) => {
      const f = await prepared();
      const entries: BootstrapArchiveEntry[] = [...f.ai.entries];
      if (kind === "test source")
        entries.push({
          path: "package/tests/private.test.ts",
          body: "export const test = true;",
        });
      if (kind === "source directory")
        entries.push({
          path: "package/src/private.ts",
          body: "export const source = true;",
        });
      if (kind === "parent traversal")
        entries.push({
          path: "package/../outside.txt",
          body: "must not escape",
        });
      if (kind === "archive symlink")
        entries.push({
          path: "package/dist/link.js",
          type: "2",
          linkpath: "../../outside.js",
        });
      if (
        kind === "wrong dependency" ||
        kind === "extra dependency" ||
        kind === "package version"
      ) {
        const manifest = structuredClone(f.ai.manifest);
        if (kind === "wrong dependency")
          manifest.dependencies["@pegma/support-desk-application"] = "0.2.0";
        if (kind === "extra dependency")
          manifest.dependencies["@untrusted/runtime"] = "1.0.0";
        if (kind === "package version") manifest.version = "0.2.0";
        entries[0] = {
          path: "package/package.json",
          body: `${JSON.stringify(manifest, null, 2)}\n`,
        };
        f.manifest.artifact.dependencies = { ...manifest.dependencies };
      }
      await replaceAi(f, entries);
      await expect(
        verifyAiBootstrapPrepared(f.verifyOptions),
      ).rejects.toThrow();
    },
  );
});

describe("read-only AI bootstrap registry checks", () => {
  it("permits only a genuine first-name 404 and returns a maintainer instruction without publishing", async () => {
    const f = await prepared();
    const remote = registry(f);
    const receipt = await preflightAiBootstrap(f.registryOptions, {
      fetch: remote.fetch,
    });
    expect(receipt).toMatchObject({
      name: reviewedAiBootstrapName,
      version: "0.1.1",
      action: "publish",
      hostUsable: false,
      oidcProvenance: false,
    });
    expect(receipt.maintainerCommand).toContain(f.ai.record.tarball);
    expect(receipt.maintainerCommand).not.toContain("packages/ai");
    expect(
      remote.fetch.mock.calls.every(([input]) =>
        (input instanceof Request ? input.url : String(input)).includes(
          "support-desk-ai",
        ),
      ),
    ).toBe(true);
  });

  it.each([400, 401, 403, 408, 429, 500, 503])(
    "fails closed on first-name registry HTTP %s",
    async (status) => {
      const f = await prepared();
      const remote = registry(f);
      remote.state.nameStatus = status;
      await expect(
        preflightAiBootstrap(f.registryOptions, { fetch: remote.fetch }),
      ).rejects.toThrow();
    },
  );

  it("fails closed on a transport error rather than treating it as a first-name absence", async () => {
    const f = await prepared();
    const remote = registry(f);
    remote.fetch.mockRejectedValueOnce(
      new TypeError("Synthetic registry outage"),
    );
    await expect(
      preflightAiBootstrap(f.registryOptions, { fetch: remote.fetch }),
    ).rejects.toThrow();
  });

  it("does not bootstrap an existing name whose approved version is absent", async () => {
    const f = await prepared();
    const remote = registry(f);
    remote.state.nameStatus = 200;
    remote.state.includeVersion = false;
    remote.state.versionStatus = 404;
    await expect(
      preflightAiBootstrap(f.registryOptions, { fetch: remote.fetch }),
    ).rejects.toThrow();
  });

  it("exposes actual dist-tags and skips identical existing bytes without claiming host compatibility or OIDC provenance", async () => {
    const f = await prepared();
    const remote = registry(f);
    remote.state.nameStatus = 200;
    remote.state.distTags = {
      latest: "0.1.1",
      bootstrap: "0.1.1",
      experimental: "0.2.0-preview.1",
    };
    const before = await preflightAiBootstrap(f.registryOptions, {
      fetch: remote.fetch,
    });
    const after = await postflightAiBootstrap(f.registryOptions, {
      fetch: remote.fetch,
    });
    for (const receipt of [before, after]) {
      expect(receipt.action).toBe("skip");
      expect(receipt.distTags).toEqual(remote.state.distTags);
      expect(receipt.hostUsable).toBe(false);
      expect(receipt.oidcProvenance).toBe(false);
      expect(receipt.artifactSha256).toBe(f.registryOptions.artifactSha256);
    }
  });

  it.each([
    "wrong bytes",
    "wrong integrity",
    "wrong shasum",
    "wrong dependency",
    "wrong name",
    "wrong version",
    "malformed metadata",
    "OIDC provenance claim",
    "runtime dependency claim",
  ])("hard-fails an existing registration with %s", async (kind) => {
    const f = await prepared();
    const remote = registry(f);
    remote.state.nameStatus = 200;
    if (kind === "wrong bytes")
      remote.state.tarballBytes = Buffer.from("different existing npm tarball");
    if (kind === "wrong integrity")
      remote.state.metadata.dist.integrity = "sha512-untrusted";
    if (kind === "wrong shasum")
      remote.state.metadata.dist.shasum = "c".repeat(40);
    if (kind === "wrong dependency")
      remote.state.metadata.dependencies["@pegma/support-desk-application"] =
        "0.2.0";
    if (kind === "wrong name")
      remote.state.metadata.name = "@untrusted/package";
    if (kind === "wrong version") remote.state.metadata.version = "0.2.0";
    if (kind === "malformed metadata") remote.state.malformedJson = true;
    if (kind === "OIDC provenance claim")
      Object.assign(remote.state.metadata.dist, {
        attestations: { provenance: "unexpected-oidc-provenance" },
      });
    if (kind === "runtime dependency claim")
      Object.assign(remote.state.metadata, {
        optionalDependencies: { "@untrusted/runtime": "1.0.0" },
      });
    await expect(
      preflightAiBootstrap(f.registryOptions, { fetch: remote.fetch }),
    ).rejects.toThrow();
  });

  it("does not accept a still-missing name as successful postflight", async () => {
    const f = await prepared();
    const remote = registry(f);
    await expect(
      postflightAiBootstrap(f.registryOptions, { fetch: remote.fetch }),
    ).rejects.toThrow();
  });

  it.each([
    "independent ZIP digest",
    "ZIP bytes differ from extracted files",
    "ZIP path traversal",
    "ZIP extra publication artifact",
  ])("rejects %s before registry access", async (kind) => {
    const f = await prepared();
    const remote = registry(f);
    let options = f.registryOptions;
    if (kind === "independent ZIP digest")
      options = { ...options, artifactSha256: "c".repeat(64) };
    else {
      const entries = await f.archiveEntries();
      if (kind === "ZIP bytes differ from extracted files")
        entries[0] = {
          ...entries[0]!,
          body: Buffer.from("different archived bootstrap manifest"),
        };
      if (kind === "ZIP path traversal")
        entries.push({ path: "../outside.json", body: Buffer.from("outside") });
      if (kind === "ZIP extra publication artifact")
        entries.push({
          path: "pegma-other-package-0.1.1.tgz",
          body: Buffer.from("unreviewed"),
        });
      await f.rewriteArchive(entries);
      options = f.registryOptions;
    }
    await expect(
      preflightAiBootstrap(options, { fetch: remote.fetch }),
    ).rejects.toThrow();
    expect(remote.fetch).not.toHaveBeenCalled();
  });
});
