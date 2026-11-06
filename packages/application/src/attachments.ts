import type {
  IsoTimestamp,
  MessageAttachment,
} from "@pegma/support-desk-contracts";
import { normalizeAttachmentFilename } from "@pegma/support-desk-core";

export interface AttachmentInput {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** Host-owned isolated private storage. Keys are immutable and never public URLs. */
export interface AttachmentBlobPort {
  /** Create only; return "exists" without writing on collision. Settle only after writes stop. */
  put(
    key: string,
    bytes: Uint8Array,
    context: { readonly ticketId: string; readonly messageId: string },
  ): Promise<void | "exists">;
  /** Return a bounded copy. Reject objects larger than maximumBytes before buffering. */
  get(key: string, maximumBytes: number): Promise<Uint8Array>;
  /** Idempotent, including missing keys. */
  delete(key: string): Promise<void>;
}

export interface AttachmentOptions {
  readonly blobs: AttachmentBlobPort;
  readonly allowedContentTypes?: readonly string[];
  readonly maxPerMessage?: number;
  readonly maxPerTicket?: number;
  readonly maxBytes?: number;
  readonly maxMessageBytes?: number;
  readonly maxFilenameCharacters?: number;
  readonly retentionMilliseconds?: number;
}

export interface AttachmentDownload {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly cacheControl: "private, no-store";
  readonly xContentTypeOptions: "nosniff";
}

export type SafeAttachment = Omit<MessageAttachment, "blobKey" | "sha256">;

export function snapshotAttachmentInputs(
  raw: unknown,
): readonly AttachmentInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 10)
    throw new TypeError("At most 10 attachments per command");
  let totalBytes = 0;
  return Array.from({ length: raw.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(raw, String(index));
    if (
      !item ||
      !("value" in item) ||
      typeof item.value !== "object" ||
      !item.value
    )
      throw new TypeError("Invalid attachment");
    const read = (field: string): unknown => {
      const property = Object.getOwnPropertyDescriptor(item.value, field);
      if (!property || !("value" in property))
        throw new TypeError("Attachment fields must be data properties");
      return property.value;
    };
    const filename = read("filename"),
      contentType = read("contentType"),
      bytes = read("bytes"),
      sha256 = read("sha256");
    if (
      typeof filename !== "string" ||
      typeof contentType !== "string" ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > 10 * 1024 * 1024 ||
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha256)
    )
      throw new TypeError("Invalid attachment descriptor");
    totalBytes += bytes.byteLength;
    if (totalBytes > 20 * 1024 * 1024)
      throw new TypeError("Attachment command byte limit exceeded");
    return Object.freeze({
      filename,
      contentType,
      bytes: new Uint8Array(bytes),
      sha256,
    });
  });
}

export async function attachmentDigest(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes),
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export function attachmentConfiguration(
  options: AttachmentOptions | undefined,
) {
  const bounded = (
    value: number | undefined,
    fallback: number,
    max: number,
  ) => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1 || result > max)
      throw new TypeError("Invalid attachment limit");
    return result;
  };
  const config = {
    blobs: options?.blobs,
    allowed: new Set(
      options?.allowedContentTypes ?? ["text/plain", "image/png", "image/jpeg"],
    ),
    perMessage: bounded(options?.maxPerMessage, 3, 10),
    perTicket: bounded(options?.maxPerTicket, 20, 100),
    bytes: bounded(options?.maxBytes, 2 * 1024 * 1024, 10 * 1024 * 1024),
    messageBytes: bounded(
      options?.maxMessageBytes,
      5 * 1024 * 1024,
      20 * 1024 * 1024,
    ),
    filename: bounded(options?.maxFilenameCharacters, 120, 255),
    retention: bounded(
      options?.retentionMilliseconds,
      30 * 86400000,
      365 * 86400000,
    ),
  };
  if (
    config.allowed.size > 32 ||
    [...config.allowed].some(
      (type) =>
        !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type),
    )
  )
    throw new TypeError("Invalid MIME allowlist");
  return config;
}

export async function attachmentDescriptors(
  inputs: readonly AttachmentInput[],
  _config: ReturnType<typeof attachmentConfiguration>,
) {
  if (!inputs.length) return [];
  return Promise.all(
    inputs.map(async (input) => {
      if (
        !input.bytes.byteLength ||
        (await attachmentDigest(input.bytes)) !== input.sha256
      )
        throw new TypeError("Attachment size or digest refused");
      return {
        filename: normalizeAttachmentFilename(input.filename, 255),
        contentType: input.contentType,
        size: input.bytes.byteLength,
        sha256: input.sha256,
      };
    }),
  );
}

export function newAttachment(
  descriptor: Awaited<ReturnType<typeof attachmentDescriptors>>[number],
  now: IsoTimestamp,
  retention: number,
): MessageAttachment {
  const id = globalThis.crypto.randomUUID();
  return {
    ...descriptor,
    id,
    blobKey: `support-attachments/${id}`,
    scanStatus: "pending_scan",
    expiresAt: new Date(Date.parse(now) + retention).toISOString(),
  };
}
