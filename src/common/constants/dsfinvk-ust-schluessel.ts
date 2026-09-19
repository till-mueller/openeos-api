/**
 * UST_SCHLUESSEL registry per the official DSFinV-K Anlage 2 (Stand
 * 05.12.2024). Only the IDs openEOS can actually produce today are listed —
 * do not add historical-rate IDs (11/12/21/22/...) speculatively; a wrong ID
 * on a real export is worse than a missing one.
 *
 * openEOS only ever asks for 19%, 7%, or 0% (see tax-rates.ts) and never
 * implements a §24 Durchschnittssatz (farm/forestry flat rate), so only the
 * "current rate" containers apply: 1 (allgemein), 2 (ermaessigt), and one of
 * the 0%-family IDs.
 */
export enum UstSchluessel {
  ALLGEMEIN = 1,
  ERMAESSIGT = 2,
  NICHT_STEUERBAR = 5,
  UMSATZSTEUERFREI = 6,
  NICHT_ERMITTELBAR = 7,
}

/**
 * Resolves a product's tax rate + the organization's vatExempt flag to the
 * UST_SCHLUESSEL DSFinV-K requires.
 *
 * The 0% case is legally ambiguous on its own -- Anlage 2 splits it into
 * three distinct IDs ("Nicht Steuerbar" / "Umsatzsteuerfrei" /
 * "UmsatzsteuerNichtErmittelbar") -- and openEOS can reach it two different
 * ways: an org with vatExempt=true (Sec.19 UStG Kleinunternehmerregelung),
 * where UMSATZSTEUERFREI (6) is the ID commonly used in practice; or a
 * normal-rate (non-exempt) org that still offers 0% as a selectable product
 * rate (see tax-rates.ts's TAX_RATES_BY_COUNTRY.DE, which lists 0 alongside
 * 19/7 for every org, not just exempt ones) -- e.g. a genuinely
 * zero-rated/out-of-scope line sold by an otherwise taxable business.
 * NICHT_STEUERBAR (5) is used for that second case as the least-wrong
 * default. NEITHER mapping is independently verified against a
 * Steuerberater -- flag both in the Phase 3 review before treating an
 * export as final.
 */
export function ustSchluesselFor(
  rate: number,
  vatExempt: boolean | undefined,
): UstSchluessel {
  if (vatExempt) return UstSchluessel.UMSATZSTEUERFREI;
  if (rate === 19) return UstSchluessel.ALLGEMEIN;
  if (rate === 7) return UstSchluessel.ERMAESSIGT;
  if (rate === 0) return UstSchluessel.NICHT_STEUERBAR;
  throw new Error(
    `No UST_SCHLUESSEL mapping for tax rate ${rate} (vatExempt=${vatExempt})`,
  );
}
