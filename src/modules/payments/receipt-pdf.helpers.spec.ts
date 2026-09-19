import {
  formatCurrency,
  groupItemsByVatRate,
  isStornoPayment,
  pfandLineAmount,
} from './receipt-pdf.helpers';
import { OrderItem } from '../../database/entities';

describe('formatCurrency', () => {
  it('formats with two decimals and the euro sign', () => {
    expect(formatCurrency(3)).toBe('3.00 €');
    expect(formatCurrency('4.5')).toBe('4.50 €');
  });
});

describe('isStornoPayment', () => {
  it('is true when reversesPaymentId is set', () => {
    expect(isStornoPayment({ reversesPaymentId: 'payment-1' } as any)).toBe(
      true,
    );
  });

  it('is false for a plain sale', () => {
    expect(isStornoPayment({ reversesPaymentId: null } as any)).toBe(false);
  });
});

describe('pfandLineAmount', () => {
  it('returns null when the item carries no deposit', () => {
    expect(
      pfandLineAmount({ depositAmount: 0, quantity: 2 } as OrderItem),
    ).toBeNull();
  });

  it('multiplies per-unit deposit by quantity', () => {
    expect(
      pfandLineAmount({ depositAmount: 2, quantity: 3 } as OrderItem),
    ).toBe(6);
  });
});

describe('groupItemsByVatRate', () => {
  it('sums totalPrice per distinct tax rate, sorted highest rate first', () => {
    const items = [
      { taxRate: 19, totalPrice: 11.9 },
      { taxRate: 7, totalPrice: 10.7 },
      { taxRate: 19, totalPrice: 5.95 },
    ] as OrderItem[];

    const groups = groupItemsByVatRate(items);

    expect(groups).toEqual([
      { rate: 19, brutto: 17.85, netto: 15, ust: 2.85 },
      { rate: 7, brutto: 10.7, netto: 10, ust: 0.7 },
    ]);
  });

  it('returns an empty array for no items', () => {
    expect(groupItemsByVatRate([])).toEqual([]);
  });
});
