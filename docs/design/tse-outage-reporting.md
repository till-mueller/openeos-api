# TSE Outage Reporting — Design Doc

**Status:** design only, no code yet.
**Depends on:** `src/modules/tse/tse.service.ts` (`TseService.recordTransaction`'s existing Ausfall fallback), `docs/design/offline-box-sync.md` §4.
**Feeds into:** the DSFinV-K export PR the maintainer requested as the second step in issue #8's build order (interface+fiskaly → DSFinV-K export → settings UI).

## Problem

`TseService.recordTransaction` already never blocks a sale on a TSE failure — it catches the error and returns `TseTransactionData` with `failed: true` and a `failureReason`, which `PaymentsService` stores on `Payment.tseData` (`src/database/entities/payment.entity.ts`). That's the BMF Ausfall-Regelung: correct behavior, already shipped.

What doesn't exist yet: turning a scattering of `failed: true` payments into the artifact a tax audit actually wants — a clear record of *when* the TSE was down, *for how long*, and *which transactions* fall inside that window. Today that information only exists as individual rows; nobody has aggregated it. For a single dropped request that's not urgent. For a fully offline event (`docs/design/offline-box-sync.md`'s Box model, run on a remote local network with no uplink to fiskaly for the whole event) it's the entire audit trail for that event, so it has to exist before a Box is used for real money.

## Non-goal: retroactive signing

Fiskaly cannot (and should not) be asked to sign a transaction after the fact with the transaction's original time — that would misrepresent when the signature was produced, which defeats the point of the signature. The Ausfall-Regelung's requirement is *documentation of the gap*, not *closing the gap after it's too late to sign honestly*. So this design does not introduce a retry/resign queue. `tseData.failed: true` is a permanent, correct record of an outage — not a pending state waiting to be resolved.

## 1. Outage window derivation

An outage window for one org is a maximal run of temporally-adjacent `failed: true` payments with no successful (`failed: false`) signed payment between them. Derive on read, not on write — no new table:

```sql
-- Conceptually: partition payments by organization (via order), order by
-- payment.createdAt, and group consecutive failed=true rows.
SELECT order.organization_id, payment.created_at, payment.tse_data->>'failed', payment.tse_data->>'failureReason'
FROM payments payment
JOIN orders order ON order.id = payment.order_id
WHERE payment.tse_data IS NOT NULL
ORDER BY order.organization_id, payment.created_at;
```

A window's `start` = first failed payment's `createdAt` in the run, `end` = last failed payment's `createdAt` in the run (or "still open" if the most recent TSE-relevant payment for that org is still `failed: true`). This mirrors `TseService`'s own framing — it has no concept of an outage window today, only per-payment outcomes — so deriving windows in a query keeps `recordTransaction` exactly as simple as it is.

## 2. `TseService.getOutageReport(organizationId, periodStart, periodEnd)`

New read method, same shape as the existing `exportData`/`listClientIds` (`checkMembership` guard, org-scoped). Returns:

```ts
interface TseOutageWindow {
  start: string;   // ISO
  end: string;     // ISO, or null if still ongoing
  paymentCount: number;
  totalAmount: number;
  failureReasons: string[];  // distinct reasons seen in the window
}

interface TseOutageReport {
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  windows: TseOutageWindow[];
}
```

Implementation: one query grouping `Payment` rows per org as in §1, collapsed into windows in application code (no need for a recursive CTE — the payment volume per org per period is small enough that grouping in TypeScript is simpler to read and test than window-function SQL).

## 3. DSFinV-K integration

DSFinV-K's `transactions.csv` has fields for representing a TSE-unavailable transaction (the format expects the failure to be visible per-transaction, not just in a side report — see the DSFinV-K spec's `TERMINAL_ID`/`Z_ID`/`BON_ID` transaction rows and the TSE-specific columns for signature absence). The PR #2 export work should:

- Map each `Payment` with `tseData.failed: true` to a DSFinV-K transaction row with the TSE-failure columns populated (no signature/counter/serial — those stay empty, per spec, rather than synthesized)
- Optionally emit `TseOutageWindow`s from §2 as a human-readable summary alongside the DSFinV-K archive (DSFinV-K itself doesn't have a dedicated "outage summary" file — this would be a value-add on top, e.g. in the export's cover sheet), not a substitute for the row-level data DSFinV-K requires

This keeps the outage information inside the artifact the maintainer already asked for, instead of a second bespoke report an auditor has to be told about separately.

## 4. When reporting happens for a Box

`docs/design/offline-box-sync.md`'s outbox sync pushes `Order`/`OrderItem`/`Payment`/`PrintJob` rows to Central as connectivity allows. The outage report is a **pull**, not something pushed through the sync loop:

- It's a derived view over `Payment` rows that already exist (locally on the Box while offline, or centrally once synced) — recomputing it doesn't require new sync machinery.
- The outage's boundaries don't change once the payments that define them are written, so there's no "keep it in sync" problem to solve.
- An org can call `getOutageReport` either against the Box's own local API mid-event, or against Central after sync — same method, same result once the data has landed in either place.

No changes to the sync protocol in `offline-box-sync.md` are needed for this.

## Open questions

- Exact DSFinV-K column mapping for TSE-failure rows needs to be nailed down against the spec (and ideally cross-checked with fiskaly's own DSFinV-K export, if their API produces one for comparison) as part of implementing PR #2 — not resolved here.
- Whether `getOutageReport` needs pagination for orgs with a very long history — deferred until real usage shows it's needed, per this repo's general habit of not building ahead of evidence (see `offline-box-sync.md` §7 step 5's reasoning for the same call).
