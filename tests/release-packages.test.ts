import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELEASE_PACKAGES,
  decidePublication,
  lockDependencyMatches,
  parseArguments,
  parsePnpmLockfileImporters,
  resolvedVersionSatisfies,
  runNpm as runReleaseNpm,
  unquoteYamlScalar,
  validateReleaseTag,
  validateRepository,
} from "../scripts/release-packages.mjs";

const git = process.platform === "win32" ? "git.exe" : "git";
const releaseVersion = (
  JSON.parse(
    readFileSync(
      join(process.cwd(), "packages", "contracts", "package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

function run(command: string, arguments_: string[], cwd?: string): string {
  // Node refuses to spawn .cmd files without a shell; cmd.exe then joins argv,
  // so quote every argument rather than trusting paths to be space-free.
  const viaShell = process.platform === "win32" && command.endsWith(".cmd");
  if (
    viaShell &&
    arguments_.some((argument) => /["%^&|<>!\r\n]/.test(argument))
  ) {
    throw new TypeError("unsafe argument for a Windows shell spawn");
  }
  return execFileSync(
    command,
    viaShell ? arguments_.map((argument) => `"${argument}"`) : arguments_,
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: viaShell,
    },
  ).trim();
}

function runNpm(arguments_: string[], cwd = process.cwd()): string {
  return run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, cwd);
}

describe("release package metadata", () => {
  it("rejects the retired publisher before reading any manifest", async () => {
    expect(await import("../scripts/release-packages.mjs")).not.toHaveProperty(
      "publishPreparedRelease",
    );
    expect(() =>
      run(process.execPath, [
        join(process.cwd(), "scripts", "release-packages.mjs"),
        "publish",
        "--manifest",
        join(tmpdir(), "retired-release-manifest-does-not-exist.json"),
      ]),
    ).toThrow("release-packages.mjs publish has been removed");
  });

  it("accepts npm's cross-platform argument separator", () => {
    expect(parseArguments(["--", "--output", ".release"])).toEqual({
      output: ".release",
    });
  });

  it("keeps the exact public package inventory in dependency order", () => {
    expect(RELEASE_PACKAGES.map(({ name }) => name)).toEqual([
      "@pegma/support-desk-contracts",
      "@pegma/support-desk-core",
      "@pegma/support-desk-templates",
      "@pegma/support-desk-application",
      "@pegma/support-desk-ai",
    ]);
  });

  it("ships the synchronized 0.2.6 candidate package set with exact internal pins", () => {
    const manifests = RELEASE_PACKAGES.map(({ directory }) =>
      JSON.parse(
        readFileSync(
          join(process.cwd(), "packages", directory, "package.json"),
          "utf8",
        ),
      ),
    ) as Array<{
      name: string;
      version: string;
      dependencies?: Record<string, string>;
    }>;

    expect(manifests.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "@pegma/support-desk-contracts", version: "0.2.6" },
      { name: "@pegma/support-desk-core", version: "0.2.6" },
      { name: "@pegma/support-desk-templates", version: "0.2.6" },
      { name: "@pegma/support-desk-application", version: "0.2.6" },
      { name: "@pegma/support-desk-ai", version: "0.2.6" },
    ]);
    expect(manifests[1]?.dependencies?.["@pegma/support-desk-contracts"]).toBe(
      "0.2.6",
    );
    expect(manifests[3]?.dependencies?.["@pegma/support-desk-contracts"]).toBe(
      "0.2.6",
    );
    expect(manifests[3]?.dependencies?.["@pegma/support-desk-core"]).toBe(
      "0.2.6",
    );
    expect(
      manifests[4]?.dependencies?.["@pegma/support-desk-application"],
    ).toBe("0.2.6");
    expect(
      manifests[4]?.dependencies?.["@pegma/support-desk-contracts"],
    ).toBeUndefined();
    expect(
      manifests[4]?.dependencies?.["@pegma/knowledge-base-application"],
    ).toBe("0.1.5");
    expect(
      manifests[4]?.dependencies?.["@pegma/knowledge-base-contracts"],
    ).toBe("0.1.5");
    expect(
      Object.keys(manifests[3]?.dependencies ?? {}).filter((name) =>
        name.startsWith("@pegma/knowledge-base-"),
      ),
    ).toEqual([]);
  });

  it("validates package manifests and the lockfile together", async () => {
    await expect(validateRepository()).resolves.toBeDefined();
  });

  it("checks release evidence in the selected repository root", () => {
    const checkout = process.cwd();
    const root = mkdtempSync(join(tmpdir(), "support-desk-release-check-"));
    const script = join(checkout, "scripts", "release-packages.mjs");
    const versions = ["v0.2.2", "v0.2.3", "v0.2.4", "v0.2.5"];
    const evidenceFiles = [
      "package-manifest.json",
      "prepared-artifact.json",
      "qualified-release-notes.md",
      "registry-verification.json",
      "verification-job.json",
    ];
    const check = () =>
      run(process.execPath, [script, "check", "--root", root]);
    try {
      for (const name of ["package.json", "pnpm-lock.yaml"]) {
        cpSync(join(checkout, name), join(root, name));
      }
      for (const { directory } of RELEASE_PACKAGES) {
        const path = join("packages", directory);
        mkdirSync(join(root, path), { recursive: true });
        for (const name of ["package.json", "README.md", "LICENSE"]) {
          cpSync(join(checkout, path, name), join(root, path, name));
        }
      }
      mkdirSync(join(root, "docs", "releases"), { recursive: true });
      for (const version of versions) {
        const evidence = join("docs", "releases", version);
        cpSync(join(checkout, evidence), join(root, evidence), {
          recursive: true,
        });
      }

      expect(check()).toBe("Release metadata is valid.");
      for (const version of versions) {
        for (const name of evidenceFiles) {
          const relative = `docs/releases/${version}/${name}`;
          const path = join(root, relative);
          const original = readFileSync(path);

          writeFileSync(path, "{}\n");
          expect(check).toThrow(
            `published release evidence SHA-256 mismatch: ${relative}`,
          );
          writeFileSync(path, original);

          rmSync(path);
          expect(check).toThrow(
            `published release evidence is missing: ${relative}`,
          );
          writeFileSync(path, original);
        }
      }
      expect(check()).toBe("Release metadata is valid.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches each lockfile dependency to its own specifier and resolved version", () => {
    const importers = parsePnpmLockfileImporters(`importers:

  .:
    devDependencies:
      prettier:
        specifier: ^3.9.6
        version: 3.9.6

  packages/application:
    dependencies:
      '@pegma/spine':
        specifier: 0.1.1
        version: 0.1.1
      '@pegma/support-desk-contracts':
        specifier: 0.1.1
        version: link:../contracts

  packages/templates: {}

packages:
  prettier@3.9.6:
    resolution: {integrity: sha512-example}
`);
    expect(importers["packages/application"]).toEqual({
      dependencies: {
        "@pegma/spine": { specifier: "0.1.1", version: "0.1.1" },
        "@pegma/support-desk-contracts": {
          specifier: "0.1.1",
          version: "link:../contracts",
        },
      },
    });
    expect(importers["packages/templates"]).toEqual({});

    const live = parsePnpmLockfileImporters(
      readFileSync(join(process.cwd(), "pnpm-lock.yaml"), "utf8"),
    );
    expect(
      live["packages/application"]?.dependencies?.[
        "@pegma/support-desk-contracts"
      ],
    ).toEqual({
      specifier: "0.2.6",
      version: "link:../contracts",
    });
    expect(
      live["packages/application"]?.dependencies?.["@pegma/spine"],
    ).toEqual({
      specifier: "0.1.2",
      version: "0.1.2",
    });
  });

  it("decodes quoted lockfile specifier and version scalars", () => {
    expect(unquoteYamlScalar("'1'")).toBe("1");
    expect(unquoteYamlScalar("'*'")).toBe("*");
    expect(unquoteYamlScalar('"1"')).toBe("1");

    const importers = parsePnpmLockfileImporters(`importers:

  packages/example:
    dependencies:
      b:
        specifier: '1'
        version: '1'
    peerDependencies:
      '*':
        specifier: '*'
        version: 1.2.3

packages:
`);
    expect(importers["packages/example"]).toEqual({
      dependencies: {
        b: { specifier: "1", version: "1" },
      },
      peerDependencies: {
        "*": { specifier: "*", version: "1.2.3" },
      },
    });
    expect(
      lockDependencyMatches(
        importers["packages/example"]?.dependencies?.b,
        "1",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        importers["packages/example"]?.peerDependencies?.["*"],
        "*",
      ),
    ).toBe(true);
  });

  it("accepts resolved versions that satisfy a range and still requires exact pins", () => {
    expect(resolvedVersionSatisfies("1", "1.2.3")).toBe(true);
    expect(resolvedVersionSatisfies("^1.2.0", "1.2.3")).toBe(true);
    expect(
      resolvedVersionSatisfies("^1.2.0", "1.2.3(@types/node@26.1.1)"),
    ).toBe(true);
    expect(resolvedVersionSatisfies("^1.2.0", "2.0.0")).toBe(false);
    expect(resolvedVersionSatisfies("0.1.1", "0.1.1")).toBe(true);
    expect(resolvedVersionSatisfies("0.1.1", "0.1.2")).toBe(false);
    expect(
      lockDependencyMatches(
        { specifier: "^13.3.2", version: "13.3.2" },
        "^13.3.2",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches({ specifier: "0.1.1", version: "0.1.2" }, "0.1.1"),
    ).toBe(false);
    expect(
      lockDependencyMatches(
        { specifier: "0.1.1", version: "link:../contracts" },
        "0.1.1",
        { workspace: true },
      ),
    ).toBe(true);
  });

  it("invokes npm even when npm_execpath points at pnpm", () => {
    const npmVersion = run(process.platform === "win32" ? "npm.cmd" : "npm", [
      "--version",
    ]);
    const previous = process.env.npm_execpath;
    process.env.npm_execpath = "/tmp/fake-pnpm.cjs";
    try {
      const version = runReleaseNpm(["--version"], {
        capture: true,
      }).stdout.trim();
      expect(version).toBe(npmVersion);
    } finally {
      if (previous === undefined) {
        delete process.env.npm_execpath;
      } else {
        process.env.npm_execpath = previous;
      }
    }
  });

  it("requires the release tag to match a public package version", async () => {
    await expect(validateRepository({ releaseTag: "v9.9.9" })).rejects.toThrow(
      "does not match any public package version",
    );
    await expect(
      validateRepository({
        releaseTag: `v${releaseVersion}`,
        releasePrerelease: true,
      }),
    ).rejects.toThrow("prereleases cannot publish packages");
  });

  it("npm pack --dry-run publishes only reviewed dist and package files", () => {
    for (const definition of RELEASE_PACKAGES) {
      // Prefer workspace selection so npm never treats a relative path as a
      // remote package name (CI resolved `packages/contracts` as
      // ssh://git@github.com/packages/contracts.git).
      const stdout = runNpm([
        "pack",
        "--workspace",
        definition.name,
        "--dry-run",
        "--json",
      ]);
      const packedList = JSON.parse(stdout) as Array<{
        name: string;
        version: string;
        files: Array<{ path: string }>;
      }>;
      const packed = packedList[0];
      expect(packed).toBeDefined();
      if (packed === undefined) {
        throw new Error(`npm pack returned no metadata for ${definition.name}`);
      }
      expect(packed.name).toBe(definition.name);
      expect(packed.version).toBe(releaseVersion);
      const paths = packed.files.map(({ path }) => path);
      expect(paths).toEqual(
        expect.arrayContaining(["package.json", "README.md", "LICENSE"]),
      );
      expect(
        paths.every(
          (path) =>
            ["package.json", "README.md", "LICENSE"].includes(path) ||
            path.startsWith("dist/"),
        ),
      ).toBe(true);
      expect(paths.some((path) => path.startsWith("dist/"))).toBe(true);
      expect(paths.some((path) => path.includes("src/"))).toBe(false);
      expect(paths.some((path) => path.endsWith(".test.ts"))).toBe(false);
    }
  });
});

describe("release source authentication", () => {
  it("accepts only an approved signed annotated tag at the event commit", () => {
    const root = mkdtempSync(join(tmpdir(), "support-desk-release-tag-"));
    try {
      run(git, ["init", "--quiet"], root);
      run(git, ["config", "user.name", "Release Test"], root);
      run(git, ["config", "user.email", "release@example.com"], root);
      writeFileSync(join(root, "README.md"), "release test\n");
      run(git, ["add", "README.md"], root);
      run(git, ["commit", "--quiet", "-m", "release"], root);
      run(git, ["branch", "-M", "main"], root);
      run(git, ["update-ref", "refs/remotes/origin/main", "HEAD"], root);
      const releaseCommit = run(git, ["rev-parse", "HEAD"], root);

      const signingKey = join(root, "release-signing-key");
      run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "release@example.com",
        "-f",
        signingKey,
      ]);
      const allowedSigners = join(root, "allowed-signers");
      writeFileSync(
        allowedSigners,
        `release@example.com ${readFileSync(`${signingKey}.pub`, "utf8").trim()}\n`,
      );
      run(git, ["config", "gpg.format", "ssh"], root);
      run(git, ["config", "user.signingkey", signingKey], root);
      run(git, ["config", "gpg.ssh.allowedSignersFile", allowedSigners], root);

      run(git, ["tag", "--sign", "v0.0.0", "--message", "signed"], root);
      expect(
        validateReleaseTag({
          root,
          releaseTag: "v0.0.0",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toEqual({ headCommit: releaseCommit, releaseTag: "v0.0.0" });

      run(git, ["tag", "v0.0.1"], root);
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.0.1",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("annotated tag object");

      run(
        git,
        [
          "-c",
          "commit.gpgsign=false",
          "tag",
          "--annotate",
          "v0.0.2",
          "--message",
          "unsigned",
        ],
        root,
      );
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.0.2",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("not valid for an approved signer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps preparation outside the OIDC-enabled publisher job", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf8",
    );
    const jobsMarker = "\njobs:\n";
    const jobsIndex = workflow.indexOf(jobsMarker);
    expect(jobsIndex).toBeGreaterThanOrEqual(0);
    const header = workflow.slice(0, jobsIndex);
    const jobs = workflow.slice(jobsIndex + jobsMarker.length);
    const prepareStart = jobs.indexOf("  prepare:");
    const publishStart = jobs.indexOf("\n  publish:");
    const verifyStart = jobs.indexOf("\n  verify:");
    expect(header).not.toContain("id-token: write");
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(publishStart).toBeGreaterThan(prepareStart);
    expect(verifyStart).toBeGreaterThan(publishStart);
    const prepare = jobs.slice(prepareStart, publishStart);
    const publish = jobs.slice(publishStart, verifyStart);
    const verify = jobs.slice(verifyStart);
    expect(prepare).not.toContain("id-token: write");
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("npm ci");
    expect(publish).not.toContain("pnpm install");
    expect(publish).not.toMatch(/\bnpm (?:ci|install)/u);
    expect(publish).toContain("NPM_VERSION: 11.18.0");
    expect(publish).toContain(
      "NPM_TARBALL_SHA256: 73f6155215ebabf4ed96dca1f567c2372cc713c33af2e5b9b62fde4e92373e2e",
    );
    expect(publish).toContain("node scripts/release-verification.mjs publish");
    expect(publish).not.toContain("node scripts/release-packages.mjs publish");
    expect(publish).toContain("--manifest-sha256");
    expect(publish).toContain(
      "artifact-ids: ${{ needs.prepare.outputs.artifact-id }}",
    );
    expect(publish).not.toContain("corepack");
    expect(publish).not.toContain("pnpm");
    expect(verify).not.toContain("id-token: write");
    expect(verify).toContain("node scripts/release-verification.mjs verify");
    expect(verify).toContain(
      "artifact-ids: ${{ needs.prepare.outputs.artifact-id }}",
    );
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toContain("retention-days: 30");
  });
});

describe("retry-safe publication", () => {
  const integrity = "sha512-cHJlcGFyZWQtdGFyYmFsbA==";

  it("publishes an absent version", () => {
    expect(decidePublication(integrity, null)).toBe("publish");
  });

  it("skips a byte-identical existing version", () => {
    expect(decidePublication(integrity, integrity)).toBe("skip");
  });

  it("rejects an existing version with different bytes", () => {
    expect(() => decidePublication(integrity, "sha512-ZGlmZmVyZW50")).toThrow(
      "different tarball integrity",
    );
  });
});
