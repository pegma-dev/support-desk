interface ApprovalRoute {
  readonly approval: {
    readonly verifiedAt?: string;
    readonly validUntil: string;
  };
}

/** The caller separately validates live current evidence and the attempt expiry. */
export function sameApprovalRenewal<Route extends ApprovalRoute>(
  current: Route,
  captured: Route,
  canonical: (value: unknown) => string,
): boolean {
  const identity = (route: Route) => {
    const { verifiedAt, validUntil, ...approval } = route.approval;
    void verifiedAt;
    void validUntil;
    return { ...route, approval };
  };
  return (
    Date.parse(current.approval.validUntil) >=
      Date.parse(captured.approval.validUntil) &&
    canonical(identity(current)) === canonical(identity(captured))
  );
}
