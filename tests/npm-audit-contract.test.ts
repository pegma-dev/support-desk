import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RELEASE_NPM_VERSION,
  verifyProvenanceAudit,
  type ReleaseIdentity,
} from "../scripts/release-verification.mjs";

interface CapturedAudit {
  invalid: unknown[];
  missing: unknown[];
  verified: {
    name: string;
    version: string;
    location: string;
    registry: string;
    attestationBundles: { predicateType: string; bundle: unknown }[];
  }[];
}
interface NpmAuditCapture {
  schemaVersion: number;
  fixtureKind: string;
  scope: string;
  excerpt: boolean;
  rawOutputPreserved: boolean;
  capture: {
    npmVersion: string;
    npmCliTarballSha256: string;
    command: string[];
    exitCode: number;
    stdoutBytes: number;
    stdoutSha256: string;
    stderrBytes: number;
    stderrSha256: string;
    configuration: string;
    credentialsUsed: boolean;
    installedPackages: {
      name: string;
      version: string;
      resolved: string;
      integrity: string;
    }[];
  };
  independentExpectation: {
    source: string;
    identity: ReleaseIdentity;
    package: { name: string; version: string; integrity: string };
  };
  auditStdout: string;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../test/fixtures/npm-audit-11.18.0.json", import.meta.url),
    "utf8",
  ),
) as NpmAuditCapture;

// These values were supplied independently by the release owner: the peeled
// historical tag commit and a fresh official-registry integrity read. They are
// deliberately not inferred from the signed statement that is being checked.
const independentIdentity: ReleaseIdentity = {
  repository: "pegma-dev/support-desk",
  workflow: ".github/workflows/publish.yml",
  environment: "npm-publish",
  tag: "v0.1.1",
  commit: "7ba8ee89eca75a3044ec70d93553c9d75dd5ef25",
  version: "0.1.1",
};
const independentPackage = {
  name: "@pegma/support-desk-contracts",
  version: "0.1.1",
  integrity:
    "sha512-8HdZauiLdk/B41atlG/ixIXg4N+b0PSUbXELYIEaVBXhtjKvRJEDvod5AaWjHL1X9h3OYuhR3g21UYZuEedIxQ==",
};
function expectedRelease() {
  return {
    identity: { ...independentIdentity },
    packages: [{ ...independentPackage }],
  };
}
function actualAudit(): CapturedAudit {
  return JSON.parse(fixture.auditStdout) as CapturedAudit;
}

describe("actual npm 11.18.0 audit signatures contract", () => {
  it("retains the complete authentic CLI output and pins the observed supported command and capture hashes", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.fixtureKind).toBe("authentic-npm-audit-signatures-output");
    expect(fixture.excerpt).toBe(false);
    expect(fixture.rawOutputPreserved).toBe(true);
    expect(fixture.capture.npmVersion).toBe("11.18.0");
    expect(RELEASE_NPM_VERSION).toBe("11.18.0");
    expect(fixture.capture.npmCliTarballSha256).toBe(
      "73f6155215ebabf4ed96dca1f567c2372cc713c33af2e5b9b62fde4e92373e2e",
    );
    expect(fixture.capture.command).toEqual([
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
      "--registry",
      "https://registry.npmjs.org/",
    ]);
    expect(fixture.capture.exitCode).toBe(0);
    expect(fixture.capture.stderrBytes).toBe(0);
    expect(fixture.capture.stderrSha256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const bytes = Buffer.from(fixture.auditStdout, "utf8");
    expect(bytes.byteLength).toBe(35002);
    expect(fixture.capture.stdoutBytes).toBe(bytes.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "0adcae111adc8722f6466b3b13d209f813f49919a36c7fa7f547311f14c5a208",
    );
    expect(fixture.capture.stdoutSha256).toBe(
      "0adcae111adc8722f6466b3b13d209f813f49919a36c7fa7f547311f14c5a208",
    );
    expect(fixture.capture.configuration).toBe("isolated empty files");
    expect(fixture.capture.credentialsUsed).toBe(false);
    expect(fixture.scope).toContain("not 0.2.0 publication");
  });

  it("exercises the actual published dependency tree and npm schema without manufacturing certificates or signed envelopes", () => {
    const audit = actualAudit();
    expect(Object.keys(audit).sort()).toEqual([
      "invalid",
      "missing",
      "verified",
    ]);
    expect(audit.invalid).toEqual([]);
    expect(audit.missing).toEqual([]);
    expect(
      audit.verified.map(({ name, version }) => ({ name, version })),
    ).toEqual([
      { name: "@pegma/spine", version: "0.1.1" },
      { name: "@pegma/support-desk-contracts", version: "0.1.1" },
    ]);
    expect(
      fixture.capture.installedPackages.map(({ name, version }) => ({
        name,
        version,
      })),
    ).toEqual(audit.verified.map(({ name, version }) => ({ name, version })));
    for (const entry of audit.verified) {
      expect(entry.location).toBe(`node_modules/${entry.name}`);
      expect(entry.registry).toBe("https://registry.npmjs.org/");
      expect(entry.attestationBundles).toHaveLength(2);
      expect(
        entry.attestationBundles.filter(
          ({ predicateType }) =>
            predicateType === "https://slsa.dev/provenance/v1",
        ),
      ).toHaveLength(1);
    }
    expect(fixture.independentExpectation.identity).toEqual(
      independentIdentity,
    );
    expect(fixture.independentExpectation.package).toEqual(independentPackage);
  });

  it("accepts unmodified historical CLI-verified Support Desk provenance with independently pinned tag, commit and tarball identity", () => {
    const audit = actualAudit();
    const before = JSON.stringify(audit);
    // npm performed cryptographic audit during the recorded capture. This
    // offline regression exercises the production parser and source policy;
    // it does not claim to repeat Sigstore verification or prove a new release.
    expect(() => verifyProvenanceAudit(audit, expectedRelease())).not.toThrow();
    expect(JSON.stringify(audit)).toBe(before);
  });

  it.each([
    "source commit",
    "release tag",
    "package version",
    "tarball integrity",
    "unpublished AI name",
  ] as const)(
    "rejects a different expected %s against the untouched authentic output",
    (field) => {
      const expected = expectedRelease();
      if (field === "source commit") expected.identity.commit = "f".repeat(40);
      if (field === "release tag") expected.identity.tag = "v0.2.0";
      if (field === "package version") expected.packages[0]!.version = "0.2.0";
      if (field === "tarball integrity")
        expected.packages[0]!.integrity = `sha512-${Buffer.alloc(64, 0x42).toString("base64")}`;
      if (field === "unpublished AI name")
        expected.packages[0]!.name = "@pegma/support-desk-ai";
      expect(() => verifyProvenanceAudit(actualAudit(), expected)).toThrow();
    },
  );

  it("rejects the authentic foreign Spine bundle as evidence for this Support Desk release", () => {
    const expected = expectedRelease();
    expected.packages = [
      {
        name: "@pegma/spine",
        version: "0.1.1",
        integrity:
          "sha512-EV0Zq8KJX7r7ybI+eIHUCAhnd261bveZykMQVmmZibSDRJVcd2bOuYCPvPg4wax7GmrUrdtVFJYEJqHl4PkhwQ==",
      },
    ];
    expect(() => verifyProvenanceAudit(actualAudit(), expected)).toThrow();
  });

  it("does not reinterpret the historical capture as synchronized 0.2.0 publication evidence", () => {
    const expected = expectedRelease();
    expected.identity.tag = "v0.2.0";
    expected.identity.version = "0.2.0";
    expected.identity.commit = "eddd3526f8bec3a1a80cc7aacd3a4cdcdb950cfe";
    expected.packages[0]!.version = "0.2.0";
    expect(() => verifyProvenanceAudit(actualAudit(), expected)).toThrow();
  });
});
