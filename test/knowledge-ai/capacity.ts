/** P-00 envelope arithmetic only; this does not admit production AI jobs. */
export interface TicketRowEnvelope {
  /** All canonical messages, including notes and lifecycle messages. */
  readonly messages: number;
  readonly deliveries: number;
  /** Mutations that add audit + receipt without a canonical message. */
  readonly nonMessageCommands: number;
  /** Proposed future rows; current application does not reserve these. */
  readonly extensionRows: number;
}

function requireCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
}

export function estimateTicketRows(envelope: TicketRowEnvelope): number {
  for (const field of [
    "messages",
    "deliveries",
    "nonMessageCommands",
    "extensionRows",
  ] as const) {
    requireCount(envelope[field], field);
  }
  const rows =
    3 +
    3 * envelope.messages +
    envelope.deliveries +
    2 * envelope.nonMessageCommands +
    envelope.extensionRows;
  requireCount(rows, "estimated row total");
  return rows;
}

/** Pure planning calculation. Future task admission must enforce its own gate. */
export function assessRowAdmission(input: {
  readonly currentRows: number;
  readonly addedRows: number;
  readonly capacity: number;
  readonly reservedRows: number;
}): {
  readonly fits: boolean;
  readonly projectedRows: number;
  readonly spareRows: number;
  readonly shortfallRows: number;
} {
  for (const field of [
    "currentRows",
    "addedRows",
    "capacity",
    "reservedRows",
  ] as const) {
    requireCount(input[field], field);
  }
  if (input.reservedRows > input.capacity) {
    throw new TypeError("reservedRows cannot exceed physical capacity");
  }
  const projectedRows = input.currentRows + input.addedRows;
  requireCount(projectedRows, "projected row total");
  const usableRows = input.capacity - input.reservedRows;
  return {
    fits: projectedRows <= usableRows,
    projectedRows,
    spareRows: Math.max(0, usableRows - projectedRows),
    shortfallRows: Math.max(0, projectedRows - usableRows),
  };
}
