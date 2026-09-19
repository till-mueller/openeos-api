import { TseVatSplit } from '../tse/tse.interface';

export interface VatSplitItem {
  quantity: number;
  unitPrice: number;
  optionsPrice: number;
  taxRate: number;
}

export interface VatSplitItemPayment {
  amount: number;
  taxRate: number;
}

const toCents = (v: number): number => Math.round(v * 100);
const toEuros = (c: number): number => c / 100;

function groupByRate(
  rows: { amount: number; taxRate: number }[],
): TseVatSplit[] {
  const totals = new Map<number, number>();
  for (const row of rows) {
    totals.set(
      row.taxRate,
      (totals.get(row.taxRate) ?? 0) + toCents(row.amount),
    );
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([rate, cents]) => ({ rate, grossAmount: toEuros(cents) }));
}

/** Gross per tax rate across order items: (unitPrice + optionsPrice) * quantity. */
export function splitsFromItems(items: VatSplitItem[]): TseVatSplit[] {
  return groupByRate(
    items.map((i) => ({
      amount: (i.unitPrice + i.optionsPrice) * i.quantity,
      taxRate: i.taxRate,
    })),
  );
}

/** Gross per tax rate across item-level payment rows (split payments). */
export function splitsFromItemPayments(
  rows: VatSplitItemPayment[],
): TseVatSplit[] {
  return groupByRate(rows);
}

/**
 * Scales `splits` so their sum equals `targetAmount` exactly (largest-remainder
 * rounding in integer cents; residual cents go to the largest remainders,
 * ties to the lowest rate).
 * fiskaly validates vat-sum against payment-sum, so an exact match is
 * load-bearing, not cosmetic. Zero-amount splits are dropped (fiskaly rejects
 * empty vat lines).
 */
export function allocateToAmount(
  splits: TseVatSplit[],
  targetAmount: number,
): TseVatSplit[] {
  const clean = splits.filter((s) => toCents(s.grossAmount) !== 0);
  if (clean.length === 0) return [];

  const totalCents = clean.reduce((s, x) => s + toCents(x.grossAmount), 0);
  const targetCents = toCents(targetAmount);
  if (totalCents === targetCents) return clean;
  if (totalCents === 0) return [];

  const sign = targetCents < 0 ? -1 : 1;
  const absTotal = Math.abs(totalCents);
  const absTarget = Math.abs(targetCents);

  const shares = clean.map((s) => {
    const exact = (Math.abs(toCents(s.grossAmount)) * absTarget) / absTotal;
    const floor = Math.floor(exact);
    return { rate: s.rate, floor, remainder: exact - floor };
  });

  let distributed = shares.reduce((s, x) => s + x.floor, 0);
  // Largest remainder first; ties go to the lowest rate so the 0%/7% bucket
  // (not the 19% bucket) absorbs the residual cent — deterministic and keeps
  // the rounding noise out of the highest-taxed turnover.
  const byRemainder = [...shares].sort(
    (a, b) => b.remainder - a.remainder || a.rate - b.rate,
  );
  for (let i = 0; distributed < absTarget; i += 1) {
    byRemainder[i % byRemainder.length].floor += 1;
    distributed += 1;
  }

  return shares.map((s) => ({
    rate: s.rate,
    grossAmount: sign * toEuros(s.floor),
  }));
}

/** Negates every split — the reversal path mirrors exactly what was signed. */
export function negateSplits(splits: TseVatSplit[]): TseVatSplit[] {
  return splits.map((s) => ({
    rate: s.rate,
    grossAmount: toEuros(-toCents(s.grossAmount)),
  }));
}
