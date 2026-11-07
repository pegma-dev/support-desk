import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Explicit, read-only network refresh for a reviewed P-00 snapshot.
// Snapshot generation is deliberate handoff work, never a CI command.
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
    (process.argv[2] ?? "origin/main") + "^{commit}",
  ],
  { cwd: repositoryRoot, encoding: "utf8" },
).trim();
try {
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", sourceRevision, "refs/remotes/origin/main"],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
} catch {
  throw new Error(
    "Source must be reachable from fetched origin/main. Fetch origin main before refreshing a public handoff.",
  );
}
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
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(
        new URL(encodeURIComponent(name) + "/latest", registryBase),
        {
          signal: AbortSignal.timeout(15_000),
          headers: { "user-agent": "pegma-support-desk-baseline/1.0" },
        },
      );
      if (
        attempt === 0 &&
        (response.status === 429 || response.status >= 500)
      ) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      break;
    } catch (error) {
      if (attempt === 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
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
    peerDependencies: metadata.peerDependencies ?? {},
    optionalDependencies: metadata.optionalDependencies ?? {},
    engines: metadata.engines ?? {},
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
    if (
      manifest.name !== "@pegma/support-desk-" + directory ||
      typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version)
    ) {
      throw new Error("Invalid source package identity: " + manifestPath);
    }
    return {
      name: manifest.name,
      version: manifest.version,
      dependencies: manifest.dependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
      optionalDependencies: manifest.optionalDependencies ?? {},
      engines: manifest.engines ?? {},
      manifestPath,
    };
  },
);
const names = [...packageNames, ...proposedNames];
const results = await Promise.allSettled([
  ...packageNames.map((name) => readRegistry(name)),
  ...proposedNames.map((name) => readRegistry(name, true)),
]);
const failures = results.flatMap((result, index) =>
  result.status === "rejected"
    ? [names[index] + ": " + String(result.reason)]
    : [],
);
if (failures.length > 0) {
  process.stderr.write(
    "Snapshot not updated; any previous snapshot is unchanged. Registry failures after bounded retry:\n" +
      failures.join("\n") +
      "\n",
  );
  process.exit(1);
}
const entries = results.map((result) => result.value);
const registry = entries.slice(0, packageNames.length);
const proposedPackages = entries.slice(packageNames.length);
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
    " proposed names from source " +
    sourceRevision +
    ". Review the snapshot before use.\n",
);
