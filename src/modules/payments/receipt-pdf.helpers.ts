import { OrderItem, Payment } from '../../database/entities';

export function formatCurrency(amount: number | string): string {
  return `${Number(amount).toFixed(2)} €`;
}

export function formatDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
  });
}

export function paymentMethodLabel(method: string): string {
  const labels: Record<string, string> = {
    cash: 'Bar bezahlt',
    card: 'Karte bezahlt',
    sumup_terminal: 'Karte bezahlt',
    sumup_online: 'Online bezahlt',
    paypal: 'PayPal bezahlt',
    google_pay: 'Google Pay bezahlt',
    apple_pay: 'Apple Pay bezahlt',
  };
  return labels[method] || 'Bezahlt';
}

export function formatOptions(item: OrderItem): string[] {
  const selected =
    (
      item.options as {
        selected?: Array<{
          option?: string;
          excluded?: boolean;
          priceModifier?: number;
        }>;
      } | null
    )?.selected ?? [];
  return selected
    .map((o) => {
      const name = o.option ?? '';
      if (!name) return '';
      if (o.excluded) return `ohne ${name}`;
      if (Number(o.priceModifier) > 0) return `+ ${name}`;
      return name;
    })
    .filter(Boolean);
}

/** A reversal (Phase 0) is any payment created to cancel/refund another one, never a plain sale. */
export function isStornoPayment(payment: Payment): boolean {
  return (
    payment.reversesPaymentId !== null &&
    payment.reversesPaymentId !== undefined
  );
}

/**
 * The Pfand sub-line for one OrderItem, or null if it carries no deposit.
 * item.totalPrice deliberately excludes the deposit (see orders.service.ts's
 * item creation: totalPrice = (unitPrice + optionsPrice) * quantity), so
 * this is always additive -- never double-counts what's already in
 * totalPrice.
 */
export function pfandLineAmount(item: OrderItem): number | null {
  const amount = Number(item.depositAmount) * item.quantity;
  return amount > 0 ? amount : null;
}

export interface VatGroup {
  rate: number;
  netto: number;
  ust: number;
  brutto: number;
}

/**
 * Groups an order's items (their totalPrice, i.e. excluding Pfand -- Pfand
 * has its own display and isn't itself subject to the item's rate here)
 * into one row per VAT rate actually used, for the receipt's per-rate
 * breakdown. Replaces the old single "MwSt." total line, which hid which
 * rates actually applied.
 */
export function groupItemsByVatRate(items: OrderItem[]): VatGroup[] {
  const totals = new Map<number, number>();
  for (const item of items) {
    const rate = Number(item.taxRate);
    totals.set(rate, (totals.get(rate) ?? 0) + Number(item.totalPrice));
  }
  return Array.from(totals.entries())
    .sort(([a], [b]) => b - a)
    .map(([rate, brutto]) => {
      const netto = Math.round((brutto / (1 + rate / 100)) * 100) / 100;
      const ust = Math.round((brutto - netto) * 100) / 100;
      return { rate, netto, ust, brutto: Math.round(brutto * 100) / 100 };
    });
}
