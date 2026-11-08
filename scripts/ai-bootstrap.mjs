import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { inspectReleaseTarball } from "./release-verification.mjs";

export const AI_BOOTSTRAP_IDENTITY = Object.freeze({
  repository: "pegma-dev/support-desk",
  tag: "v0.1.1-ai-bootstrap",
  sourceCommit: "eddd3526f8bec3a1a80cc7aacd3a4cdcdb950cfe",
  packageName: "@pegma/support-desk-ai",
  version: "0.1.1",
  workflow: ".github/workflows/prepare-ai-bootstrap.yml",
});
export const AI_BOOTSTRAP_MANIFEST_FILENAME = "bootstrap-manifest.json";
export const AI_BOOTSTRAP_WARNING =
  "Registration bootstrap only; no OIDC provenance and NOT host usable. Registry @pegma/support-desk-application@0.1.1 lacks the reviewed source exports. Public tag-rule checks do not verify a hidden bypass policy. The release owner must independently verify the full current bypass policy before tag creation/dispatch and again before manual publication. Wait for the separately verified synchronized trusted release.";
const registry = "https://registry.npmjs.org/";
const repositoryUrl = "https://github.com/pegma-dev/support-desk.git";
const maximumArchiveBytes = 256 * 1024 * 1024;
const maximumTarballBytes = 64 * 1024 * 1024;
const inventory = Object.freeze([
  ["contracts", "@pegma/support-desk-contracts"],
  ["core", "@pegma/support-desk-core"],
  ["templates", "@pegma/support-desk-templates"],
  ["application", "@pegma/support-desk-application"],
  ["ai", "@pegma/support-desk-ai"],
]);
const aiDependencies = Object.freeze({
  "@pegma/authorization-core": "0.4.0",
  "@pegma/knowledge-base-application": "0.1.2",
  "@pegma/knowledge-base-contracts": "0.1.2",
  "@pegma/spine": "0.1.2",
  "@pegma/support-desk-application": "0.1.1",
});

function fail(message) {
  throw new Error(message);
}
function hash(bytes, algorithm = "sha256") {
  return createHash(algorithm).update(bytes).digest("hex");
}
function equal(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function same(left, right) {
  return canonical(left) === canonical(right);
}
function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`Invalid ${name}`);
  return value;
}
function keys(value, required, optional = []) {
  object(value, "bootstrap object");
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    fail("Unexpected bootstrap manifest fields");
}
function scalar(value, name, maximum = 400) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail(`Invalid ${name}`);
  return value;
}
function digest(value, name = "digest") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    fail(`Invalid ${name}`);
  return value;
}
function commit(value, name = "commit") {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    fail(`Invalid ${name}`);
  return value;
}
function safeRelative(value) {
  scalar(value, "artifact path", 240);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/")
  )
    fail("Unsafe bootstrap artifact path");
  return value;
}
function folded(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
function inside(root, path) {
  const child = relative(root, path);
  return (
    child === "" ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
  );
}
async function directory(path) {
  const full = resolve(scalar(path, "directory", 4096));
  const info = await lstat(full);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    folded(await realpath(full)) !== folded(full)
  )
    fail("Bootstrap directories must not traverse symbolic links");
  return full;
}
async function file(root, path, maximum = maximumTarballBytes) {
  const full = resolve(root, safeRelative(path));
  if (!inside(root, full))
    fail("Bootstrap file escaped its prepared directory");
  const info = await lstat(full);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > maximum ||
    folded(await realpath(full)) !== folded(full)
  )
    fail("Invalid or linked bootstrap artifact");
  const bytes = await readFile(full);
  if (bytes.length !== info.size)
    fail("Bootstrap artifact changed while reading");
  return bytes;
}
function json(bytes, name) {
  try {
    return object(JSON.parse(bytes.toString("utf8")), name);
  } catch {
    fail(`Invalid ${name}`);
  }
}
function defaultRun(command, args, options) {
  const env = { ...process.env };
  delete env.RELEASE_TAG;
  delete env.RELEASE_COMMIT;
  delete env.RELEASE_PRERELEASE;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    shell: false,
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) fail("Bootstrap command could not start");
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
function execute(run, command, args, cwd) {
  const result = run(command, args, { cwd });
  if (result.status !== 0)
    fail("Bootstrap source inspection or preparation failed");
  if (
    typeof result.stdout !== "string" ||
    result.stdout.length > 16 * 1024 * 1024
  )
    fail("Bootstrap command output exceeds its bound");
  return result.stdout.trim();
}
async function responseBytes(response, maximum) {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > maximum)
  )
    fail("Bootstrap response exceeds its byte bound");
  if (response.body === null) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) fail("Bootstrap response exceeds its byte bound");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
async function request(url, fetch) {
  try {
    return await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json" },
    });
  } catch {
    fail("Bootstrap registry or protection lookup is uncertain");
  }
}
async function verifyPublicTagRules(fetch) {
  const response = await request(
    "https://api.github.com/repos/pegma-dev/support-desk/rulesets/20011989",
    fetch,
  );
  if (response.status !== 200)
    fail("Release tag protection could not be confirmed");
  const policy = json(
    await responseBytes(response, 128 * 1024),
    "tag protection response",
  );
  const includes = policy.conditions?.ref_name?.include;
  // Anonymous responses may omit bypass_actors. Omission is unknown, never an
  // assertion that the full immutable-tag policy was verified. The owner must
  // separately read the complete current policy outside this unprivileged job.
  if (
    policy.target !== "tag" ||
    policy.enforcement !== "active" ||
    !same(includes, ["refs/tags/v*"]) ||
    !same(policy.conditions?.ref_name?.exclude, []) ||
    !Array.isArray(policy.rules) ||
    ["creation", "update", "deletion", "non_fast_forward"].some(
      (type) => !policy.rules.some((rule) => rule.type === type),
    ) ||
    (Object.hasOwn(policy, "bypass_actors") &&
      !same(policy.bypass_actors, [
        { actor_id: 2440101, actor_type: "User", bypass_mode: "always" },
      ]))
  )
    fail(
      "Public bootstrap tag rules differ from the reviewed visible requirements",
    );
}
function validatePackage(value, directoryName, name) {
  if (
    value.name !== name ||
    value.version !== AI_BOOTSTRAP_IDENTITY.version ||
    value.private === true ||
    value.repository?.url !==
      "git+https://github.com/pegma-dev/support-desk.git" ||
    value.repository?.directory !== `packages/${directoryName}`
  )
    fail("Bootstrap package is not the frozen reviewed source candidate");
  if (
    name === AI_BOOTSTRAP_IDENTITY.packageName &&
    !same(value.dependencies, aiDependencies)
  )
    fail("Bootstrap AI dependency pins differ from reviewed source");
}
export async function validateAiBootstrapSource(options, seams = {}) {
  const env = seams.env ?? process.env;
  if (
    [
      "NODE_AUTH_TOKEN",
      "NPM_TOKEN",
      "NPM_AUTH_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_URL",
    ].some((key) => Object.hasOwn(env, key))
  )
    fail("Bootstrap preparation must not receive npm tokens or OIDC authority");
  const sourceRoot = await directory(options.sourceRoot);
  const toolRoot = await directory(
    options.toolRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  if (inside(sourceRoot, toolRoot) || inside(toolRoot, sourceRoot))
    fail("Bootstrap source and tool checkouts must be separate");
  const run = seams.run ?? defaultRun;
  const git = (root, ...args) => execute(run, "git", args, root);
  for (const root of [toolRoot, sourceRoot]) {
    if (
      ![
        repositoryUrl,
        repositoryUrl.slice(0, -4),
        "git@github.com:pegma-dev/support-desk.git",
      ].includes(git(root, "remote", "get-url", "origin"))
    )
      fail("Bootstrap checkout has the wrong origin");
    if (git(root, "status", "--porcelain") !== "")
      fail("Bootstrap preparation requires clean checkouts");
    git(
      root,
      "merge-base",
      "--is-ancestor",
      "HEAD",
      "refs/remotes/origin/main",
    );
  }
  const sourceCommit = git(sourceRoot, "rev-parse", "HEAD");
  const toolCommit = commit(git(toolRoot, "rev-parse", "HEAD"), "tool commit");
  const tagRef = `refs/tags/${AI_BOOTSTRAP_IDENTITY.tag}`;
  if (
    sourceCommit !== AI_BOOTSTRAP_IDENTITY.sourceCommit ||
    git(sourceRoot, "cat-file", "-t", tagRef) !== "tag" ||
    git(sourceRoot, "rev-parse", `${tagRef}^{commit}`) !== sourceCommit
  )
    fail("Bootstrap must use the exact reviewed annotated source tag");
  const tagObject = commit(git(sourceRoot, "rev-parse", tagRef), "tag object");
  git(sourceRoot, "verify-tag", "--raw", tagRef);
  if (
    git(sourceRoot, "ls-remote", "--refs", "origin", tagRef) !==
    `${tagObject}\t${tagRef}`
  )
    fail("Bootstrap tag differs from its immutable remote identity");
  await verifyPublicTagRules(seams.fetch ?? globalThis.fetch);
  let workflowCommit = toolCommit;
  if (env.GITHUB_ACTIONS === "true") {
    if (
      env.GITHUB_REPOSITORY !== AI_BOOTSTRAP_IDENTITY.repository ||
      env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_SHA !== toolCommit ||
      env.GITHUB_WORKFLOW_REF !==
        `${AI_BOOTSTRAP_IDENTITY.repository}/${AI_BOOTSTRAP_IDENTITY.workflow}@refs/heads/main` ||
      env.GITHUB_WORKFLOW_SHA !== toolCommit
    )
      fail(
        "Bootstrap preparation must use the reviewed main workflow and tools",
      );
    workflowCommit = env.GITHUB_WORKFLOW_SHA;
  }
  for (const [directoryName, name] of inventory)
    validatePackage(
      json(
        await file(
          sourceRoot,
          `packages/${directoryName}/package.json`,
          128 * 1024,
        ),
        "source package manifest",
      ),
      directoryName,
      name,
    );
  return {
    repository: AI_BOOTSTRAP_IDENTITY.repository,
    tag: AI_BOOTSTRAP_IDENTITY.tag,
    sourceCommit,
    tagObject,
    toolCommit,
    workflowCommit,
    workflow: AI_BOOTSTRAP_IDENTITY.workflow,
  };
}
function validateIdentity(identity, expectedToolCommit) {
  keys(identity, [
    "repository",
    "tag",
    "sourceCommit",
    "tagObject",
    "toolCommit",
    "workflowCommit",
    "workflow",
  ]);
  for (const key of ["repository", "tag", "sourceCommit", "workflow"])
    if (identity[key] !== AI_BOOTSTRAP_IDENTITY[key])
      fail("Bootstrap identity differs from its approved source");
  commit(identity.tagObject, "tag object");
  commit(identity.toolCommit, "tool commit");
  if (
    identity.toolCommit !==
      commit(expectedToolCommit, "expected tool commit") ||
    identity.workflowCommit !== identity.toolCommit
  )
    fail(
      "Bootstrap tool/workflow identity differs from the independent binding",
    );
}
function validateHashes(record, bytes) {
  if (
    typeof record.shasum !== "string" ||
    !/^[a-f0-9]{40}$/u.test(record.shasum) ||
    !equal(hash(bytes, "sha1"), record.shasum) ||
    !equal(
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      record.integrity,
    )
  )
    fail("Bootstrap tarball hashes do not match its independent manifest");
}
async function verifyContext(root, expectedDigest) {
  const bytes = await file(
    root,
    "context/package-manifest.json",
    2 * 1024 * 1024,
  );
  if (!equal(hash(bytes), digest(expectedDigest)))
    fail("Bootstrap full-context manifest digest mismatch");
  const context = json(bytes, "full-context manifest");
  keys(context, ["schemaVersion", "gitCommit", "releaseTag", "packages"]);
  if (
    context.schemaVersion !== 1 ||
    context.gitCommit !== AI_BOOTSTRAP_IDENTITY.sourceCommit ||
    context.releaseTag !== null ||
    !Array.isArray(context.packages) ||
    context.packages.length !== inventory.length
  )
    fail("Invalid five-candidate bootstrap context");
  let ai;
  for (const [index, entry] of context.packages.entries()) {
    keys(entry, [
      "name",
      "version",
      "directory",
      "tarball",
      "integrity",
      "shasum",
      "publish",
      "files",
    ]);
    const [directoryName, name] = inventory[index];
    const filename = `${name.slice(1).replace("/", "-")}-0.1.1.tgz`;
    if (
      entry.name !== name ||
      entry.directory !== directoryName ||
      entry.version !== "0.1.1" ||
      entry.tarball !== filename ||
      entry.publish !== true
    )
      fail(
        "Bootstrap context inventory or version differs from the reviewed set",
      );
    const tarball = await file(root, `context/${filename}`);
    validateHashes(entry, tarball);
    const inspected = inspectReleaseTarball(tarball);
    validatePackage(inspected.packageJson, directoryName, name);
    if (!same(inspected.files, entry.files))
      fail("Bootstrap context tarball file inventory differs from preparation");
    if (directoryName === "ai") ai = { entry, tarball, inspected };
  }
  return ai;
}
export async function prepareAiBootstrap(options, seams = {}) {
  const identity = await validateAiBootstrapSource(options, seams);
  const sourceRoot = await directory(options.sourceRoot);
  const toolRoot = await directory(
    options.toolRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const output = resolve(scalar(options.output, "output directory", 4096));
  if (inside(sourceRoot, output) || inside(toolRoot, output))
    fail("Bootstrap output must be outside both clean checkouts");
  await mkdir(output, { recursive: true });
  await directory(output);
  if ((await readdir(output)).length !== 0)
    fail("Bootstrap output directory must be empty");
  execute(
    seams.run ?? defaultRun,
    process.execPath,
    [
      join(sourceRoot, "scripts/release-packages.mjs"),
      "pack",
      "--root",
      sourceRoot,
      "--require-clean",
      "--require-main-ancestor",
      "--output",
      join(output, "context"),
    ],
    sourceRoot,
  );
  if (!same(await validateAiBootstrapSource(options, seams), identity))
    fail("Bootstrap source changed during preparation");
  const contextBytes = await file(
    output,
    "context/package-manifest.json",
    2 * 1024 * 1024,
  );
  const contextDigest = hash(contextBytes);
  const ai = await verifyContext(output, contextDigest);
  const filename = "pegma-support-desk-ai-0.1.1.tgz";
  await copyFile(join(output, "context", filename), join(output, filename));
  const manifest = {
    schemaVersion: 1,
    purpose: "npm-name-registration-only",
    hostUsable: false,
    oidcProvenance: false,
    identity,
    context: {
      manifest: "context/package-manifest.json",
      manifestSha256: contextDigest,
      candidateCount: 5,
      importedLocally: true,
    },
    artifact: {
      name: AI_BOOTSTRAP_IDENTITY.packageName,
      version: "0.1.1",
      filename,
      size: ai.tarball.length,
      shasum: ai.entry.shasum,
      integrity: ai.entry.integrity,
      dependencies: ai.inspected.packageJson.dependencies,
      files: ai.inspected.files,
    },
    warning: AI_BOOTSTRAP_WARNING,
  };
  const manifestPath = join(output, AI_BOOTSTRAP_MANIFEST_FILENAME);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes, { flag: "wx" });
  return verifyAiBootstrapPrepared({
    preparedDirectory: output,
    manifestSha256: hash(manifestBytes),
    expectedToolCommit: identity.toolCommit,
  });
}
export async function verifyAiBootstrapPrepared(options) {
  const root = await directory(options.preparedDirectory);
  const bytes = await file(
    root,
    AI_BOOTSTRAP_MANIFEST_FILENAME,
    2 * 1024 * 1024,
  );
  if (
    !equal(
      hash(bytes),
      digest(options.manifestSha256, "independent manifest digest"),
    )
  )
    fail("Bootstrap manifest differs from the independent digest");
  const manifest = json(bytes, "bootstrap manifest");
  keys(manifest, [
    "schemaVersion",
    "purpose",
    "hostUsable",
    "oidcProvenance",
    "identity",
    "context",
    "artifact",
    "warning",
  ]);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.purpose !== "npm-name-registration-only" ||
    manifest.hostUsable !== false ||
    manifest.oidcProvenance !== false ||
    manifest.warning !== AI_BOOTSTRAP_WARNING
  )
    fail("Bootstrap publication purpose is invalid");
  validateIdentity(manifest.identity, options.expectedToolCommit);
  keys(manifest.context, [
    "manifest",
    "manifestSha256",
    "candidateCount",
    "importedLocally",
  ]);
  if (
    manifest.context.manifest !== "context/package-manifest.json" ||
    manifest.context.candidateCount !== 5 ||
    manifest.context.importedLocally !== true
  )
    fail("Bootstrap source-context binding is invalid");
  const ai = await verifyContext(root, manifest.context.manifestSha256);
  const artifact = manifest.artifact;
  keys(artifact, [
    "name",
    "version",
    "filename",
    "size",
    "shasum",
    "integrity",
    "dependencies",
    "files",
  ]);
  if (
    artifact.name !== AI_BOOTSTRAP_IDENTITY.packageName ||
    artifact.version !== "0.1.1" ||
    artifact.filename !== "pegma-support-desk-ai-0.1.1.tgz" ||
    !same(artifact.dependencies, aiDependencies) ||
    !same(artifact.files, ai.inspected.files) ||
    artifact.size !== ai.tarball.length ||
    artifact.shasum !== ai.entry.shasum ||
    artifact.integrity !== ai.entry.integrity
  )
    fail("Only the approved AI registration tarball may be handed off");
  const selected = await file(root, artifact.filename);
  validateHashes(artifact, selected);
  if (!selected.equals(ai.tarball))
    fail("Selected AI bootstrap differs from its five-candidate context");
  const entries = (await readdir(root)).sort();
  if (
    !same(
      entries,
      [AI_BOOTSTRAP_MANIFEST_FILENAME, "context", artifact.filename].sort(),
    )
  )
    fail("Unexpected files in the bootstrap handoff directory");
  const expectedContext = [
    "package-manifest.json",
    ...inventory.map(
      ([, name]) => `${name.slice(1).replace("/", "-")}-0.1.1.tgz`,
    ),
  ].sort();
  if (!same((await readdir(join(root, "context"))).sort(), expectedContext))
    fail("Unexpected files in the five-candidate context");
  return {
    preparedDirectory: root,
    manifestPath: join(root, AI_BOOTSTRAP_MANIFEST_FILENAME),
    manifestSha256: hash(bytes),
    manifest,
  };
}
function zipEntries(bytes) {
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65557);
    offset--
  ) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (
    end < 0 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0
  )
    fail("Invalid bootstrap artifact ZIP");
  const count = bytes.readUInt16LE(end + 10),
    start = bytes.readUInt32LE(end + 16),
    size = bytes.readUInt32LE(end + 12);
  if (
    count === 0 ||
    count > 32 ||
    bytes.readUInt16LE(end + 8) !== count ||
    start + size !== end
  )
    fail("Unsupported bootstrap artifact ZIP inventory");
  const entries = new Map();
  let offset = start,
    total = 0;
  const ranges = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      fail("Invalid bootstrap ZIP directory");
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10),
      compressed = bytes.readUInt32LE(offset + 20),
      length = bytes.readUInt32LE(offset + 24),
      nameSize = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      commentSize = bytes.readUInt16LE(offset + 32),
      local = bytes.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameSize;
    const next = nameEnd + extra + commentSize;
    if (
      next > end ||
      local + 30 > start ||
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      length > maximumTarballBytes
    )
      fail("Unsupported bootstrap ZIP entry");
    const nameBytes = bytes.subarray(offset + 46, nameEnd);
    const name = nameBytes.toString("utf8");
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    if (name.endsWith("/")) {
      if (name !== "context/" || length !== 0 || (mode & 0o170000) === 0o120000)
        fail("Unexpected bootstrap ZIP directory");
    } else {
      safeRelative(name);
      if (
        entries.has(name) ||
        ((mode & 0o170000) !== 0 && (mode & 0o170000) !== 0o100000)
      )
        fail("Duplicate or linked bootstrap ZIP entry");
      if (
        bytes.readUInt32LE(local) !== 0x04034b50 ||
        bytes.readUInt16LE(local + 8) !== method ||
        bytes.readUInt16LE(local + 6) !== flags
      )
        fail("Bootstrap ZIP local header differs from its directory");
      const localNameSize = bytes.readUInt16LE(local + 26),
        localExtra = bytes.readUInt16LE(local + 28),
        data = local + 30 + localNameSize + localExtra;
      if (
        data + compressed > start ||
        !bytes
          .subarray(local + 30, local + 30 + localNameSize)
          .equals(nameBytes)
      )
        fail("Bootstrap ZIP path or extent mismatch");
      if (ranges.some(([a, b]) => local < b && data + compressed > a))
        fail("Overlapping bootstrap ZIP entries");
      ranges.push([local, data + compressed]);
      const packed = bytes.subarray(data, data + compressed);
      let unpacked;
      try {
        unpacked =
          method === 0
            ? packed
            : inflateRawSync(packed, { maxOutputLength: maximumTarballBytes });
      } catch {
        fail("Invalid bootstrap ZIP compression");
      }
      if (unpacked.length !== length)
        fail("Bootstrap ZIP size differs from its directory");
      total += unpacked.length;
      if (total > maximumArchiveBytes)
        fail("Bootstrap ZIP exceeds its total byte bound");
      entries.set(name, unpacked);
    }
    offset = next;
  }
  if (offset !== end) fail("Trailing bootstrap ZIP directory data");
  return entries;
}
async function verifyArchive(prepared, options) {
  const archive = resolve(
    scalar(options.artifactArchive, "artifact archive", 4096),
  );
  const bytes = await file(
    await directory(dirname(archive)),
    basename(archive),
    maximumArchiveBytes,
  );
  if (
    !equal(
      hash(bytes),
      digest(options.artifactSha256, "independent uploaded artifact digest"),
    )
  )
    fail(
      "Downloaded bootstrap artifact differs from the independently recorded upload digest",
    );
  const entries = zipEntries(bytes);
  const expected = [
    AI_BOOTSTRAP_MANIFEST_FILENAME,
    prepared.manifest.artifact.filename,
    "context/package-manifest.json",
    ...inventory.map(
      ([, name]) => `context/${name.slice(1).replace("/", "-")}-0.1.1.tgz`,
    ),
  ];
  if (!same([...entries.keys()].sort(), expected.sort()))
    fail(
      "Downloaded bootstrap artifact has an unexpected publication inventory",
    );
  for (const name of expected)
    if (!entries.get(name).equals(await file(prepared.preparedDirectory, name)))
      fail(
        "Extracted bootstrap handoff differs from the digest-bound downloaded artifact",
      );
}
function distTags(value) {
  const tags = object(value, "registry dist-tags");
  if (Object.keys(tags).length > 32)
    fail("Registry dist-tags exceed their bound");
  for (const [name, version] of Object.entries(tags)) {
    scalar(name, "dist-tag", 100);
    scalar(version, "dist-tag version", 200);
  }
  return tags;
}
async function registryReceipt(options, seams, requirePresent) {
  const prepared = await verifyAiBootstrapPrepared(options);
  await verifyArchive(prepared, options);
  const { artifact } = prepared.manifest;
  const fetch = seams.fetch ?? globalThis.fetch;
  const base = `${registry}${encodeURIComponent(artifact.name)}`;
  const response = await request(`${base}/${artifact.version}`, fetch);
  let metadata;
  if (response.status === 404) await response.body?.cancel();
  else if (response.status === 200)
    metadata = json(
      await responseBytes(response, 2 * 1024 * 1024),
      "bootstrap registry metadata",
    );
  else fail("Bootstrap version availability is uncertain");
  const packumentResponse = await request(base, fetch);
  let tags = {};
  if (packumentResponse.status === 200) {
    const packument = json(
      await responseBytes(packumentResponse, 2 * 1024 * 1024),
      "bootstrap package metadata",
    );
    if (packument.name !== artifact.name)
      fail("Bootstrap package metadata has the wrong name");
    tags = distTags(packument["dist-tags"]);
  } else if (packumentResponse.status === 404 && metadata === undefined)
    await packumentResponse.body?.cancel();
  else fail("Bootstrap name or dist-tag availability is uncertain");
  if (metadata === undefined && packumentResponse.status !== 404)
    fail(
      "The package name exists without the approved registration bootstrap; manual creation is unnecessary",
    );
  if (metadata !== undefined) {
    const expectedTarball = `${registry}@pegma/support-desk-ai/-/support-desk-ai-0.1.1.tgz`;
    if (
      metadata.name !== artifact.name ||
      metadata.version !== artifact.version ||
      !same(metadata.dependencies, aiDependencies) ||
      metadata.dist?.tarball !== expectedTarball ||
      !equal(metadata.dist?.integrity, artifact.integrity) ||
      !equal(metadata.dist?.shasum, artifact.shasum) ||
      [
        "optionalDependencies",
        "peerDependencies",
        "bundledDependencies",
        "bundleDependencies",
      ].some((key) => metadata[key] !== undefined) ||
      metadata.dist?.attestations?.provenance !== undefined
    )
      fail(
        "Registry bootstrap metadata conflicts with its reviewed manual artifact",
      );
    const downloaded = await request(expectedTarball, fetch);
    if (downloaded.status !== 200)
      fail("Bootstrap registry tarball could not be verified");
    const bytes = await responseBytes(downloaded, artifact.size);
    if (bytes.length !== artifact.size)
      fail("Bootstrap registry tarball size mismatch");
    validateHashes(artifact, bytes);
    const inspected = inspectReleaseTarball(bytes);
    validatePackage(inspected.packageJson, "ai", artifact.name);
    if (!same(inspected.files, artifact.files))
      fail("Registry bootstrap file inventory mismatch");
  } else if (requirePresent)
    fail(
      "Bootstrap acceptance remains unknown; postflight requires the exact visible registry bytes",
    );
  return {
    identity: prepared.manifest.identity,
    manifestSha256: prepared.manifestSha256,
    contextManifestSha256: prepared.manifest.context.manifestSha256,
    artifactSha256: options.artifactSha256,
    name: artifact.name,
    version: artifact.version,
    action: metadata === undefined ? "publish" : "skip",
    distTags: tags,
    oidcProvenance: false,
    hostUsable: false,
    maintainerCommand: `npm publish PREPARED_DIRECTORY/${artifact.filename} --access public --ignore-scripts --registry ${registry.slice(0, -1)} --tag bootstrap`,
    warning: AI_BOOTSTRAP_WARNING,
  };
}
export async function preflightAiBootstrap(options, seams = {}) {
  return registryReceipt(options, seams, false);
}
export async function postflightAiBootstrap(options, seams = {}) {
  return registryReceipt(options, seams, true);
}
export function parseAiBootstrapArguments(args) {
  const [command, ...rest] = args;
  if (
    !["verify-source", "prepare", "preflight", "postflight"].includes(command)
  )
    fail(
      "Usage: ai-bootstrap.mjs verify-source|prepare|preflight|postflight [options]; no publish command exists",
    );
  const names = {
    "--source-root": "sourceRoot",
    "--tool-root": "toolRoot",
    "--output": "output",
    "--prepared-dir": "preparedDirectory",
    "--manifest-sha256": "manifestSha256",
    "--expected-tool-commit": "expectedToolCommit",
    "--artifact-archive": "artifactArchive",
    "--artifact-sha256": "artifactSha256",
  };
  const allowed =
    command === "verify-source"
      ? ["sourceRoot", "toolRoot"]
      : command === "prepare"
        ? ["sourceRoot", "toolRoot", "output"]
        : [
            "preparedDirectory",
            "manifestSha256",
            "expectedToolCommit",
            "artifactArchive",
            "artifactSha256",
          ];
  const required =
    command === "verify-source"
      ? ["sourceRoot"]
      : command === "prepare"
        ? ["sourceRoot", "output"]
        : allowed;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = names[rest[index]],
      value = rest[index + 1];
    if (
      key === undefined ||
      !allowed.includes(key) ||
      Object.hasOwn(options, key) ||
      value === undefined ||
      value.startsWith("--")
    )
      fail("Unknown, duplicate or incomplete bootstrap argument");
    options[key] = scalar(value, "bootstrap argument", 4096);
  }
  if (required.some((key) => options[key] === undefined))
    fail("Missing required independent bootstrap binding");
  return { command, options };
}
async function main() {
  const { command, options } = parseAiBootstrapArguments(process.argv.slice(2));
  const result =
    command === "verify-source"
      ? await validateAiBootstrapSource(options)
      : command === "prepare"
        ? await prepareAiBootstrap(options)
        : command === "preflight"
          ? await preflightAiBootstrap(options)
          : await postflightAiBootstrap(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
