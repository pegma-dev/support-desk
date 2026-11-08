// Release verification runs without project dependencies or package lifecycle scripts.
import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  RELEASE_PACKAGES,
  verifyPreparedManifest,
} from "./release-packages.mjs";

export const RELEASE_REPOSITORY = "pegma-dev/support-desk";
export const RELEASE_WORKFLOW = ".github/workflows/publish.yml";
export const RELEASE_ENVIRONMENT = "npm-publish";
export const RELEASE_NPM_VERSION = "11.18.0";
const registry = "https://registry.npmjs.org/";
const provenanceType = "https://slsa.dev/provenance/v1";
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const fullCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const temporaryPrefix = "pegma-support-release-";
const maximumTarball = 32 * 1024 * 1024;
const maximumArchive = 128 * 1024 * 1024;
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function fail(message) {
  // Native, registry, environment and package contents can contain credentials.
  throw new Error(`Release verification: ${message}`);
}
function hash(bytes, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}
function equal(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    Buffer.byteLength(left) === Buffer.byteLength(right) &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, keys) {
  return (
    object(value) &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n")
  );
}
function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function sameDependencies(left, right) {
  return (
    object(left) &&
    object(right) &&
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([name, version]) => right[name] === version)
  );
}

async function boundedFile(path, directory, maximum) {
  const resolved = resolve(path);
  const before = await lstat(resolved);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maximum ||
    (await realpath(resolved)) !== resolved ||
    dirname(resolved) !== directory
  ) {
    fail("prepared artifact must contain bounded regular files only");
  }
  const file = await open(
    resolved,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const current = await file.stat();
    if (
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size
    ) {
      fail("prepared artifact changed while being read");
    }
    const bytes = Buffer.alloc(current.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (
      offset !== current.size ||
      after.size !== current.size ||
      after.mtimeMs !== current.mtimeMs
    ) {
      fail("prepared artifact changed while being read");
    }
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}
function tarNumber(bytes) {
  const value = tarString(bytes).trim();
  if (!/^[0-7]+$/u.test(value)) fail("unsupported release archive header");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail("unsupported release archive header");
  return number;
}

// Shared with the separate registration-only bootstrap; no archive is extracted
// or executed. npm's reviewed packages use regular ustar files and directories.
export function inspectReleaseTarball(input) {
  try {
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength === 0 ||
      input.byteLength > maximumTarball
    ) {
      fail("release archive exceeds its bound");
    }
    const bytes = gunzipSync(input, { maxOutputLength: maximumArchive });
    if (bytes.length % 512 !== 0) fail("invalid release archive length");
    const files = [];
    const seen = new Set();
    let packageJson;
    let ended = false;
    for (let offset = 0; offset < bytes.length;) {
      const header = bytes.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) {
        if (!bytes.subarray(offset).every((byte) => byte === 0))
          fail("release archive has trailing data");
        ended = true;
        break;
      }
      let checksum = 0;
      for (let index = 0; index < 512; index += 1)
        checksum += index >= 148 && index < 156 ? 32 : header[index];
      if (
        checksum !== tarNumber(header.subarray(148, 156)) ||
        tarString(header.subarray(257, 263)) !== "ustar"
      ) {
        fail("invalid release archive header");
      }
      const prefix = tarString(header.subarray(345, 500));
      const name = `${prefix ? `${prefix}/` : ""}${tarString(header.subarray(0, 100))}`;
      const size = tarNumber(header.subarray(124, 136));
      const kind = header[156];
      if (
        size > maximumArchive ||
        offset + 512 + size > bytes.length ||
        !name.startsWith("package/") ||
        /[\\\u0000-\u001f\u007f]/u.test(name) ||
        name.split("/").some((part) => part === "." || part === "..") ||
        (kind !== 0 && kind !== 48 && kind !== 53)
      ) {
        fail("release archive contains an unsupported entry");
      }
      const path = name.slice(8).replace(/\/$/u, "");
      if (kind === 53) {
        if (size !== 0) fail("invalid release archive directory");
      } else {
        if (
          !path ||
          seen.has(path) ||
          files.length >= 10000 ||
          !(
            path === "package.json" ||
            /^README(?:\.[A-Za-z]+)?$/u.test(path) ||
            /^LICENSE(?:\.[A-Za-z]+)?$/u.test(path) ||
            path.startsWith("dist/")
          )
        ) {
          fail("release archive contains an unexpected file");
        }
        seen.add(path);
        files.push({ path, size });
        if (path === "package.json") {
          if (size > 1024 * 1024)
            fail("release package manifest exceeds its bound");
          packageJson = JSON.parse(
            bytes.subarray(offset + 512, offset + 512 + size).toString("utf8"),
          );
        }
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (
      !ended ||
      !object(packageJson) ||
      !seen.has("README.md") ||
      !seen.has("LICENSE") ||
      !seen.has("dist/index.js")
    ) {
      fail("release archive is missing required package files");
    }
    return {
      packageJson,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    };
  } catch {
    fail("invalid or unsupported release tarball");
  }
}

function packageExports(packageJson, files) {
  if (!object(packageJson.exports))
    fail("release package has no explicit public exports");
  const exports = [];
  for (const [key, value] of Object.entries(packageJson.exports)) {
    if (
      !/^(?:\.|\.\/[a-z0-9-]+)$/u.test(key) ||
      !object(value) ||
      typeof value.import !== "string" ||
      !value.import.startsWith("./dist/") ||
      !files.some((file) => `./${file.path}` === value.import)
    ) {
      fail("release package has unsupported public exports");
    }
    exports.push(
      key === "." ? packageJson.name : `${packageJson.name}/${key.slice(2)}`,
    );
  }
  if (exports.length === 0)
    fail("release package has no public runtime export");
  return exports;
}

export async function verifyPreparedRelease(options = {}) {
  try {
    if (
      typeof options.manifest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(options.manifestSha256 ?? "") ||
      typeof options.releaseTag !== "string" ||
      !options.releaseTag.startsWith("v") ||
      !stable.test(options.releaseTag.slice(1)) ||
      !fullCommit.test(options.expectedReleaseCommit ?? "")
    ) {
      fail(
        "an independent manifest digest and exact stable source identity are required",
      );
    }
    const manifestPath = resolve(options.manifest);
    const directory = dirname(manifestPath);
    const directoryStat = await lstat(directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    ) {
      fail("prepared artifact directory must be canonical");
    }
    const bytes = await boundedFile(manifestPath, directory, 4 * 1024 * 1024);
    if (!equal(hash(bytes), options.manifestSha256))
      fail("independent prepared manifest digest does not match");
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (
      !exactKeys(manifest, [
        "schemaVersion",
        "gitCommit",
        "releaseTag",
        "packages",
      ]) ||
      manifest.schemaVersion !== 1 ||
      manifest.gitCommit !== options.expectedReleaseCommit ||
      manifest.releaseTag !== options.releaseTag ||
      !Array.isArray(manifest.packages) ||
      manifest.packages.length !== RELEASE_PACKAGES.length
    ) {
      fail("prepared release identity does not match the selected source");
    }
    // Preserve the packer's inventory/current-checkout/hash checks, then independently
    // read each original archive against the separately pinned manifest bytes.
    const checked = await verifyPreparedManifest(manifestPath);
    if (
      JSON.stringify(checked) !== JSON.stringify(manifest) ||
      !equal(
        hash(await boundedFile(manifestPath, directory, 4 * 1024 * 1024)),
        options.manifestSha256,
      )
    ) {
      fail("prepared manifest changed during verification");
    }
    const version = options.releaseTag.slice(1);
    const packages = [];
    for (const definition of RELEASE_PACKAGES) {
      const matches = manifest.packages.filter(
        (record) => record?.name === definition.name,
      );
      if (matches.length !== 1)
        fail("prepared package inventory does not match");
      const record = matches[0];
      if (
        !exactKeys(record, [
          "name",
          "version",
          "directory",
          "tarball",
          "integrity",
          "shasum",
          "publish",
          "files",
        ]) ||
        record.directory !== definition.directory ||
        record.version !== version ||
        record.publish !== true ||
        record.tarball !==
          `${record.name.slice(1).replaceAll("/", "-")}-${version}.tgz` ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(record.integrity) ||
        !/^[0-9a-f]{40}$/u.test(record.shasum) ||
        !Array.isArray(record.files) ||
        record.files.length > 10000
      ) {
        fail(
          "prepared release must contain the exact synchronized five-package set",
        );
      }
      const archive = await boundedFile(
        join(directory, record.tarball),
        directory,
        maximumTarball,
      );
      if (
        !equal(hash(archive, "sha1"), record.shasum) ||
        !equal(`sha512-${hash(archive, "sha512", "base64")}`, record.integrity)
      ) {
        fail("original prepared tarball hash does not match");
      }
      const inspected = inspectReleaseTarball(archive);
      if (
        JSON.stringify(
          [...record.files].sort((a, b) => a.path.localeCompare(b.path)),
        ) !== JSON.stringify(inspected.files) ||
        inspected.packageJson.name !== record.name ||
        inspected.packageJson.version !== version
      ) {
        fail("original tarball inventory or package identity does not match");
      }
      const packageJson = inspected.packageJson;
      const dependencies = packageJson.dependencies ?? {};
      if (
        !object(dependencies) ||
        Object.entries(dependencies).some(
          ([name, selected]) =>
            typeof selected !== "string" ||
            !stable.test(selected) ||
            (RELEASE_PACKAGES.some((entry) => entry.name === name) &&
              selected !== version),
        ) ||
        [
          "optionalDependencies",
          "peerDependencies",
          "bundledDependencies",
          "bundleDependencies",
        ].some((key) => packageJson[key] !== undefined)
      ) {
        fail("release dependencies must be exact stable pins");
      }
      const sourceDirectory = resolve(
        sourceRoot,
        "packages",
        definition.directory,
      );
      const source = JSON.parse(
        (
          await boundedFile(
            join(sourceDirectory, "package.json"),
            sourceDirectory,
            1024 * 1024,
          )
        ).toString("utf8"),
      );
      if (
        source.name !== record.name ||
        source.version !== version ||
        !sameDependencies(dependencies, source.dependencies ?? {}) ||
        JSON.stringify(packageJson.exports) !== JSON.stringify(source.exports)
      ) {
        fail(
          "original package dependencies or exports differ from the reviewed source",
        );
      }
      packages.push({
        ...record,
        size: archive.length,
        dependencies,
        exports: packageExports(packageJson, inspected.files),
      });
    }
    const expectedFiles = [
      basename(manifestPath),
      ...packages.map((record) => record.tarball),
    ].sort();
    if (
      JSON.stringify((await readdir(directory)).sort()) !==
      JSON.stringify(expectedFiles)
    ) {
      fail(
        "prepared artifact must contain only the original manifest and five tarballs",
      );
    }
    return freeze({
      identity: {
        repository: RELEASE_REPOSITORY,
        workflow: RELEASE_WORKFLOW,
        environment: RELEASE_ENVIRONMENT,
        tag: options.releaseTag,
        commit: options.expectedReleaseCommit,
        version,
      },
      manifestPath,
      manifestSha256: options.manifestSha256,
      packages,
    });
  } catch {
    fail(
      "original prepared release failed digest, source, inventory or archive verification",
    );
  }
}

function tarballUrl(record) {
  return `${registry}${record.name}/-/${record.name.split("/").at(-1)}-${record.version}.tgz`;
}
async function responseBytes(response, maximum) {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > maximum)
  )
    fail("registry response exceeds its bound");
  if (!response.body) fail("registry response has no body");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > maximum) fail("registry response exceeds its bound");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
async function request(url, fetch_) {
  try {
    return await fetch_(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { accept: "application/json" },
    });
  } catch {
    fail("official registry request failed");
  }
}
async function registryRecord(record, fetch_) {
  const response = await request(
    `${registry}${encodeURIComponent(record.name)}/${record.version}`,
    fetch_,
  );
  if (response.status === 404) return null;
  if (response.status !== 200)
    fail("official registry metadata request failed");
  let metadata;
  try {
    metadata = JSON.parse(
      (await responseBytes(response, 2 * 1024 * 1024)).toString("utf8"),
    );
  } catch {
    fail("official registry metadata is invalid");
  }
  if (
    metadata.name !== record.name ||
    metadata.version !== record.version ||
    !sameDependencies(metadata.dependencies ?? {}, record.dependencies) ||
    [
      "optionalDependencies",
      "peerDependencies",
      "bundledDependencies",
      "bundleDependencies",
    ].some((key) => metadata[key] !== undefined) ||
    !equal(metadata.dist?.integrity, record.integrity) ||
    !equal(metadata.dist?.shasum, record.shasum) ||
    metadata.dist?.tarball !== tarballUrl(record)
  ) {
    fail("registry version differs from the original prepared package");
  }
  if (
    !Array.isArray(metadata.dist.signatures) ||
    metadata.dist.signatures.length === 0 ||
    metadata.dist.signatures.length > 16 ||
    metadata.dist.signatures.some(
      (signature) =>
        !object(signature) ||
        typeof signature.keyid !== "string" ||
        signature.keyid.length === 0 ||
        signature.keyid.length > 256 ||
        typeof signature.sig !== "string" ||
        signature.sig.length === 0 ||
        signature.sig.length > 4096,
    )
  ) {
    fail("registry package is missing its ECDSA signature");
  }
  const tarball = await request(tarballUrl(record), fetch_);
  // Metadata and tarball visibility can propagate separately. Missing bytes never
  // mean safe-to-publish: callers either retry visibility or stop the preflight.
  if (tarball.status === 404) return { unavailable: true };
  if (tarball.status !== 200) fail("official registry tarball request failed");
  const bytes = await responseBytes(tarball, record.size);
  if (
    bytes.length !== record.size ||
    !equal(hash(bytes, "sha1"), record.shasum) ||
    !equal(`sha512-${hash(bytes, "sha512", "base64")}`, record.integrity)
  ) {
    fail("registry tarball bytes differ from the original prepared package");
  }
  return { unavailable: false };
}

export async function preflightRegistry(verified, ports = {}) {
  const decisions = [];
  for (const record of verified.packages) {
    const current = await registryRecord(
      record,
      ports.fetch ?? globalThis.fetch,
    );
    if (current?.unavailable)
      fail(
        "registry version exists but its exact tarball is not yet available",
      );
    decisions.push({
      name: record.name,
      version: record.version,
      action: current === null ? "publish" : "skip",
    });
  }
  return decisions;
}

export function assertTrustedPublishingEnvironment(env, identity) {
  let oidc;
  try {
    oidc = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  } catch {
    fail("trusted GitHub release OIDC context is required");
  }
  if (
    identity.repository !== RELEASE_REPOSITORY ||
    identity.workflow !== RELEASE_WORKFLOW ||
    identity.environment !== RELEASE_ENVIRONMENT ||
    !stable.test(identity.version) ||
    identity.tag !== `v${identity.version}` ||
    !fullCommit.test(identity.commit) ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "release" ||
    env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY ||
    env.GITHUB_SERVER_URL !== "https://github.com" ||
    env.GITHUB_REF !== `refs/tags/${identity.tag}` ||
    env.GITHUB_SHA !== identity.commit ||
    env.GITHUB_WORKFLOW_SHA !== identity.commit ||
    env.GITHUB_WORKFLOW_REF !==
      `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@refs/tags/${identity.tag}` ||
    env.RELEASE_ENVIRONMENT !== RELEASE_ENVIRONMENT ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    oidc.protocol !== "https:" ||
    !oidc.hostname.endsWith(".actions.githubusercontent.com") ||
    oidc.port ||
    oidc.username ||
    oidc.password ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
    [
      "NODE_AUTH_TOKEN",
      "NPM_TOKEN",
      "NPM_AUTH_TOKEN",
      "NPM_AUTH",
      "YARN_NPM_AUTH_TOKEN",
    ].some((key) => Boolean(env[key])) ||
    Object.entries(env).some(
      ([key, value]) => /^npm_config_/iu.test(key) && Boolean(value),
    )
  ) {
    fail(
      "publishing requires the exact protected release workflow/environment and token-free OIDC",
    );
  }
}

function nativeRun(binary, args, options) {
  const result = spawnSync(binary, args, {
    ...options,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
async function temporary(action) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, temporaryPrefix));
  try {
    return await action(directory);
  } finally {
    const target = await realpath(directory);
    if (
      dirname(target) !== parent ||
      !basename(target).startsWith(temporaryPrefix)
    )
      fail("consumer cleanup refused an unexpected directory");
    await rm(target, { recursive: true, force: true });
  }
}
async function npmContext(options, ports, directory, publishing) {
  const cli = options.npmCli ?? process.env.RELEASE_NPM_CLI;
  const version =
    options.npmVersion ??
    process.env.RELEASE_NPM_VERSION ??
    RELEASE_NPM_VERSION;
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (
    major < 22 ||
    (major === 22 && minor < 14) ||
    typeof cli !== "string" ||
    !isAbsolute(cli) ||
    basename(cli) !== "npm-cli.js" ||
    version !== RELEASE_NPM_VERSION
  ) {
    fail("release verification requires Node 22.14+ and the reviewed npm CLI");
  }
  const resolvedCli = resolve(cli);
  const metadata = await lstat(resolvedCli);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (await realpath(resolvedCli)) !== resolvedCli
  )
    fail("reviewed npm CLI must be a regular canonical file");
  const clean = {};
  const publishingKeys = new Set([
    "GITHUB_ACTIONS",
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER_ID",
    "GITHUB_SERVER_URL",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "RUNNER_ENVIRONMENT",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA)$/iu.test(
        key,
      ) ||
      (publishing && publishingKeys.has(key))
    )
      clean[key] = value;
  }
  const env = {
    ...clean,
    CI: "true",
    npm_config_userconfig: join(directory, "user.npmrc"),
    npm_config_globalconfig: join(directory, "global.npmrc"),
    npm_config_cache: join(directory, "cache"),
    npm_config_registry: registry,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  await writeFile(env.npm_config_userconfig, "", { flag: "wx" });
  await writeFile(env.npm_config_globalconfig, "", { flag: "wx" });
  await writeFile(join(directory, ".npmrc"), `registry=${registry}\n`, {
    flag: "wx",
  });
  const run = ports.run ?? nativeRun;
  const invoke = async (args) => {
    let result;
    try {
      result = await run(process.execPath, [resolvedCli, ...args], {
        cwd: directory,
        env,
      });
    } catch {
      fail("reviewed npm command failed");
    }
    if (result?.status !== 0 || typeof result.stdout !== "string")
      fail("reviewed npm command failed");
    return result.stdout;
  };
  if ((await invoke(["--version"])).trim() !== RELEASE_NPM_VERSION)
    fail("reviewed npm CLI version does not match");
  return { invoke, run, env };
}

function derValue(bytes, start) {
  const tag = bytes[start];
  const initialLength = bytes[start + 1];
  if (initialLength === undefined) fail("invalid provenance certificate");
  let offset = start + 2;
  let length = initialLength;
  if (initialLength > 127) {
    const count = initialLength & 127;
    if (count < 1 || count > 4 || offset + count > bytes.length)
      fail("invalid provenance certificate");
    length = 0;
    for (let index = 0; index < count; index += 1)
      length = length * 256 + bytes[offset++];
  }
  if (offset + length > bytes.length) fail("invalid provenance certificate");
  return {
    tag,
    value: bytes.subarray(offset, offset + length),
    end: offset + length,
  };
}
function certificateIssuer(certificate) {
  // Fulcio extension 1.3.6.1.4.1.57264.1.1 authenticates the OIDC issuer.
  const outer = derValue(certificate.raw, 0);
  const tbs = derValue(outer.value, 0);
  if (outer.tag !== 0x30 || tbs.tag !== 0x30)
    fail("invalid provenance certificate");
  let extensions;
  for (let offset = 0; offset < tbs.value.length;) {
    const field = derValue(tbs.value, offset);
    if (field.tag === 0xa3) extensions = derValue(field.value, 0);
    offset = field.end;
  }
  if (extensions?.tag !== 0x30) fail("invalid provenance certificate");
  let issuer;
  for (let offset = 0; offset < extensions.value.length;) {
    const extension = derValue(extensions.value, offset);
    const oid = derValue(extension.value, 0);
    let value = derValue(extension.value, oid.end);
    if (value.tag === 0x01) value = derValue(extension.value, value.end);
    if (extension.tag !== 0x30 || oid.tag !== 0x06 || value.tag !== 0x04)
      fail("invalid provenance certificate");
    if (oid.value.toString("hex") === "2b0601040183bf300101") {
      if (issuer !== undefined) fail("invalid provenance certificate");
      issuer = value.value.toString("utf8");
    }
    offset = extension.end;
  }
  return issuer;
}
function verifyCertificateIdentity(bundle, identity) {
  try {
    const material = bundle.verificationMaterial;
    const encoded =
      material.certificate?.rawBytes ??
      material.x509CertificateChain?.certificates?.[0]?.rawBytes;
    if (typeof encoded !== "string" || encoded.length > 64 * 1024)
      fail("invalid provenance certificate");
    const certificate = new X509Certificate(Buffer.from(encoded, "base64"));
    if (
      certificate.subjectAltName !==
        `URI:https://github.com/${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@refs/tags/${identity.tag}` ||
      certificateIssuer(certificate) !==
        "https://token.actions.githubusercontent.com"
    ) {
      fail("invalid provenance certificate");
    }
  } catch {
    fail(
      "verified provenance signer does not match the approved release workflow",
    );
  }
}

// npm's pinned audit verifies registry signatures and Sigstore/TUF cryptography.
// This adds policy checks over those authenticated bundles before importing code.
// https://docs.npmjs.com/generating-provenance-statements/#verifying-provenance-attestations
// Pinned schema: npm/cli v11.18.0 workspaces/libnpmpublish/lib/provenance.js.
// Pinned crypto/audit: npm/cli v11.18.0 lib/utils/verify-signatures.js.
// npm SLSA v1 does not attest the GitHub environment name: npm-publish is bound
// by the exact immutable workflow source and its guarded privileged job instead.
export function verifyProvenanceAudit(audit, verified) {
  if (
    !Array.isArray(audit?.invalid) ||
    audit.invalid.length !== 0 ||
    !Array.isArray(audit.missing) ||
    audit.missing.length !== 0 ||
    !Array.isArray(audit.verified)
  ) {
    fail("registry signatures or provenance verification failed");
  }
  const identity = verified.identity;
  for (const record of verified.packages) {
    const matches = audit.verified.filter(
      (entry) =>
        entry.name === record.name &&
        entry.version === record.version &&
        entry.location === `node_modules/${record.name}` &&
        entry.registry === registry,
    );
    if (matches.length !== 1 || !Array.isArray(matches[0].attestationBundles))
      fail("release package is missing verified source provenance");
    const bundles = matches[0].attestationBundles.filter(
      (entry) => entry.predicateType === provenanceType,
    );
    if (bundles.length !== 1)
      fail("release package is missing verified source provenance");
    verifyCertificateIdentity(bundles[0].bundle, identity);
    let statement;
    try {
      const envelope = bundles[0].bundle.dsseEnvelope;
      if (
        envelope.payloadType !== "application/vnd.in-toto+json" ||
        typeof envelope.payload !== "string" ||
        envelope.payload.length > 1024 * 1024
      )
        fail("invalid provenance statement");
      statement = JSON.parse(
        Buffer.from(envelope.payload, "base64").toString("utf8"),
      );
    } catch {
      fail("invalid verified provenance statement");
    }
    const definition = statement.predicate?.buildDefinition;
    const workflow = definition?.externalParameters?.workflow;
    const dependencies = definition?.resolvedDependencies;
    if (
      statement._type !== "https://in-toto.io/Statement/v1" ||
      statement.predicateType !== provenanceType ||
      !Array.isArray(statement.subject) ||
      statement.subject.length !== 1 ||
      statement.subject[0].name !==
        `pkg:npm/${record.name.split("/").map(encodeURIComponent).join("/")}@${record.version}` ||
      !equal(
        statement.subject[0].digest?.sha512,
        Buffer.from(record.integrity.slice(7), "base64").toString("hex"),
      ) ||
      definition?.buildType !==
        "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1" ||
      workflow?.repository !== `https://github.com/${RELEASE_REPOSITORY}` ||
      workflow.path !== RELEASE_WORKFLOW ||
      workflow.ref !== `refs/tags/${identity.tag}` ||
      definition.internalParameters?.github?.event_name !== "release" ||
      !Array.isArray(dependencies) ||
      dependencies.length !== 1 ||
      dependencies[0].uri !==
        `git+https://github.com/${RELEASE_REPOSITORY}@refs/tags/${identity.tag}` ||
      !equal(dependencies[0].digest?.gitCommit, identity.commit) ||
      statement.predicate?.runDetails?.builder?.id !==
        "https://github.com/actions/runner/github-hosted"
    ) {
      fail(
        "verified release provenance does not match the original source identity",
      );
    }
  }
}

async function registryConsumer(verified, options, ports) {
  return temporary(async (directory) => {
    const { invoke, run, env } = await npmContext(
      options,
      ports,
      directory,
      false,
    );
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ name: "support-desk-registry-proof", private: true, type: "module", dependencies: Object.fromEntries(verified.packages.map((record) => [record.name, record.version])) })}\n`,
      { flag: "wx" },
    );
    await invoke([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry",
      registry,
    ]);
    let lock;
    try {
      lock = JSON.parse(
        await readFile(join(directory, "package-lock.json"), "utf8"),
      );
    } catch {
      fail("registry consumer lock is missing or invalid");
    }
    for (const record of verified.packages) {
      const installed = lock.packages?.[`node_modules/${record.name}`];
      if (
        installed?.version !== record.version ||
        installed.link === true ||
        !equal(installed.integrity, record.integrity) ||
        installed.resolved !== tarballUrl(record) ||
        !sameDependencies(installed.dependencies ?? {}, record.dependencies)
      ) {
        fail(
          "fresh registry consumer did not install the original exact release",
        );
      }
    }
    let audit;
    try {
      audit = JSON.parse(
        await invoke([
          "audit",
          "signatures",
          "--json",
          "--include-attestations",
          "--registry",
          registry,
        ]),
      );
    } catch {
      fail("registry signatures or provenance verification failed");
    }
    verifyProvenanceAudit(audit, verified);
    const consumer = join(directory, "consumer.mjs");
    await writeFile(
      consumer,
      `${verified.packages.flatMap((record) => record.exports.map((specifier) => `await import(${JSON.stringify(specifier)});`)).join("\n")}\n`,
      { flag: "wx" },
    );
    const imported = await run(process.execPath, [consumer], {
      cwd: directory,
      env,
    });
    if (imported?.status !== 0)
      fail("fresh registry consumer public imports failed");
  });
}
async function confirmRegistry(record, ports) {
  const sleep =
    ports.sleep ??
    ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  // Bound total visibility waiting to 255 seconds per package, including the
  // independently propagating metadata and exact tarball endpoints.
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const current = await registryRecord(
      record,
      ports.fetch ?? globalThis.fetch,
    );
    if (current !== null && !current.unavailable) return;
    if (attempt < 8) await sleep(2 ** attempt * 1000);
  }
  fail("original registry package was not visible after bounded verification");
}
export async function verifyRegistryRelease(options = {}, ports = {}) {
  const verified = await verifyPreparedRelease(options);
  for (const record of verified.packages) await confirmRegistry(record, ports);
  await registryConsumer(verified, options, ports);
  return {
    verified: true,
    identity: verified.identity,
    manifestSha256: verified.manifestSha256,
    packages: verified.packages.map((record) => record.name),
  };
}
export async function publishRegistryRelease(options = {}, ports = {}) {
  const verified = await verifyPreparedRelease(options);
  assertTrustedPublishingEnvironment(process.env, verified.identity);
  // Preflight the whole set before any irreversible publication. Existing
  // metadata without verified exact bytes blocks a recovery rather than repacks.
  const decisions = await preflightRegistry(verified, ports);
  const published = [];
  const skipped = [];
  await temporary(async (directory) => {
    const { invoke } = await npmContext(options, ports, directory, true);
    for (const record of verified.packages) {
      if (
        decisions.find((entry) => entry.name === record.name).action === "skip"
      ) {
        skipped.push(record.name);
        continue;
      }
      const bytes = await boundedFile(
        join(dirname(verified.manifestPath), record.tarball),
        dirname(verified.manifestPath),
        maximumTarball,
      );
      if (
        !equal(hash(bytes, "sha1"), record.shasum) ||
        !equal(`sha512-${hash(bytes, "sha512", "base64")}`, record.integrity)
      )
        fail("original prepared archive changed before upload");
      const upload = join(directory, record.tarball);
      await writeFile(upload, bytes, { flag: "wx" });
      await invoke([
        "publish",
        upload,
        "--access",
        "public",
        "--provenance",
        "--ignore-scripts",
        "--registry",
        registry,
      ]);
      await confirmRegistry(record, ports);
      published.push(record.name);
    }
  });
  return { published, skipped, manifestSha256: verified.manifestSha256 };
}

async function main(args) {
  const [command, ...remaining] = args;
  const names = new Map([
    ["--manifest", "manifest"],
    ["--manifest-sha256", "manifestSha256"],
    ["--release-tag", "releaseTag"],
    ["--expected-release-commit", "expectedReleaseCommit"],
    ["--npm-cli", "npmCli"],
    ["--npm-version", "npmVersion"],
  ]);
  const options = {};
  for (let index = 0; index < remaining.length; index += 2) {
    const key = names.get(remaining[index]);
    if (
      !key ||
      options[key] !== undefined ||
      typeof remaining[index + 1] !== "string" ||
      remaining[index + 1].startsWith("--")
    )
      fail("unsupported or missing release argument");
    options[key] = remaining[index + 1];
  }
  let result;
  if (command === "preflight")
    result = await preflightRegistry(await verifyPreparedRelease(options));
  else if (command === "verify") result = await verifyRegistryRelease(options);
  else if (command === "publish")
    result = await publishRegistryRelease(options);
  else fail("expected preflight, publish or verify command");
  console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Release verification failed; retain the original artifact and inspect the failed gate before retrying unchanged-tag jobs.",
    );
    process.exitCode = 1;
  });
}
