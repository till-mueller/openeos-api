import {
  splitsFromItems,
  splitsFromItemPayments,
  allocateToAmount,
  negateSplits,
} from './vat-split';

describe('vat-split', () => {
  describe('splitsFromItems', () => {
    it('groups gross amounts by tax rate', () => {
      const splits = splitsFromItems([
        { quantity: 2, unitPrice: 10, optionsPrice: 0.5, taxRate: 19 },
        { quantity: 1, unitPrice: 5, optionsPrice: 0, taxRate: 7 },
        { quantity: 3, unitPrice: 2, optionsPrice: 0, taxRate: 19 },
      ]);
      expect(splits).toEqual([
        { rate: 19, grossAmount: 27 },
        { rate: 7, grossAmount: 5 },
      ]);
    });

    it('returns [] for no items', () => {
      expect(splitsFromItems([])).toEqual([]);
    });
  });

  describe('splitsFromItemPayments', () => {
    it('groups exact payment rows by rate', () => {
      const splits = splitsFromItemPayments([
        { amount: 21, taxRate: 19 },
        { amount: 5, taxRate: 7 },
        { amount: 4.2, taxRate: 19 },
      ]);
      expect(splits).toEqual([
        { rate: 19, grossAmount: 25.2 },
        { rate: 7, grossAmount: 5 },
      ]);
    });
  });

  describe('allocateToAmount', () => {
    it('scales proportionally and keeps the exact cent sum', () => {
      const result = allocateToAmount(
        [
          { rate: 19, grossAmount: 10 },
          { rate: 7, grossAmount: 10 },
          { rate: 0, grossAmount: 10 },
        ],
        10,
      );
      const sum = result.reduce((s, r) => s + r.grossAmount, 0);
      expect(Math.round(sum * 100)).toBe(1000);
      expect(result.find((r) => r.rate === 19)!.grossAmount).toBeCloseTo(
        3.33,
        2,
      );
    });

    it('identity-allocates when target equals the split sum', () => {
      const result = allocateToAmount(
        [
          { rate: 19, grossAmount: 27 },
          { rate: 7, grossAmount: 5 },
        ],
        32,
      );
      expect(result).toEqual([
        { rate: 19, grossAmount: 27 },
        { rate: 7, grossAmount: 5 },
      ]);
    });

    it('handles negative targets (reversals)', () => {
      const result = allocateToAmount([{ rate: 19, grossAmount: -27 }], -27);
      expect(result).toEqual([{ rate: 19, grossAmount: -27 }]);
    });

    it('drops zero-amount splits and handles a single split', () => {
      expect(
        allocateToAmount(
          [
            { rate: 19, grossAmount: 0 },
            { rate: 7, grossAmount: 5 },
          ],
          2.5,
        ),
      ).toEqual([{ rate: 7, grossAmount: 2.5 }]);
    });
  });

  describe('negateSplits', () => {
    it('flips every amount', () => {
      expect(
        negateSplits([
          { rate: 19, grossAmount: 27 },
          { rate: 7, grossAmount: 5 },
        ]),
      ).toEqual([
        { rate: 19, grossAmount: -27 },
        { rate: 7, grossAmount: -5 },
      ]);
    });
  });
});
