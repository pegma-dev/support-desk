import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as application from "@pegma/support-desk-application";
import * as storage from "@pegma/storage-core";
import * as templates from "@pegma/support-desk-templates";
import { describe, expect, it } from "vitest";
import { RELEASE_PACKAGES } from "../scripts/release-packages.mjs";
import {
  CONSUMER_TOOLCHAIN,
  PREVIOUS_APPLICATION,
  consumerArtifactBindings,
  consumerPlans,
  consumerVerificationPath,
  exerciseBaseConsumer,
  verifyConsumerReceipt,
  type ConsumerPackageRecord,
} from "../scripts/release-consumers.mjs";
import {
  releaseArtifactFixture,
  releaseFixtureTarball,
} from "../test/release-verification-fixtures.js";

function artifacts(): ConsumerPackageRecord[] {
  return RELEASE_PACKAGES.map((definition) => {
    const manifest = JSON.parse(
      readFileSync(
        join(process.cwd(), "packages", definition.directory, "package.json"),
        "utf8",
      ),
    ) as ConsumerPackageRecord["manifest"];
    return {
      ...definition,
      version: manifest.version,
      manifest,
      tarballPath: join(
        tmpdir(),
        "release artifacts with spaces",
        `${definition.directory}-${manifest.version}.tgz`,
      ),
    };
  });
}

describe("isolated release consumers", () => {
  it("binds actual archive identities and bytes rather than trusting package metadata", async () => {
    const f = releaseArtifactFixture();
    try {
      const records = f.packages.map(({ record }) => ({
        ...record,
        tarballPath: join(f.directory, record.tarball),
      }));
      const bindings = await consumerArtifactBindings(
        records,
        RELEASE_PACKAGES,
      );
      for (const [index, record] of records.entries()) {
        const bytes = readFileSync(record.tarballPath);
        expect(bindings[index]).toEqual({
          name: record.name,
          version: record.version,
          tarball: record.tarball,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          shasum: createHash("sha1").update(bytes).digest("hex"),
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        });
      }
      await expect(
        consumerArtifactBindings(
          records.map((record, index) =>
            index === 0 ? { ...record, version: "9.9.9" } : record,
          ),
          RELEASE_PACKAGES,
        ),
      ).rejects.toThrow("archive version differs");
      const sourceCommit = "1".repeat(40);
      const receipt = {
        schemaVersion: 1,
        synthetic: true,
        sourceRepository: "pegma-dev/support-desk",
        sourceCommit,
        candidateVersion: records[0]!.version,
        artifacts: bindings,
      };
      await expect(
        verifyConsumerReceipt(receipt, {
          sourceCommit: "2".repeat(40),
          records,
          inventory: RELEASE_PACKAGES,
        }),
      ).rejects.toThrow("source differs");
      const changed = releaseFixtureTarball({
        name: records[0]!.name,
        version: records[0]!.version,
        description: "Different bytes under the same version",
      });
      writeFileSync(records[0]!.tarballPath, changed.bytes);
      await expect(
        verifyConsumerReceipt(receipt, {
          sourceCommit,
          records,
          inventory: RELEASE_PACKAGES,
        }),
      ).rejects.toThrow("artifacts differ");
    } finally {
      f.dispose();
    }
  });
  it("keeps diagnostic consumer evidence beside the immutable six-file artifact", () => {
    const output = join(tmpdir(), "release artifacts with spaces", "prepared");
    const receipt = consumerVerificationPath(output);
    expect(receipt).toBe(`${resolve(output)}-consumer-verification.json`);
    expect(dirname(receipt)).toBe(dirname(resolve(output)));
    expect(dirname(receipt)).not.toBe(resolve(output));
    expect(consumerVerificationPath(".release")).toBe(
      resolve(".release-consumer-verification.json"),
    );
  });
  it("selects four candidate base archives without optional AI/KB and pins the real previous writer", () => {
    const plans = consumerPlans(artifacts(), RELEASE_PACKAGES);
    expect(
      Object.keys(plans.base).filter((name) =>
        RELEASE_PACKAGES.some((entry) => entry.name === name),
      ),
    ).toHaveLength(4);
    expect(plans.base["@pegma/support-desk-ai"]).toBeUndefined();
    expect(
      Object.keys(plans.base).some((name) =>
        name.startsWith("@pegma/knowledge-base-"),
      ),
    ).toBe(false);
    expect(plans.base[PREVIOUS_APPLICATION.alias]).toBe(
      "npm:@pegma/support-desk-application@0.1.1",
    );
    expect(plans.base["@pegma/support-desk-application"]).toMatch(
      /^file:.*release%20artifacts%20with%20spaces/u,
    );
    expect(plans.ai).toMatchObject(CONSUMER_TOOLCHAIN);
    for (const definition of RELEASE_PACKAGES)
      expect(plans.ai[definition.name]).toMatch(/^file:/u);
  });

  it("rejects a mixed-version archive set before installing any host", () => {
    const records = artifacts();
    records[2] = { ...records[2]!, version: "9.9.9" };
    expect(() => consumerPlans(records, RELEASE_PACKAGES)).toThrow(
      "synchronized",
    );
  });

  it("rejects missing or reordered candidate archives instead of resolving a registry substitute", () => {
    const records = artifacts();
    expect(() => consumerPlans(records.slice(0, 4), RELEASE_PACKAGES)).toThrow(
      "inventory",
    );
    [records[0], records[1]] = [records[1]!, records[0]!];
    expect(() => consumerPlans(records, RELEASE_PACKAGES)).toThrow("order");
  });

  it.each(["omitted", "disabled"] as const)(
    "runs real customer/staff/web/email/queue/privacy flows with AI %s",
    async (mode) => {
      const result = await exerciseBaseConsumer(
        { application, storage, templates },
        mode,
      );
      expect(result).toMatchObject({
        mode,
        customerMessages: 4,
        staffNotesPerTicket: 2,
        queueTickets: 3,
        omittedOrDisabledAi: true,
        noteIsolation: true,
        legacyWriter: null,
        legacyMigrationScope: null,
        emailWriter: "candidate",
        forwardOnly: true,
      });
      expect(result.webTicketId).not.toBe(result.emailTicketId);
      expect(result.freshTicketId).toContain("fresh-human");
    },
  );

  it("fails the release probe if a real public customer read leaks an internal note", async () => {
    const leaking = {
      ...application,
      createSupportDeskApplication(
        options: Parameters<typeof application.createSupportDeskApplication>[0],
      ) {
        const actual = application.createSupportDeskApplication(options);
        return {
          ...actual,
          async readCustomerTicket(
            ...args: Parameters<typeof actual.readCustomerTicket>
          ) {
            const result = await actual.readCustomerTicket(...args);
            return {
              ...result,
              messages: result.messages.map((message, index) =>
                index === 0
                  ? { ...message, body: "PRIVATE_INJECTED_NOTE" }
                  : message,
              ),
            };
          },
        };
      },
    };
    await expect(
      exerciseBaseConsumer({ application: leaking, storage, templates }),
    ).rejects.toThrow("private note leaked");
  });
});
