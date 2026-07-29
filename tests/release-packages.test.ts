import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELEASE_PACKAGES,
  decidePublication,
  parseArguments,
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
  return execFileSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runNpm(arguments_: string[], cwd = process.cwd()): string {
  const npmExecPath = process.env["npm_execpath"];
  if (npmExecPath !== undefined) {
    return run(process.execPath, [npmExecPath, ...arguments_], cwd);
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, cwd);
}

describe("release package metadata", () => {
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
    ]);
  });

  it("ships the first synchronized 0.1.0 package set with exact internal pins", () => {
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
      { name: "@pegma/support-desk-contracts", version: "0.1.0" },
      { name: "@pegma/support-desk-core", version: "0.1.0" },
      { name: "@pegma/support-desk-templates", version: "0.1.0" },
      { name: "@pegma/support-desk-application", version: "0.1.0" },
    ]);
    expect(manifests[1]?.dependencies?.["@pegma/support-desk-contracts"]).toBe(
      "0.1.0",
    );
    expect(manifests[3]?.dependencies?.["@pegma/support-desk-contracts"]).toBe(
      "0.1.0",
    );
    expect(manifests[3]?.dependencies?.["@pegma/support-desk-core"]).toBe(
      "0.1.0",
    );
  });

  it("validates package manifests and the lockfile together", async () => {
    await expect(validateRepository()).resolves.toBeDefined();
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
      const stdout = runNpm([
        "pack",
        join("packages", definition.directory),
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
    expect(header).not.toContain("id-token: write");
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(publishStart).toBeGreaterThan(prepareStart);
    const prepare = jobs.slice(prepareStart, publishStart);
    const publish = jobs.slice(publishStart);
    expect(prepare).not.toContain("id-token: write");
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("npm ci");
    expect(publish).not.toContain("npm install");
    expect(publish).toContain("npm run release:publish");
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
