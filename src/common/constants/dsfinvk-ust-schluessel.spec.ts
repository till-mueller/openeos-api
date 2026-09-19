import { UstSchluessel, ustSchluesselFor } from './dsfinvk-ust-schluessel';

describe('ustSchluesselFor', () => {
  it('maps 19% on a normal-rate org to ALLGEMEIN', () => {
    expect(ustSchluesselFor(19, false)).toBe(UstSchluessel.ALLGEMEIN);
  });

  it('maps 7% on a normal-rate org to ERMAESSIGT', () => {
    expect(ustSchluesselFor(7, false)).toBe(UstSchluessel.ERMAESSIGT);
  });

  it('maps a vatExempt org straight to UMSATZSTEUERFREI, regardless of the numeric rate', () => {
    expect(ustSchluesselFor(0, true)).toBe(UstSchluessel.UMSATZSTEUERFREI);
    expect(ustSchluesselFor(19, true)).toBe(UstSchluessel.UMSATZSTEUERFREI);
  });

  it('refuses to invent an ID for a rate it has no legal mapping for', () => {
    expect(() => ustSchluesselFor(0, false)).toThrow(/No UST_SCHLUESSEL mapping/);
    expect(() => ustSchluesselFor(21, false)).toThrow(/No UST_SCHLUESSEL mapping/);
  });
});
