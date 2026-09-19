/**
 * GV_TYP (Geschaeftsvorfalltyp) per DSFinV-K v2.4 Sec.4.1.3 / Anhang C.
 * Only the "Allgemeine GV-Typen" enum members openEOS can actually produce
 * are here -- see the plan's explicit out-of-scope list (vouchers,
 * Forderungen/Anzahlungen, cash-drawer-only types like Privatentnahme) for
 * why the rest are omitted. Values are the exact German strings the spec
 * requires verbatim in lines.csv's GV_TYP column -- do not translate or
 * reformat them.
 */
export enum GvTyp {
  UMSATZ = 'Umsatz',
  PFAND = 'Pfand',
  PFAND_RUECKZAHLUNG = 'PfandRueckzahlung',
  RABATT = 'Rabatt',
  TRINKGELD_AG = 'TrinkgeldAG',
  TRINKGELD_AN = 'TrinkgeldAN',
}

/**
 * Classifies a single OrderItem line. A refill (isRefill=true) carries no
 * deposit at all, so it's a plain Umsatz line rather than Pfand -- the spec
 * has no "free reuse" GV_TYP, and charging nothing is not a business event.
 */
export function classifyOrderItem(item: { pfandTypeId: string | null; isRefill: boolean }): GvTyp {
  if (item.pfandTypeId && !item.isRefill) return GvTyp.PFAND;
  return GvTyp.UMSATZ;
}

/** A Pfand payout (PfandReturn row) is always PfandRueckzahlung -- never Umsatz. */
export function classifyPfandReturn(): GvTyp {
  return GvTyp.PFAND_RUECKZAHLUNG;
}

/** An Order-level discount, if present, is booked as its own Rabatt line. */
export function classifyDiscount(order: { discountAmount: number }): GvTyp | null {
  return order.discountAmount > 0 ? GvTyp.RABATT : null;
}

/**
 * A tip, if present, is booked as its own line -- which of the two GV_TYPs
 * depends on OrganizationSettings.tipOwnership (a business fact, not
 * something derivable from the order itself). Defaults to TrinkgeldAN
 * (staff keeps it) when unset.
 */
export function classifyTip(
  order: { tipAmount: number },
  tipOwnership: 'staff' | 'business' | undefined,
): GvTyp | null {
  if (!(order.tipAmount > 0)) return null;
  return tipOwnership === 'business' ? GvTyp.TRINKGELD_AG : GvTyp.TRINKGELD_AN;
}
