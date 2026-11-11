import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import type { Clock } from "@pegma/spine";
import { MAX_SCAN_PAGE_SIZE, type CollectionStore } from "@pegma/storage-core";
import type { Ticket } from "@pegma/support-desk-contracts";
import { effectiveTicketHandling } from "@pegma/support-desk-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  supportPermissions,
  type AssistantConversationView,
  type AssistantEscalationCommand,
  type AssistantReplyCommand,
  type HandlingCommandResult,
  type SupportDeskLimits,
  type SupportRecord,
} from "./index.js";
import type {
  AssistantTurnApplication,
  AssistantTurnClaim,
  AssistantTurnClaimFence,
  AssistantTurnCommitGuard,
  AssistantTurnFinishResult,
  CompleteAssistantTurnCommand,
  FinishAssistantTurnAttemptCommand,
} from "./assistant-turn-types.js";
import {
  assertAssistantTurnRecord,
  assistantTurnProcessingState,
  assistantTurnKey,
  canonical,
  dataArray,
  encodedBytes,
  fields,
  fingerprint,
  integer,
  maximumRecordBytes,
  preparedRecordBytes,
  snapshot,
  terminalTurn,
  text,
  timestamp,
  validateBinding,
  validateFence,
  validateProcessing,
  withoutAssistantTurnLease as withoutLease,
  type AssistantTurnRecord,
  type ResolvedAssistantTurnOptions,
} from "./assistant-turn-records.js";
import { maximumPostPreparationRecordBytes } from "./assistant-turn-capacity.js";

/** Private, closed integration with the existing handling transaction executor. */
export type AssistantTurnCommit =
  | {
      readonly kind: "complete";
      readonly command: CompleteAssistantTurnCommand;
      readonly fingerprint: string;
      readonly guard: AssistantTurnCommitGuard;
    }
  | {
      readonly kind: "finish";
      readonly command: FinishAssistantTurnAttemptCommand;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "exhausted";
      readonly ticketId: string;
      readonly turnId: string;
      readonly claimGeneration: number;
      readonly fingerprint: string;
    };

interface AssistantTurnDependencies {
  readonly records: CollectionStore<SupportRecord>;
  readonly clock: Clock;
  readonly options: ResolvedAssistantTurnOptions | undefined;
  readonly assistantHandlingEnabled: boolean;
  readonly limits: SupportDeskLimits;
  readonly maxConflictAttempts: number;
  conversation(
    ticket: Ticket,
    rows: readonly SupportRecord[],
  ): AssistantConversationView;
  mutateHandling(
    access: AccessContext,
    command: AssistantReplyCommand | AssistantEscalationCommand,
    operation: "assistant_reply" | "assistant_escalate",
    commit: AssistantTurnCommit,
  ): Promise<Ticket>;
}

function permission(access: AccessContext, name: string): void {
  text(access.principalId, "principalId");
  if (!hasPermission(access, name))
    throw new SupportDeskAuthorizationError(name);
}

function workerPermission(access: AccessContext): void {
  permission(access, supportPermissions.assistantRead);
  permission(access, supportPermissions.assistantReply);
  permission(access, supportPermissions.assistantEscalate);
}

function latestCustomerTrigger(
  ticket: Ticket,
  rows: readonly SupportRecord[],
  job: AssistantTurnRecord,
): boolean {
  if (ticket.requester.association === "authenticated")
    text(ticket.requester.principalId, "requester principalId");
  const handling = effectiveTicketHandling(ticket);
  const visible = rows.filter(
    (row) => row.kind === "message" && row.message.visibility === "customer",
  );
  let latest: (typeof visible)[number] | undefined;
  const ordinals = new Set<number>();
  for (const row of visible) {
    if (row.kind !== "message") continue;
    integer(row.ordinal, "message ordinal", 1);
    if (ordinals.has(row.ordinal))
      throw new SupportDeskConflictError("Conversation ordinals are ambiguous");
    ordinals.add(row.ordinal);
    if (
      latest === undefined ||
      (latest.kind === "message" && row.ordinal > latest.ordinal)
    )
      latest = row;
  }
  return (
    ticket.id === job.ticketId &&
    ticket.requester.association === "authenticated" &&
    ticket.status !== "resolved" &&
    ticket.status !== "closed" &&
    handling.state === "assistant" &&
    handling.generation === job.triggerHandlingGeneration &&
    latest?.kind === "message" &&
    latest.message.id === job.triggerMessageId &&
    latest.ordinal === job.triggerRevision &&
    latest.partition === ticket.id &&
    latest.id === `message:${job.triggerMessageId}` &&
    latest.message.ticketId === ticket.id &&
    job.triggerRevision <= ticket.revision &&
    latest.message.authorKind === "customer" &&
    latest.message.channel === "web" &&
    latest.message.authorPrincipalId === ticket.requester.principalId
  );
}

function sameClaim(
  job: AssistantTurnRecord,
  command: AssistantTurnClaimFence,
): boolean {
  return (
    job.status === "claimed" &&
    job.claim !== undefined &&
    canonical(job.claim) ===
      canonical(
        Object.fromEntries(
          Object.keys(job.claim).map((key) => [
            key,
            (command as unknown as Record<string, unknown>)[key],
          ]),
        ),
      )
  );
}

function ack(ticket: Ticket, messageId?: string): HandlingCommandResult {
  return {
    ticketId: ticket.id,
    revision: ticket.revision,
    handlingGeneration: effectiveTicketHandling(ticket).generation,
    ...(messageId === undefined ? {} : { messageId }),
  };
}

function validateReason(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== "string" ||
      ![
        "no_guidance",
        "unsuccessful",
        "capacity",
        "provider_failure",
        "other",
      ].includes(value))
  )
    throw new TypeError("Invalid assistant escalation reason");
}

function validateSummary(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || value.length > 2_000)
  )
    throw new TypeError("Assistant handoff summary must be bounded text");
}

export function createAssistantTurnServices(
  dependencies: AssistantTurnDependencies,
): AssistantTurnApplication & {
  completionAction(
    ticket: Ticket,
    rows: readonly SupportRecord[],
    updated: Ticket,
    commit: AssistantTurnCommit,
  ): Promise<{
    action: Parameters<CollectionStore<SupportRecord>["transact"]>[1][number];
    verifyBeforeCommit(): Promise<void>;
  }>;
} {
  const { records, clock, options, limits, maxConflictAttempts } = dependencies;

  function enabled(): ResolvedAssistantTurnOptions {
    if (options === undefined)
      throw new SupportDeskConflictError(
        "Durable assistant turns are not configured",
      );
    return options;
  }

  function now(): number {
    return timestamp(clock.now(), "clock.now()");
  }

  function activeClaim(
    job: AssistantTurnRecord,
    command: AssistantTurnClaimFence,
    exactTicket?: Ticket,
  ): void {
    if (
      !sameClaim(job, command) ||
      job.leaseUntil === undefined ||
      timestamp(job.leaseUntil, "leaseUntil") <= now()
    )
      throw new SupportDeskConflictError(
        "Assistant turn claim was lost or expired",
      );
    if (
      exactTicket !== undefined &&
      (exactTicket.revision !== command.expectedRevision ||
        effectiveTicketHandling(exactTicket).generation !==
          command.expectedHandlingGeneration)
    )
      throw new SupportDeskConflictError("Assistant turn ticket fence changed");
  }

  async function load(key: { ticketId: string; turnId: string }) {
    const result = await records.getVersioned(
      assistantTurnKey(key.ticketId, key.turnId),
    );
    if (result?.value.kind !== "assistant_turn")
      throw new SupportDeskConflictError("Assistant turn is unavailable");
    assertAssistantTurnRecord(
      result.value,
      assistantTurnKey(key.ticketId, key.turnId),
    );
    return { ...result, value: result.value };
  }

  // Start alongside the deterministic turn read without letting unused ticket
  // failures replace an unavailable turn or an already-terminal claim result.
  async function observeTicket(ticketId: string) {
    try {
      return {
        outcome: "read" as const,
        value: await records.getVersioned({
          partition: ticketId,
          id: "ticket",
        }),
      };
    } catch (error) {
      return { outcome: "failed" as const, error };
    }
  }

  function boundedRows(rows: readonly SupportRecord[]): void {
    if (rows.length > limits.maxRecordsPerTicket)
      throw new SupportDeskLimitError(
        "ticket_partition",
        limits.maxRecordsPerTicket,
      );
  }

  function claimView(
    job: AssistantTurnRecord,
    ticket: Ticket,
    rows: readonly SupportRecord[],
  ): AssistantTurnClaim {
    if (
      job.claim === undefined ||
      job.leaseUntil === undefined ||
      ticket.requester.association !== "authenticated"
    )
      throw new SupportDeskConflictError("Assistant claim is incomplete");
    text(ticket.requester.principalId, "requester principalId");
    return snapshot({
      fence: job.claim,
      triggerRevision: job.triggerRevision,
      leaseUntil: job.leaseUntil,
      turnDeadline: job.turnDeadline,
      requesterPrincipalId: ticket.requester.principalId!,
      conversation: dependencies.conversation(ticket, rows),
      preparedAttempts: job.preparedAttempts,
    });
  }

  async function escalateExhausted(
    access: AccessContext,
    job: AssistantTurnRecord,
    ticket: Ticket,
  ): Promise<HandlingCommandResult> {
    const command: AssistantEscalationCommand = {
      ticketId: job.ticketId,
      commandId: `assistant-exhausted:${job.turnId}:${job.claimGeneration}`,
      correlationId: job.correlationId,
      triggerMessageId: job.triggerMessageId,
      expectedRevision: ticket.revision,
      expectedHandlingGeneration: effectiveTicketHandling(ticket).generation,
      reason: "capacity",
    };
    const commit: AssistantTurnCommit = {
      kind: "exhausted",
      ticketId: job.ticketId,
      turnId: job.turnId,
      claimGeneration: job.claimGeneration,
      fingerprint: await fingerprint({
        kind: "exhausted",
        ticketId: job.ticketId,
        turnId: job.turnId,
        claimGeneration: job.claimGeneration,
      }),
    };
    return ack(
      await dependencies.mutateHandling(
        access,
        command,
        "assistant_escalate",
        commit,
      ),
    );
  }

  return {
    async scanAssistantTurnCandidates(access, input) {
      permission(access, supportPermissions.assistantRead);
      enabled();
      const raw = fields(input, "assistant turn scan", ["limit"], ["cursor"]);
      const limit = integer(raw.limit, "scan.limit", 1, MAX_SCAN_PAGE_SIZE);
      if (raw.cursor !== undefined) text(raw.cursor, "scan.cursor", 16_384);
      const page = await records.scan({
        limit,
        ...(raw.cursor === undefined ? {} : { cursor: raw.cursor as string }),
      });
      if (page.records.length > limit)
        throw new SupportDeskConflictError(
          "Storage exceeded the physical assistant scan bound",
        );
      const candidates: { ticketId: string; turnId: string }[] = [];
      const seen = new Set<string>();
      const sampled = now();
      for (const entry of page.records) {
        if (
          entry.key.id.startsWith("assistant-turn:") &&
          entry.value.kind !== "assistant_turn"
        )
          throw new TypeError(
            "Assistant turn physical row has another record kind",
          );
        if (entry.value.kind !== "assistant_turn") continue;
        assertAssistantTurnRecord(entry.value, entry.key);
        const row = entry.value;
        if (
          terminalTurn(row) ||
          (row.status === "claimed" &&
            timestamp(row.leaseUntil!, "leaseUntil") > sampled &&
            timestamp(row.turnDeadline, "turnDeadline") > sampled) ||
          (row.status === "retry" &&
            timestamp(row.nextAttemptAt!, "nextAttemptAt") > sampled &&
            timestamp(row.turnDeadline, "turnDeadline") > sampled)
        )
          continue;
        const identity = canonical(entry.key);
        if (!seen.has(identity))
          candidates.push({
            ticketId: entry.key.partition,
            turnId: row.turnId,
          });
        seen.add(identity);
      }
      return {
        candidates,
        nextCursor: page.nextCursor,
        physicalRows: page.records.length,
        pages: 1,
      };
    },

    async claimAssistantTurn(access, input) {
      workerPermission(access);
      const config = enabled();
      const raw = fields(input, "claim assistant turn", [
        "ticketId",
        "turnId",
        "workerId",
        "claimId",
        "leaseMilliseconds",
      ]);
      for (const key of ["ticketId", "turnId", "workerId", "claimId"])
        text(raw[key], key);
      const command = snapshot(input);
      integer(
        command.leaseMilliseconds,
        "leaseMilliseconds",
        1,
        config.maxLeaseMilliseconds,
      );
      for (let conflict = 0; conflict < maxConflictAttempts; conflict += 1) {
        const turnRead = load(command);
        const ticketRead = observeTicket(command.ticketId);
        const versioned = await turnRead;
        const job = versioned.value;
        if (terminalTurn(job)) return null;
        const observed = await ticketRead;
        if (observed.outcome === "failed") throw observed.error;
        const ticketVersion = observed.value;
        if (ticketVersion?.value.kind !== "ticket") return null;
        const ticket = ticketVersion.value.ticket;
        const rows = await records.list(command.ticketId);
        boundedRows(rows);
        const sampled = now();
        const eligible = latestCustomerTrigger(ticket, rows, job);
        if (!eligible) {
          const superseded: AssistantTurnRecord = {
            ...withoutLease(job),
            status: "superseded",
          };
          assertAssistantTurnRecord(superseded);
          if (
            (
              await records.transact(command.ticketId, [
                {
                  action: "putIfUnchanged",
                  version: ticketVersion.version,
                  value: ticketVersion.value,
                },
                {
                  action: "putIfUnchanged",
                  version: versioned.version,
                  value: superseded,
                },
              ])
            ).committed
          )
            return null;
          continue;
        }
        if (
          sampled >= timestamp(job.turnDeadline, "turnDeadline") ||
          !dependencies.assistantHandlingEnabled ||
          (job.attempt >= Math.min(job.maxAttempts, config.maxAttempts) &&
            !(
              job.status === "claimed" &&
              timestamp(job.leaseUntil!, "leaseUntil") > sampled
            ))
        ) {
          await escalateExhausted(access, job, ticket);
          return null;
        }
        if (
          job.status === "claimed" &&
          timestamp(job.leaseUntil!, "leaseUntil") > sampled
        ) {
          if (
            job.claim?.workerId === command.workerId &&
            job.claim.claimId === command.claimId
          )
            return claimView(job, ticket, rows);
          return null;
        }
        if (
          job.status === "retry" &&
          timestamp(job.nextAttemptAt!, "nextAttemptAt") > sampled
        )
          return null;
        const attempt = job.attempt + 1;
        const claimGeneration = integer(
          job.claimGeneration + 1,
          "claimGeneration",
          1,
        );
        const attemptId = `${job.turnId}:${attempt}`;
        const fence: AssistantTurnClaimFence = {
          ticketId: job.ticketId,
          turnId: job.turnId,
          workerId: command.workerId,
          claimId: command.claimId,
          claimGeneration,
          attempt,
          attemptId,
          commandId: `assistant-complete:${attemptId}`,
          correlationId: job.correlationId,
          expectedRevision: ticket.revision,
          expectedHandlingGeneration:
            effectiveTicketHandling(ticket).generation,
          triggerMessageId: job.triggerMessageId,
        };
        const claimed: AssistantTurnRecord = {
          ...withoutLease(job),
          status: "claimed",
          attempt,
          claimGeneration,
          claim: fence,
          leaseUntil: new Date(
            Math.min(
              sampled + command.leaseMilliseconds,
              timestamp(job.turnDeadline, "turnDeadline"),
            ),
          ).toISOString(),
        };
        assertAssistantTurnRecord(claimed);
        if (
          (
            await records.transact(command.ticketId, [
              {
                action: "putIfUnchanged",
                version: ticketVersion.version,
                value: ticketVersion.value,
              },
              {
                action: "putIfUnchanged",
                version: versioned.version,
                value: claimed,
              },
            ])
          ).committed
        )
          return claimView(claimed, ticket, rows);
      }
      throw new SupportDeskConflictError();
    },

    async prepareAssistantTurnAttempt(access, input) {
      workerPermission(access);
      enabled();
      const raw = validateFence(input, ["binding"]);
      const binding = validateBinding(raw.binding);
      const command = snapshot({ ...raw, binding });
      for (let conflict = 0; conflict < maxConflictAttempts; conflict += 1) {
        const turnRead = load(command);
        const ticketRead = observeTicket(command.ticketId);
        const versioned = await turnRead;
        const job = versioned.value;
        const observed = await ticketRead;
        if (observed.outcome === "failed") throw observed.error;
        const ticketVersion = observed.value;
        if (ticketVersion?.value.kind !== "ticket")
          throw new SupportDeskConflictError("Assistant ticket is unavailable");
        const rows = await records.list(command.ticketId);
        boundedRows(rows);
        activeClaim(job, command, ticketVersion.value.ticket);
        if (
          !dependencies.assistantHandlingEnabled ||
          !latestCustomerTrigger(ticketVersion.value.ticket, rows, job)
        )
          throw new SupportDeskConflictError("Assistant turn was superseded");
        const sampled = now();
        if (
          timestamp(binding.deadline, "binding.deadline") <= sampled ||
          timestamp(binding.deadline, "binding.deadline") >
            Math.min(
              timestamp(job.leaseUntil!, "leaseUntil"),
              timestamp(job.turnDeadline, "turnDeadline"),
            )
        )
          throw new SupportDeskConflictError(
            "Prepared request deadline is outside its current claim",
          );
        const previous = job.preparedAttempts.find(
          (attempt) => attempt.attemptId === command.attemptId,
        );
        if (previous !== undefined) {
          if (canonical(previous.binding) !== canonical(binding))
            throw new SupportDeskConflictError(
              "Assistant attempt input is immutable",
            );
          return snapshot({
            attemptId: previous.attemptId,
            inputFingerprint: previous.inputFingerprint,
            binding: previous.binding,
          });
        }
        const prepared: AssistantTurnRecord = {
          ...job,
          preparedAttempts: [
            ...job.preparedAttempts,
            {
              attempt: command.attempt,
              attemptId: command.attemptId,
              inputFingerprint: binding.inputFingerprint,
              binding,
              accounting: "unknown",
            },
          ],
        };
        assertAssistantTurnRecord(prepared);
        if (encodedBytes(prepared) > preparedRecordBytes)
          throw new SupportDeskLimitError(
            "serialized_record",
            preparedRecordBytes,
          );
        if (maximumPostPreparationRecordBytes(prepared) > maximumRecordBytes)
          throw new SupportDeskLimitError(
            "serialized_record",
            maximumRecordBytes,
          );
        activeClaim(job, command, ticketVersion.value.ticket);
        if (timestamp(binding.deadline, "binding.deadline") <= now())
          throw new SupportDeskConflictError(
            "Assistant request deadline expired before preparation",
          );
        if (
          (
            await records.transact(command.ticketId, [
              {
                action: "putIfUnchanged",
                version: ticketVersion.version,
                value: ticketVersion.value,
              },
              {
                action: "putIfUnchanged",
                version: versioned.version,
                value: prepared,
              },
            ])
          ).committed
        )
          return snapshot({
            attemptId: command.attemptId,
            inputFingerprint: binding.inputFingerprint,
            binding,
          });
      }
      throw new SupportDeskConflictError();
    },

    async completeAssistantTurn(access, input, guard) {
      const raw = validateFence(
        input,
        ["inputFingerprint", "outcome"],
        ["processing"],
      );
      text(raw.inputFingerprint, "inputFingerprint");
      if (typeof guard !== "function")
        throw new TypeError(
          "Assistant completion requires a read-only commit guard",
        );
      const outcome = fields(
        raw.outcome,
        "assistant outcome",
        ["kind"],
        ["messageId", "body", "reason", "summary", "attemptedGuideIds"],
      );
      if (outcome.kind !== "answer" && outcome.kind !== "escalate")
        throw new TypeError("Invalid assistant outcome");
      permission(
        access,
        outcome.kind === "answer"
          ? supportPermissions.assistantReply
          : supportPermissions.assistantEscalate,
      );
      if (outcome.kind === "answer") {
        fields(outcome, "assistant answer", ["kind", "messageId", "body"]);
        text(outcome.messageId, "messageId");
        if (
          typeof outcome.body !== "string" ||
          outcome.body.trim().length === 0 ||
          outcome.body.length > 20_000
        )
          throw new SupportDeskLimitError("body", 20_000);
      } else {
        fields(
          outcome,
          "assistant escalation",
          ["kind"],
          ["reason", "summary", "attemptedGuideIds"],
        );
        validateReason(outcome.reason);
        validateSummary(outcome.summary);
        if (outcome.attemptedGuideIds !== undefined)
          for (const guide of dataArray(
            outcome.attemptedGuideIds,
            "attemptedGuideIds",
            16,
          ))
            text(guide, "guideId");
      }
      const processing = validateProcessing(raw.processing);
      const command = snapshot({
        ...raw,
        ...(processing === undefined ? {} : { processing }),
      }) as unknown as CompleteAssistantTurnCommand;
      const commit: AssistantTurnCommit = {
        kind: "complete",
        command,
        fingerprint: await fingerprint({
          actorId: access.principalId,
          command,
        }),
        guard,
      };
      const handling = {
        commandId: command.commandId,
        correlationId: command.correlationId,
        ticketId: command.ticketId,
        expectedRevision: command.expectedRevision,
        expectedHandlingGeneration: command.expectedHandlingGeneration,
        triggerMessageId: command.triggerMessageId,
        ...command.outcome,
      };
      // The handling executor checks its exact historical command receipt before
      // validating a live claim, so an accepted but unacknowledged commit recovers.
      const result = await dependencies.mutateHandling(
        access,
        handling,
        outcome.kind === "answer" ? "assistant_reply" : "assistant_escalate",
        commit,
      );
      return ack(
        result,
        command.outcome.kind === "answer"
          ? command.outcome.messageId
          : undefined,
      );
    },

    async finishAssistantTurnAttempt(access, input) {
      workerPermission(access);
      enabled();
      const raw = validateFence(
        input,
        ["disposition", "accounting"],
        ["retryAt", "reason", "summary", "processing"],
      );
      if (
        typeof raw.disposition !== "string" ||
        !["retry", "superseded", "escalate"].includes(raw.disposition) ||
        typeof raw.accounting !== "string" ||
        !["not_called", "accounted", "unknown"].includes(raw.accounting)
      )
        throw new TypeError("Invalid assistant attempt disposition");
      if (raw.retryAt !== undefined) timestamp(raw.retryAt, "retryAt");
      validateReason(raw.reason);
      validateSummary(raw.summary);
      const processing = validateProcessing(raw.processing);
      const command = snapshot({
        ...raw,
        ...(processing === undefined ? {} : { processing }),
      }) as unknown as FinishAssistantTurnAttemptCommand;
      const requestFingerprint = await fingerprint({
        actorId: access.principalId,
        command,
      });
      const key = { ticketId: command.ticketId, turnId: command.turnId };
      for (let conflict = 0; conflict < maxConflictAttempts; conflict += 1) {
        const turnRead = load(command);
        const ticketRead = observeTicket(command.ticketId);
        const versioned = await turnRead;
        const job = versioned.value;
        if (job.lastFinish?.fingerprint === requestFingerprint)
          return snapshot(job.lastFinish.result);
        if (terminalTurn(job))
          return {
            ...key,
            outcome: "already_terminal",
            ...(job.terminalResult === undefined
              ? {}
              : { result: job.terminalResult }),
          };
        const observed = await ticketRead;
        if (observed.outcome === "failed") throw observed.error;
        const ticketVersion = observed.value;
        if (ticketVersion?.value.kind !== "ticket")
          throw new SupportDeskConflictError("Assistant ticket is unavailable");
        const ticket = ticketVersion.value.ticket;
        const rows = await records.list(command.ticketId);
        boundedRows(rows);
        const eligible = latestCustomerTrigger(ticket, rows, job);
        const sampled = now();
        if (!sameClaim(job, command))
          throw new SupportDeskConflictError("Assistant turn claim was lost");
        if (
          eligible &&
          sampled >= timestamp(job.turnDeadline, "turnDeadline")
        ) {
          const result = await escalateExhausted(access, job, ticket);
          return { ...key, outcome: "escalated", result };
        }
        activeClaim(job, command);
        if (command.disposition === "superseded" && eligible)
          throw new SupportDeskConflictError(
            "Current assistant turn cannot be abandoned",
          );
        const nextAttemptAt = new Date(
          Math.max(
            sampled,
            command.retryAt === undefined
              ? sampled
              : timestamp(command.retryAt, "retryAt"),
          ),
        ).toISOString();
        const exhausted =
          job.attempt >= Math.min(job.maxAttempts, enabled().maxAttempts) ||
          timestamp(nextAttemptAt, "nextAttemptAt") >=
            timestamp(job.turnDeadline, "turnDeadline") ||
          !dependencies.assistantHandlingEnabled;
        if (eligible && (command.disposition === "escalate" || exhausted)) {
          const handling: AssistantEscalationCommand = {
            commandId: command.commandId,
            correlationId: command.correlationId,
            ticketId: command.ticketId,
            expectedRevision: ticket.revision,
            expectedHandlingGeneration:
              effectiveTicketHandling(ticket).generation,
            triggerMessageId: job.triggerMessageId,
            reason: command.reason ?? (exhausted ? "capacity" : "other"),
            ...(command.summary === undefined
              ? {}
              : { summary: command.summary }),
          };
          const result = ack(
            await dependencies.mutateHandling(
              access,
              handling,
              "assistant_escalate",
              { kind: "finish", command, fingerprint: requestFingerprint },
            ),
          );
          return { ...key, outcome: "escalated", result };
        }
        const result: AssistantTurnFinishResult = eligible
          ? { ...key, outcome: "retry_scheduled", nextAttemptAt }
          : { ...key, outcome: "superseded" };
        const updated: AssistantTurnRecord = {
          ...assistantTurnProcessingState(withoutLease(job), processing, {
            attemptId: command.attemptId,
            accounting: command.accounting,
          }),
          status: eligible ? "retry" : "superseded",
          ...(eligible ? { nextAttemptAt } : {}),
          lastFinish: { fingerprint: requestFingerprint, result },
        };
        assertAssistantTurnRecord(updated);
        activeClaim(job, command);
        if (
          (
            await records.transact(command.ticketId, [
              {
                action: "putIfUnchanged",
                version: ticketVersion.version,
                value: ticketVersion.value,
              },
              {
                action: "putIfUnchanged",
                version: versioned.version,
                value: updated,
              },
            ])
          ).committed
        )
          return snapshot(result);
      }
      throw new SupportDeskConflictError();
    },

    async completionAction(ticket, rows, updated, commit) {
      enabled();
      if (
        commit.kind === "complete" &&
        commit.command.outcome.kind === "answer" &&
        commit.command.outcome.body.length > limits.maxMessageCharacters
      )
        throw new SupportDeskLimitError("body", limits.maxMessageCharacters);
      const key = commit.kind === "exhausted" ? commit : commit.command;
      const versioned = await load(key);
      const job = versioned.value;
      if (terminalTurn(job) || !latestCustomerTrigger(ticket, rows, job))
        throw new SupportDeskConflictError("Assistant turn was superseded");
      if (commit.kind === "exhausted") {
        if (
          job.claimGeneration !== commit.claimGeneration ||
          (dependencies.assistantHandlingEnabled &&
            now() < timestamp(job.turnDeadline, "turnDeadline") &&
            job.attempt < Math.min(job.maxAttempts, enabled().maxAttempts))
        )
          throw new SupportDeskConflictError(
            "Assistant turn is no longer exhausted",
          );
      } else {
        activeClaim(
          job,
          commit.command,
          commit.kind === "complete" ? ticket : undefined,
        );
      }
      const prepared =
        commit.kind === "complete"
          ? job.preparedAttempts.find(
              (attempt) => attempt.attemptId === commit.command.attemptId,
            )
          : undefined;
      if (
        commit.kind === "complete" &&
        (prepared === undefined ||
          prepared.inputFingerprint !== commit.command.inputFingerprint)
      )
        throw new SupportDeskConflictError(
          "Assistant completion does not match its prepared request",
        );
      const result = ack(
        updated,
        commit.kind === "complete" && commit.command.outcome.kind === "answer"
          ? commit.command.outcome.messageId
          : undefined,
      );
      const processing =
        commit.kind === "exhausted" ? undefined : commit.command.processing;
      const terminal: AssistantTurnRecord = {
        ...assistantTurnProcessingState(
          withoutLease(job),
          processing,
          commit.kind === "finish"
            ? {
                attemptId: commit.command.attemptId,
                accounting: commit.command.accounting,
              }
            : undefined,
        ),
        status:
          commit.kind === "complete" && commit.command.outcome.kind === "answer"
            ? "completed"
            : "escalated",
        terminalResult: result,
        ...(commit.kind === "finish"
          ? {
              lastFinish: {
                fingerprint: commit.fingerprint,
                result: {
                  ticketId: job.ticketId,
                  turnId: job.turnId,
                  outcome: "escalated" as const,
                  result,
                },
              },
            }
          : {}),
      };
      assertAssistantTurnRecord(terminal);
      return {
        action: {
          action: "putIfUnchanged",
          version: versioned.version,
          value: terminal,
        },
        async verifyBeforeCommit() {
          if (commit.kind === "complete") await commit.guard();
          // Sample again after every awaited authority/source check. A guard
          // cannot prolong a lease or a prepared request's absolute deadline.
          if (commit.kind !== "exhausted")
            activeClaim(
              job,
              commit.command,
              commit.kind === "complete" ? ticket : undefined,
            );
          if (
            prepared !== undefined &&
            now() >= timestamp(prepared.binding.deadline, "prepared deadline")
          )
            throw new SupportDeskConflictError(
              "Assistant prepared request expired",
            );
        },
      };
    },
  };
}
