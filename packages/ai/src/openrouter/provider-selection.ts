import { z } from "zod";

/** Provider pricing filters, not a total-request budget. The host must verify
 * eligible metadata and non-token charges; missing pricing is not zero. */
export const providerMaxPrice = z
  .object({
    /** USD per million text input tokens. */
    prompt: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** USD per million billed completion tokens, including reasoning. */
    completion: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** No per-request charge is approved. This filter is not metadata proof. */
    request: z.literal(0),
  })
  .strict();

export type SupportProviderMaxPrice = z.infer<typeof providerMaxPrice>;

interface Selection {
  readonly endpointTag: string;
  readonly providerSelectionScope?: "provider_group" | undefined;
  readonly providerMaxPrice?: SupportProviderMaxPrice | undefined;
  readonly approval: {
    readonly providerSelectionScope?: "provider_group" | undefined;
  };
}

interface PriceBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostMicros: number;
  readonly currency: string;
}

function decimal(value: number): { digits: bigint; scale: number } {
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  return {
    digits: BigInt(whole! + fraction),
    scale: fraction.length - Number(exponent),
  };
}

/** Token price USD/million is numerically microUSD/token. Add exact decimal
 * terms before rounding once; binary multiplication must not lower the bound. */
function fitsPriceBudget(price: SupportProviderMaxPrice, budget: PriceBudget) {
  if (
    budget.currency !== "USD" ||
    !Number.isSafeInteger(budget.maxInputTokens) ||
    budget.maxInputTokens < 1 ||
    !Number.isSafeInteger(budget.maxOutputTokens) ||
    budget.maxOutputTokens < 1 ||
    !Number.isSafeInteger(budget.maxCostMicros) ||
    budget.maxCostMicros < 0
  )
    return false;
  const prompt = decimal(price.prompt);
  const completion = decimal(price.completion);
  const scale = Math.max(0, prompt.scale, completion.scale);
  const denominator = 10n ** BigInt(scale);
  const numerator =
    BigInt(budget.maxInputTokens) *
      prompt.digits *
      10n ** BigInt(scale - prompt.scale) +
    BigInt(budget.maxOutputTokens) *
      completion.digits *
      10n ** BigInt(scale - completion.scale);
  const micros = (numerator + denominator - 1n) / denominator;
  return micros <= BigInt(budget.maxCostMicros);
}

/** New policy is opt-in. Absence returns no new wire property and does not
 * reinterpret or tighten the generic transport's existing selector contract. */
export function selectedProviderMaxPrice(
  route: Selection,
  budget: PriceBudget,
  allowProviderGroup: boolean,
): SupportProviderMaxPrice | undefined {
  const scoped = Object.hasOwn(route, "providerSelectionScope");
  const priced = Object.hasOwn(route, "providerMaxPrice");
  const approved = Object.hasOwn(route.approval, "providerSelectionScope");
  if (!scoped && !priced && !approved) return undefined;
  if (
    !allowProviderGroup ||
    !scoped ||
    !priced ||
    !approved ||
    route.providerSelectionScope !== "provider_group" ||
    route.approval.providerSelectionScope !== "provider_group" ||
    !/^[a-z0-9-]+$/u.test(route.endpointTag)
  )
    throw new TypeError("Provider-group policy unavailable");
  const price = providerMaxPrice.parse(route.providerMaxPrice);
  if (!fitsPriceBudget(price, budget))
    throw new TypeError("Provider-group price exceeds total budget");
  return price;
}
