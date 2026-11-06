import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Explicit, read-only network refresh for a reviewed P-00 snapshot.
// CI consumes the checked-in snapshot and never queries npm.
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length > 3) {
  throw new Error("Usage: node scripts/knowledge-ai-baseline.mjs [source-ref]");
}
const sourceRevision = execFileSync(
  "git",
  [
    "rev-parse",
    "--verify",
    "--end-of-options",
    (process.argv[2] ?? "HEAD") + "^{commit}",
  ],
  { cwd: repositoryRoot, encoding: "utf8" },
).trim();
const registryBase = "https://registry.npmjs.org/";
const packageNames = [
  "@pegma/spine",
  "@pegma/storage-core",
  "@pegma/storage-azure-tables",
  "@pegma/storage-cloudflare-d1",
  "@pegma/audit",
  "@pegma/authorization-contracts",
  "@pegma/authorization-core",
  "@pegma/authorization-policy",
  "@pegma/authorization-storage",
  "@pegma/authorization-tokens",
  "@pegma/authorization-admin",
  "@pegma/authorization-identity",
  "@pegma/identity",
  "@pegma/sessions",
  "@pegma/rate-limit",
  "@pegma/mail",
  "@pegma/webhooks",
  "@pegma/scheduler",
  "@pegma/scheduler-cloudflare",
  "@pegma/storage-blobs",
  "@pegma/support-desk-contracts",
  "@pegma/support-desk-core",
  "@pegma/support-desk-application",
  "@pegma/support-desk-templates",
];
const proposedNames = [
  "@pegma/knowledge-base-contracts",
  "@pegma/knowledge-base-core",
  "@pegma/knowledge-base-application",
  "@pegma/knowledge-base-mcp",
  "@pegma/support-desk-ai",
];

async function readRegistry(name, allowAbsent = false) {
  const response = await fetch(
    new URL(encodeURIComponent(name) + "/latest", registryBase),
    { signal: AbortSignal.timeout(15_000) },
  );
  if (response.status === 404 && allowAbsent) {
    return { name, status: "not-published" };
  }
  if (!response.ok) {
    throw new Error(
      "Registry lookup failed for " + name + ": " + response.status,
    );
  }
  const metadata = await response.json();
  if (
    metadata.name !== name ||
    typeof metadata.version !== "string" ||
    !metadata.dist?.integrity?.startsWith("sha512-") ||
    !/^[a-f0-9]{40}$/.test(metadata.dist?.shasum ?? "")
  ) {
    throw new Error("Incomplete registry metadata for " + name);
  }
  const entry = {
    name,
    version: metadata.version,
    dependencies: metadata.dependencies ?? {},
    integrity: metadata.dist.integrity,
    shasum: metadata.dist.shasum,
    tarball: metadata.dist.tarball,
  };
  return allowAbsent ? { ...entry, status: "already-published" } : entry;
}

// Read the named commit, never label dirty working-tree manifests as that SHA.
const sourcePackages = ["contracts", "core", "application", "templates"].map(
  (directory) => {
    const manifestPath = "packages/" + directory + "/package.json";
    const manifest = JSON.parse(
      execFileSync("git", ["show", sourceRevision + ":" + manifestPath], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }),
    );
    return {
      name: manifest.name,
      version: manifest.version,
      dependencies: manifest.dependencies ?? {},
      manifestPath,
    };
  },
);
const [registry, proposedPackages] = await Promise.all([
  Promise.all(packageNames.map((name) => readRegistry(name))),
  Promise.all(proposedNames.map((name) => readRegistry(name, true))),
]);
const snapshot = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  source: {
    repository: "pegma-dev/support-desk",
    revision: sourceRevision,
    packages: sourcePackages,
  },
  registry,
  proposedPackages,
};
await writeFile(
  new URL("../test/knowledge-ai/baseline.json", import.meta.url),
  JSON.stringify(snapshot, null, 2) + "\n",
);
process.stdout.write(
  "Recorded " +
    registry.length +
    " published packages and " +
    proposedPackages.length +
    " proposed names. Review the snapshot before use.\n",
);
