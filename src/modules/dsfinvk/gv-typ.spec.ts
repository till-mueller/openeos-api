import {
  GvTyp,
  classifyDiscount,
  classifyOrderItem,
  classifyPfandReturn,
  classifyTip,
} from './gv-typ';

describe('classifyOrderItem', () => {
  it('classifies a plain product line as Umsatz', () => {
    expect(classifyOrderItem({ pfandTypeId: null, isRefill: false })).toBe(
      GvTyp.UMSATZ,
    );
  });

  it('classifies a deposit-bearing line as Pfand', () => {
    expect(classifyOrderItem({ pfandTypeId: 'pt-1', isRefill: false })).toBe(
      GvTyp.PFAND,
    );
  });

  it('classifies a refill (no deposit charged) as Umsatz, not Pfand', () => {
    expect(classifyOrderItem({ pfandTypeId: 'pt-1', isRefill: true })).toBe(
      GvTyp.UMSATZ,
    );
  });
});

describe('classifyPfandReturn', () => {
  it('is always PfandRueckzahlung', () => {
    expect(classifyPfandReturn()).toBe(GvTyp.PFAND_RUECKZAHLUNG);
  });
});

describe('classifyDiscount', () => {
  it('returns Rabatt when a discount was applied', () => {
    expect(classifyDiscount({ discountAmount: 5 })).toBe(GvTyp.RABATT);
  });

  it('returns null when there is no discount', () => {
    expect(classifyDiscount({ discountAmount: 0 })).toBeNull();
  });
});

describe('classifyTip', () => {
  it('defaults an unset tipOwnership to TrinkgeldAN', () => {
    expect(classifyTip({ tipAmount: 5 }, undefined)).toBe(GvTyp.TRINKGELD_AN);
  });

  it('maps staff ownership to TrinkgeldAN', () => {
    expect(classifyTip({ tipAmount: 5 }, 'staff')).toBe(GvTyp.TRINKGELD_AN);
  });

  it('maps business ownership to TrinkgeldAG', () => {
    expect(classifyTip({ tipAmount: 5 }, 'business')).toBe(GvTyp.TRINKGELD_AG);
  });

  it('returns null when there is no tip', () => {
    expect(classifyTip({ tipAmount: 0 }, 'staff')).toBeNull();
  });
});
