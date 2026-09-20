# Estimated reading recovery repair

User authorized repair after the 250 → estimated275 → actual265 example. Dates are illustrative; no Chengdu tariff or per-person entitlement is inferred. The user clarified “先修复再计算”; there is no pending authorization question.

## Confirmed scope and behavior

Repair the existing settlement/reconciliation connection without changing configured allocation policy or old FINAL records. Keep the original Pilot DB intact; use isolated test data.

1. Preserve provenance of the prior component dial. If a new actual/removal dial is below an ESTIMATE synthetic end, never infer rollover from maxDial. Return an actionable Chinese estimate-recovery error before creating a settlement.
2. Existing reconciliation can correct the already FINAL/billed historical span before the current settlement exists. Continue using that operation and its configured period allocation. Do not add automatic money movements.
3. An APPLIED reconciliation establishes its still-trusted actual reading as a settled checkpoint. Future settlement generation prefers that checkpoint over older/equal-period component ends on the same installation. A superseded/untrusted reading must not be used. A newer component remains the chain head.
4. The recovered period has zero additional consumption when reconciliation already allocated all usage through its actual reading. Next actual starts at265, not275. Repeated reconciliation remains idempotent/conflicting, never another credit.
5. Real rollover from a previous real reading retains current behavior. Ambiguous meter changes or true regression still require review.

6. Reconciliation quantity corrections update the source period's annual-tier usage. The latest absolute correction replaces earlier corrections; a correction issued next year does not change next year's usage. Persist quantity-only adjustment documents even when money is zero, including restoration to the original estimated quantity.
7. Within one month, a later settled physical reading remains ahead of an older reconciliation checkpoint. A superseded source reading may be replaced by its trusted correction.
8. Bound the cashier customer/account selects to their existing parent widths; long account labels must not overlap or block the next selector.

## Alternatives considered

- Clamp negative consumption to zero: rejected because it conceals unresolved overbilling and fails to distinguish estimated dials from rollover.
- Rewrite old FINAL components: rejected because it breaks frozen documents and pricing history.
- Use the existing adjustment plus a trusted checkpoint (selected): preserves history and gives a finite UI recovery path.

## Verification

First reproduce API generation against a paid estimate for maxDial absent and present; RED must show NEGATIVE_USAGE/huge rollover rather than estimate-recovery guidance. Then run estimate→paid bill→actual→adjustment→current zero settlement→next actual chain through real API, plus a Chrome scenario. Check original financial amount conservation, tariff-year boundaries, existing positive absorb behavior and real rollover.

## Pending scope

Automatic household-size entitlement is not implemented by this repair. Exact Chengdu charges require an explicit tariff and population policy; illustrative dates do not supply those parameters. Existing negative adjustments and net outstanding remain supported, but this patch does not add cash refunds or automatic credit allocation. No schema/migration changes or edits to the release tag.
