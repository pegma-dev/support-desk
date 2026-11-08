import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const CONSUMER_TOOLCHAIN = Object.freeze({
  typescript: "7.0.2",
  "@types/node": "26.6.6",
  "@pegma/storage-core": "0.4.0",
});
export const PREVIOUS_APPLICATION = Object.freeze({
  alias: "@pegma/support-desk-application-previous",
  specifier: "npm:@pegma/support-desk-application@0.1.1",
  name: "@pegma/support-desk-application",
  version: "0.1.1",
});

/** Diagnostic consumer evidence is not one of the immutable six release files. */
export function consumerVerificationPath(output) {
  return `${resolve(output)}-consumer-verification.json`;
}

const consumerRepository = "pegma-dev/support-desk";
const memoryStoreIdentity = Object.freeze({
  package: "@pegma/storage-core",
  version: "0.4.0",
  adapter: "createMemoryStore",
  durable: false,
});
function consumerRuntime() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    v8: process.versions.v8,
  };
}
function digest(bytes, algorithm, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}
function archiveIdentity(archive) {
  assert.ok(
    archive.length > 0 && archive.length <= 32 * 1024 * 1024,
    "consumer archive exceeds its bound",
  );
  const bytes = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
  assert.equal(bytes.length % 512, 0, "invalid consumer archive length");
  let identity;
  for (let offset = 0; offset < bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, end) =>
      header.subarray(start, end).toString("utf8").split("\u0000")[0];
    const sizeText = text(124, 136).trim();
    assert.match(sizeText, /^[0-7]+$/u, "invalid consumer archive size");
    const size = Number.parseInt(sizeText, 8);
    assert.ok(
      Number.isSafeInteger(size) && offset + 512 + size <= bytes.length,
      "invalid consumer archive entry",
    );
    const prefix = text(345, 500);
    const name = `${prefix ? `${prefix}/` : ""}${text(0, 100)}`;
    if (name === "package/package.json") {
      assert.ok(
        identity === undefined &&
          (header[156] === 0 || header[156] === 48) &&
          size <= 1024 * 1024,
        "invalid consumer package manifest",
      );
      identity = JSON.parse(
        bytes.subarray(offset + 512, offset + 512 + size).toString("utf8"),
      );
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(
    identity && typeof identity === "object",
    "consumer archive has no package manifest",
  );
  return identity;
}

/** Hash the bytes actually installed, independently of npm pack's metadata. */
export async function consumerArtifactBindings(records, inventory) {
  assert.equal(records.length, 5, "consumer artifact inventory differs");
  assert.equal(inventory.length, 5, "consumer artifact inventory differs");
  const bindings = [];
  for (const [index, record] of records.entries()) {
    assert.equal(
      record.name,
      inventory[index].name,
      "consumer artifact order differs",
    );
    assert.equal(
      record.directory,
      inventory[index].directory,
      "consumer artifact directory differs",
    );
    assert.ok(
      isAbsolute(record.tarballPath),
      "consumer artifact path must be absolute",
    );
    const bytes = await readFile(record.tarballPath);
    const actual = archiveIdentity(bytes);
    assert.equal(actual.name, record.name, "consumer archive name differs");
    assert.equal(
      actual.version,
      record.version,
      "consumer archive version differs",
    );
    bindings.push({
      name: actual.name,
      version: actual.version,
      tarball: basename(record.tarballPath),
      size: bytes.length,
      sha256: digest(bytes, "sha256"),
      shasum: digest(bytes, "sha1"),
      integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
    });
  }
  return bindings;
}

/** Authenticate a retained sidecar against independently selected source/bytes. */
export async function verifyConsumerReceipt(
  receipt,
  { sourceCommit, records, inventory },
) {
  assert.match(
    sourceCommit,
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u,
    "consumer source commit is required",
  );
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt.synthetic, true);
  assert.equal(receipt.sourceRepository, consumerRepository);
  assert.equal(
    receipt.sourceCommit,
    sourceCommit,
    "consumer receipt source differs",
  );
  assert.equal(receipt.candidateVersion, records[0]?.version);
  assert.deepEqual(
    receipt.artifacts,
    await consumerArtifactBindings(records, inventory),
    "consumer receipt artifacts differ",
  );
  assert.deepEqual(
    receipt.runtime,
    consumerRuntime(),
    "consumer receipt runtime differs",
  );
  assert.deepEqual(
    receipt.store,
    memoryStoreIdentity,
    "consumer receipt Store differs",
  );
  assert.equal(receipt.consumers?.length, 2);
  const base = receipt.consumers[0];
  assert.equal(base.kind, "base-and-forward-migration");
  assert.equal(base.reverseRollbackProven, false);
  assert.equal(base.previousArtifact?.alias, PREVIOUS_APPLICATION.alias);
  assert.equal(base.previousArtifact?.name, PREVIOUS_APPLICATION.name);
  assert.equal(base.previousArtifact?.version, PREVIOUS_APPLICATION.version);
  assert.equal(
    base.previousArtifact?.resolved,
    `https://registry.npmjs.org/@pegma/support-desk-application/-/support-desk-application-${PREVIOUS_APPLICATION.version}.tgz`,
  );
  assert.match(
    base.previousArtifact?.integrity ?? "",
    /^sha512-[A-Za-z0-9+/]{86}==$/u,
  );
  assert.equal(receipt.consumers[1].kind, "optional-ai-public-composition");
  return receipt;
}

/** The packer remains the single owner of the public package inventory. */
export function consumerPlans(records, inventory) {
  assert.equal(
    records.length,
    inventory.length,
    "consumer package inventory differs",
  );
  const version = records[0]?.version;
  assert.match(version ?? "", /^\d+\.\d+\.\d+$/u);
  const dependencies = {};
  for (const [index, definition] of inventory.entries()) {
    const record = records[index];
    assert.equal(
      record.name,
      definition.name,
      "consumer package order differs",
    );
    assert.equal(
      record.directory,
      definition.directory,
      "consumer directory differs",
    );
    assert.equal(
      record.version,
      version,
      "consumer packages must be synchronized",
    );
    assert.equal(
      record.manifest.name,
      record.name,
      "consumer manifest name differs",
    );
    assert.equal(
      record.manifest.version,
      version,
      "consumer manifest version differs",
    );
    assert.ok(
      isAbsolute(record.tarballPath),
      "consumer tarball must be absolute",
    );
    dependencies[record.name] = pathToFileURL(record.tarballPath).href;
  }
  const ai = inventory.find((entry) => entry.directory === "ai");
  assert.ok(ai, "optional AI package is missing");
  assert.equal(
    inventory.length,
    5,
    "the reviewed consumer inventory contains five packages",
  );
  const base = { ...dependencies };
  delete base[ai.name];
  return {
    version,
    base: {
      ...base,
      "@pegma/storage-core": CONSUMER_TOOLCHAIN["@pegma/storage-core"],
      [PREVIOUS_APPLICATION.alias]: PREVIOUS_APPLICATION.specifier,
    },
    ai: { ...dependencies, ...CONSUMER_TOOLCHAIN },
  };
}

/** Real public services, shared real Store; no synthetic legacy rows or codec copy. */
export async function exerciseBaseConsumer(modules, mode = "omitted") {
  assert.ok(mode === "omitted" || mode === "disabled");
  const { application, storage, templates, previousApplication } = modules;
  const store = storage.createMemoryStore();
  const clock = { now: () => "2026-11-08T12:00:00.000Z" };
  const p = application.supportPermissions;
  const customer = {
    principalId: "clean-consumer/customer",
    policyVersion: "synthetic-release",
    roles: [],
    entitlements: [],
    permissions: [p.create, p.readOwn, p.replyOwn, p.assistantStart],
  };
  const staff = {
    principalId: "clean-consumer/staff",
    policyVersion: "synthetic-release",
    roles: [],
    entitlements: [],
    permissions: [p.queueRead, p.replyAny, p.note],
  };
  const prefix = `clean-${mode}`;
  const webId = `${prefix}-web`;
  const emailId = `${prefix}-email`;
  const command = (id, ticketId = webId) => ({
    ticketId,
    commandId: `${prefix}-${id}`,
    correlationId: `${prefix}-${id}`,
  });
  const options = { store, clock };
  const app = application.createSupportDeskApplication({
    ...options,
    ...(mode === "disabled"
      ? {
          assistantHandlingEnabled: false,
          resolutionLearning: { enabled: false },
          engineering: { enabled: false },
          engineeringFollowup: { enabled: false },
        }
      : {}),
  });
  const writerModule = previousApplication ?? application;
  const writer = writerModule.createSupportDeskApplication(options);
  const inboundOptions = {
    ...options,
    accountMatcher: {
      async matchSenderEmail() {
        return { matches: "none" };
      },
    },
    routingPolicy: {
      routeNewConversation() {
        return { priority: "normal" };
      },
    },
  };
  const createdInput = {
    ...command("create"),
    messageId: `${prefix}-web-initial`,
    subject: "Synthetic clean consumer question",
    body: "How can I export the synthetic report?",
  };
  await writer.createCustomerTicket(customer, createdInput);
  await writer.addNote(staff, {
    ...command("old-web-note"),
    messageId: `${prefix}-old-web-note`,
    body: "PRIVATE_LEGACY_WEB_NOTE",
  });
  await writer.replyAsStaff(staff, {
    ...command("old-web-reply"),
    messageId: `${prefix}-old-web-reply`,
    body: "A human reply from the original web writer.",
  });
  const originalWebView = await writer.readCustomerTicket(customer, webId);
  assert.equal(originalWebView.messages.length, 2);
  assert.ok(
    !JSON.stringify(originalWebView).includes("PRIVATE_"),
    "private note leaked to customer DTO",
  );
  assert.ok(
    (await writer.listStaffQueue(staff)).items.some(
      (item) => item.ticketId === webId,
    ),
  );

  // Published 0.1.1 has no inbound processor. Only the candidate creates and
  // threads email; the forward migration below covers actual old web records.
  const inbound = application.createInboundMailProcessor(inboundOptions);
  const emailInput = {
    channelId: "clean-consumer-mailbox",
    providerEventId: `${prefix}-email-event`,
    ticketId: emailId,
    messageId: `${prefix}-email-initial`,
    correlationId: `${prefix}-email-initial`,
    from: "synthetic-sender@example.test",
    subject: "Synthetic email question",
    body: "Please explain the report export.",
    externalMessageId: `<${prefix}-initial@example.test>`,
    senderAuthentication: {
      method: "dmarc",
      result: "pass",
      email: "synthetic-sender@example.test",
      dkimAligned: true,
      spfAligned: false,
    },
  };
  const mailCreated = await inbound.processInboundEmail(emailInput);
  assert.equal(mailCreated.outcome, "created");
  await app.addNote(staff, {
    ...command("email-note", emailId),
    messageId: `${prefix}-email-note`,
    body: "PRIVATE_CANDIDATE_EMAIL_NOTE",
  });

  // Only the candidate reads/mutates the original web writer's rows below.
  assert.equal(
    (await app.readCustomerTicket(customer, webId)).ticket.id,
    webId,
  );
  assert.deepEqual(
    await app.createCustomerTicket(customer, createdInput),
    originalWebView,
  );
  assert.equal(
    (await app.readStaffTicket(staff, webId)).ticket.handling,
    undefined,
  );
  assert.equal(
    (await app.readStaffTicket(staff, emailId)).ticket.channel,
    "email",
  );
  await app.replyToCustomerTicket(customer, {
    ...command("customer-reply"),
    messageId: `${prefix}-customer-reply`,
    body: "I have another synthetic detail.",
  });
  await app.replyAsStaff(staff, {
    ...command("staff-web"),
    messageId: `${prefix}-staff-web`,
    body: "The synthetic report is ready.",
  });
  const replayedMail = await inbound.processInboundEmail({
    ...emailInput,
    ticketId: `${prefix}-ignored-ticket`,
    messageId: `${prefix}-ignored-message`,
  });
  assert.equal(replayedMail.ticketId, emailId);
  assert.equal(replayedMail.duplicateDelivery, true);
  const appendedMail = await inbound.processInboundEmail({
    ...emailInput,
    providerEventId: `${prefix}-followup-event`,
    ticketId: `${prefix}-unused-followup-ticket`,
    messageId: `${prefix}-email-followup`,
    correlationId: `${prefix}-email-followup`,
    externalMessageId: `<${prefix}-followup@example.test>`,
    inReplyTo: emailInput.externalMessageId,
    body: "A synthetic follow-up using the original email thread.",
  });
  assert.equal(appendedMail.outcome, "replied");
  assert.equal(appendedMail.ticketId, emailId);
  await app.replyAsStaff(staff, {
    ...command("staff-email", emailId),
    messageId: `${prefix}-staff-email`,
    body: "A human email response.",
  });
  for (const ticketId of [webId, emailId])
    await app.addNote(staff, {
      ...command(`new-note-${ticketId}`, ticketId),
      messageId: `${prefix}-new-note-${ticketId}`,
      body: "PRIVATE_CANDIDATE_NOTE",
    });
  const customerView = await app.readCustomerTicket(customer, webId);
  assert.equal(customerView.messages.length, 4);
  assert.ok(
    !JSON.stringify(customerView).includes("PRIVATE_"),
    "private note leaked to customer DTO",
  );
  assert.ok(
    !JSON.stringify(await app.listCustomerTickets(customer)).includes(emailId),
    "unverified email became customer-owned",
  );
  await assert.rejects(
    app.readCustomerTicket(customer, emailId),
    (error) => error.name === "SupportDeskNotFoundError",
  );
  const freshId = `${prefix}-fresh-human`;
  await app.createCustomerTicket(customer, {
    ...command("fresh-human", freshId),
    messageId: `${prefix}-fresh-human-initial`,
    subject: "Fresh human support",
    body: "New human support remains available.",
  });
  const queue = await app.listStaffQueue(staff);
  assert.equal(queue.items.length, 3, "unexpected human queue ticket count");
  for (const ticketId of [webId, emailId]) {
    assert.ok(
      queue.items.some((item) => item.ticketId === ticketId),
      "human ticket disappeared from queue",
    );
    const detail = await app.readStaffTicket(staff, ticketId);
    assert.equal(
      detail.messages.filter((message) => message.visibility === "internal")
        .length,
      2,
    );
    assert.equal(detail.ticket.handling, undefined);
    const rows = await store
      .collection(application.supportRecords)
      .list(ticketId);
    assert.ok(
      !rows.some((row) =>
        /^(assistant_|resolution_learning_|engineering_)/u.test(row.kind),
      ),
      "disabled/omitted AI created private derivation work",
    );
  }
  assert.ok(queue.items.some((item) => item.ticketId === freshId));
  assert.equal(
    (await app.readStaffTicket(staff, freshId)).ticket.handling,
    undefined,
  );
  assert.ok(
    !(await store.collection(application.supportRecords).list(freshId)).some(
      (row) =>
        /^(assistant_|resolution_learning_|engineering_)/u.test(row.kind),
    ),
  );
  const deniedId = `${prefix}-denied-assistant`;
  await assert.rejects(
    app.createCustomerTicket(customer, {
      ...command("denied-assistant", deniedId),
      messageId: `${prefix}-denied-initial`,
      subject: "No opt-in",
      body: "Synthetic body",
      initialHandling: "assistant",
    }),
    (error) => error.name === "SupportDeskConflictError",
  );
  assert.deepEqual(
    await store.collection(application.supportRecords).list(deniedId),
    [],
  );
  const template = templates.defineTemplate({
    id: "clean.consumer",
    version: 1,
    variables: ["body"],
    plainText: "{{body}}",
    html: "<p>{{body}}</p>",
  });
  assert.equal(
    templates.renderTemplate(template, { body: "Synthetic response" })
      .plainText,
    "Synthetic response",
  );
  return {
    mode,
    webTicketId: webId,
    emailTicketId: emailId,
    freshTicketId: freshId,
    customerMessages: 4,
    staffNotesPerTicket: 2,
    queueTickets: queue.items.length,
    omittedOrDisabledAi: true,
    noteIsolation: true,
    legacyWriter: previousApplication === undefined ? null : "0.1.1",
    legacyMigrationScope:
      previousApplication === undefined ? null : "web-records-only",
    emailWriter: "candidate",
    forwardOnly: true,
  };
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const name of [
    "NODE_PATH",
    "NODE_OPTIONS",
    "TS_NODE_PROJECT",
    "npm_execpath",
  ])
    delete env[name];
  return env;
}

function runNode(arguments_, directory) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: directory,
    env: cleanEnvironment(),
    encoding: "utf8",
    maxBuffer: 16_777_216,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `isolated consumer failed (${String(result.status)}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  return result.stdout;
}

function inside(root, path) {
  const tail = relative(root, path);
  return (
    tail === "" ||
    (!isAbsolute(tail) &&
      tail !== ".." &&
      !tail.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

/** Reject linked workspace packages and prove the four-package host has no AI/KB tree. */
export async function inspectConsumerInstallation(
  directory,
  records,
  { noAi = false, previous = false } = {},
) {
  const root = await realpath(directory);
  const packageRoots = [join(root, "node_modules")];
  const installed = [];
  while (packageRoots.length > 0) {
    const nodeModules = packageRoots.pop();
    let entries;
    try {
      entries = await readdir(nodeModules, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const candidates = entry.name.startsWith("@")
        ? (await readdir(join(nodeModules, entry.name))).map((name) =>
            join(nodeModules, entry.name, name),
          )
        : [join(nodeModules, entry.name)];
      for (const packageDirectory of candidates) {
        const path = await realpath(packageDirectory);
        assert.ok(
          inside(root, path),
          "consumer dependency resolves outside its isolated directory",
        );
        const manifest = JSON.parse(
          await readFile(join(path, "package.json"), "utf8"),
        );
        installed.push({ name: manifest.name, version: manifest.version });
        assert.ok(
          installed.length <= 2_000,
          "consumer dependency tree exceeded its bound",
        );
        if (noAi)
          assert.ok(
            manifest.name !== "@pegma/support-desk-ai" &&
              !manifest.name.startsWith("@pegma/knowledge-base-"),
            "base consumer installed optional AI/KB",
          );
        packageRoots.push(join(path, "node_modules"));
      }
    }
  }
  for (const record of records) {
    const manifest = JSON.parse(
      await readFile(
        join(root, "node_modules", ...record.name.split("/"), "package.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.name, record.name);
    assert.equal(manifest.version, record.version);
  }
  const installedStore = JSON.parse(
    await readFile(
      join(root, "node_modules", "@pegma", "storage-core", "package.json"),
      "utf8",
    ),
  );
  assert.equal(installedStore.name, memoryStoreIdentity.package);
  assert.equal(installedStore.version, memoryStoreIdentity.version);
  const previousDependencies = [];
  let previousArtifact = null;
  if (previous) {
    const legacyDirectory = join(
      root,
      "node_modules",
      ...PREVIOUS_APPLICATION.alias.split("/"),
    );
    const legacy = JSON.parse(
      await readFile(join(legacyDirectory, "package.json"), "utf8"),
    );
    assert.equal(legacy.name, PREVIOUS_APPLICATION.name);
    assert.equal(
      legacy.version,
      PREVIOUS_APPLICATION.version,
      "migration writer must be the actual published previous version",
    );
    // This is npm's genuine installation lock, not a reconstructed old-package
    // receipt. Keep only public registry identities, never temporary file URLs.
    const lock = JSON.parse(
      await readFile(join(root, "package-lock.json"), "utf8"),
    );
    assert.ok(
      lock.lockfileVersion >= 2,
      "consumer installation lock is required",
    );
    assert.equal(
      lock.packages?.[""]?.dependencies?.[PREVIOUS_APPLICATION.alias],
      PREVIOUS_APPLICATION.specifier,
    );
    const installedLegacy =
      lock.packages?.[`node_modules/${PREVIOUS_APPLICATION.alias}`];
    assert.equal(installedLegacy?.version, PREVIOUS_APPLICATION.version);
    const resolved = `https://registry.npmjs.org/@pegma/support-desk-application/-/support-desk-application-${PREVIOUS_APPLICATION.version}.tgz`;
    assert.equal(
      installedLegacy?.resolved,
      resolved,
      "previous writer must resolve from the official registry",
    );
    assert.match(
      installedLegacy?.integrity ?? "",
      /^sha512-[A-Za-z0-9+/]{86}==$/u,
      "previous writer installation integrity is required",
    );
    previousArtifact = {
      alias: PREVIOUS_APPLICATION.alias,
      name: legacy.name,
      version: legacy.version,
      resolved: installedLegacy.resolved,
      integrity: installedLegacy.integrity,
    };
    const names = [
      "@pegma/support-desk-contracts",
      "@pegma/support-desk-core",
      "@pegma/spine",
      "@pegma/authorization-core",
    ];
    // Eval resolves from the actual alias directory, as its unchanged dist imports
    // do. No override may replace the previous writer's own dependency versions.
    const entries = JSON.parse(
      runNode(
        [
          "--input-type=module",
          "--eval",
          `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map(name=>({name,entry:import.meta.resolve(name)}))));`,
        ],
        legacyDirectory,
      ),
    );
    for (const { name, entry } of entries) {
      const expected = legacy.dependencies?.[name];
      assert.match(
        expected ?? "",
        /^\d+\.\d+\.\d+$/u,
        "previous writer must retain its own exact dependency pin",
      );
      let location = dirname(await realpath(fileURLToPath(entry)));
      let resolved;
      for (let depth = 0; depth < 12 && inside(root, location); depth += 1) {
        try {
          const candidate = JSON.parse(
            await readFile(join(location, "package.json"), "utf8"),
          );
          if (candidate.name === name) {
            resolved = candidate;
            break;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        location = dirname(location);
      }
      assert.equal(
        resolved?.version,
        expected,
        "previous writer resolved a replacement dependency",
      );
      previousDependencies.push({ name, version: resolved.version, expected });
    }
  }
  return {
    packageCount: installed.length,
    optionalAiInstalled: installed.some(
      (entry) => entry.name === "@pegma/support-desk-ai",
    ),
    previousApplication: previous ? PREVIOUS_APPLICATION.version : null,
    previousArtifact,
    previousDependencies,
  };
}

async function temporaryConsumer(label, action) {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(
    join(temporaryRoot, `pegma-release-consumer-${label}-`),
  );
  try {
    return await action(directory);
  } finally {
    // Only our direct, named temporary child can be recursively removed.
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    assert.ok(
      basename(directory).startsWith(`pegma-release-consumer-${label}-`),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyReleaseConsumers({
  root,
  sourceCommit,
  records,
  inventory,
  runNpm,
  exportSpecifiers,
}) {
  assert.match(
    sourceCommit,
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u,
    "consumer source commit is required",
  );
  const plans = consumerPlans(records, inventory);
  const artifacts = await consumerArtifactBindings(records, inventory);
  const reports = [];
  const install = async (directory, dependencies) => {
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ name: "pegma-release-consumer", private: true, type: "module", dependencies }, null, 2)}\n`,
    );
    runNpm(
      [
        "install",
        "--global=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=true",
        "--workspaces=false",
        "--registry=https://registry.npmjs.org/",
      ],
      { cwd: directory, env: cleanEnvironment(), capture: true },
    );
  };
  reports.push(
    await temporaryConsumer("base", async (directory) => {
      const base = records.filter((record) => record.directory !== "ai");
      await install(directory, plans.base);
      const installed = await inspectConsumerInstallation(directory, base, {
        noAi: true,
        previous: true,
      });
      const imports = base.flatMap((record) =>
        exportSpecifiers(record.manifest),
      );
      const source = [
        'import assert from "node:assert/strict";',
        'import * as application from "@pegma/support-desk-application";',
        'import * as storage from "@pegma/storage-core";',
        'import * as templates from "@pegma/support-desk-templates";',
        `import * as previousApplication from ${JSON.stringify(PREVIOUS_APPLICATION.alias)};`,
        ...imports.map(
          (specifier) => `await import(${JSON.stringify(specifier)});`,
        ),
        exerciseBaseConsumer.toString(),
        'const results = []; for (const mode of ["omitted", "disabled"]) results.push(await exerciseBaseConsumer({application,storage,templates,previousApplication},mode));',
        "process.stdout.write(JSON.stringify(results));",
      ].join("\n");
      await writeFile(join(directory, "consumer.mjs"), source);
      const scenarios = JSON.parse(runNode(["consumer.mjs"], directory));
      return {
        kind: "base-and-forward-migration",
        candidateVersion: plans.version,
        previousPublishedVersion: PREVIOUS_APPLICATION.version,
        reverseRollbackProven: false,
        ...installed,
        scenarios,
      };
    }),
  );
  reports.push(
    await temporaryConsumer("ai", async (directory) => {
      await install(directory, plans.ai);
      const installed = await inspectConsumerInstallation(directory, records);
      for (const name of ["composition.ts", "synthetic-ports.ts"])
        await writeFile(
          join(directory, name),
          await readFile(join(root, "examples", "ai", name), "utf8"),
        );
      await writeFile(
        join(directory, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              exactOptionalPropertyTypes: true,
              noUncheckedIndexedAccess: true,
              verbatimModuleSyntax: true,
              skipLibCheck: false,
              noEmitOnError: true,
              types: ["node"],
              rootDir: ".",
              outDir: "dist",
            },
            include: ["composition.ts", "synthetic-ports.ts"],
          },
          null,
          2,
        )}\n`,
      );
      runNode(
        [
          join(directory, "node_modules", "typescript", "bin", "tsc"),
          "-p",
          "tsconfig.json",
          "--pretty",
          "false",
        ],
        directory,
      );
      const source = [
        'import assert from "node:assert/strict";',
        'import {createMemoryStore} from "@pegma/storage-core";',
        'import {runSyntheticAiExample} from "./dist/composition.js";',
        ...records
          .flatMap((record) => exportSpecifiers(record.manifest))
          .map((specifier) => `await import(${JSON.stringify(specifier)});`),
        "const result = await runSyntheticAiExample({store:createMemoryStore()});",
        "assert.ok(result.answer.assistantMessageCount >= 1); assert.equal(result.answer.humanTakeover,true);",
        'assert.equal(result.learning.draftState,"draft"); assert.equal(result.learning.excludedFromRetrieval,true); assert.ok(result.learning.sourceReferenceCount >= 1);',
        'assert.equal(result.engineering.operation,"link_existing_issue"); assert.equal(result.engineering.accepted,true);',
        "assert.equal(result.followup.delivered,true); assert.equal(result.followup.kbProposalPrepared,true); assert.ok(result.followup.retestRequestCount >= 1);",
        "assert.equal(result.followup.customerNoticeCount,1); assert.equal(result.followup.postReplaySameMessage,true); assert.equal(result.followup.ticketStatusAfter,result.followup.ticketStatusBefore);",
        "assert.equal(result.safety.privateNotesExcluded,true); assert.equal(result.safety.noWorkerNotice,true);",
        'for(const purpose of ["answer","learning","engineering","followup"]) assert.equal(result.calls[purpose],1); assert.equal(result.calls.setupPublications,1);',
        'for(const effect of ["githubCreate","providerNetwork","mailSend","agentPublications"]) assert.equal(result.calls[effect],0);',
        // Retain opaque evidence only, not fictional provider captures or bodies.
        "const evidence={answer:{ticketId:result.answer.ticketId,assistantMessageCount:result.answer.assistantMessageCount,humanTakeover:result.answer.humanTakeover,citationCount:result.answer.citationArticleIds.length},learning:result.learning,engineering:result.engineering,followup:result.followup,safety:{privateNotesExcluded:result.safety.privateNotesExcluded,noWorkerNotice:result.safety.noWorkerNotice},calls:result.calls};",
        "process.stdout.write(JSON.stringify(evidence));",
      ].join("\n");
      await writeFile(join(directory, "consumer.mjs"), source);
      const result = JSON.parse(runNode(["consumer.mjs"], directory));
      return {
        kind: "optional-ai-public-composition",
        candidateVersion: plans.version,
        publicTypesChecked: true,
        toolchain: CONSUMER_TOOLCHAIN,
        ...installed,
        result,
      };
    }),
  );
  for (const report of reports)
    process.stdout.write(
      `Verified isolated ${report.kind} consumer (${plans.version}).\n`,
    );
  const receipt = {
    schemaVersion: 1,
    synthetic: true,
    sourceRepository: consumerRepository,
    sourceCommit,
    candidateVersion: plans.version,
    artifacts,
    runtime: consumerRuntime(),
    store: memoryStoreIdentity,
    consumers: reports,
  };
  // Re-read after every consumer: no receipt may bless archives changed while
  // the isolated installations and runtime checks were executing.
  return verifyConsumerReceipt(receipt, { sourceCommit, records, inventory });
}
