import { UstSchluessel } from '../../common/constants/dsfinvk-ust-schluessel';
import { PaymentMethod } from '../../database/entities/payment.entity';
import { GvTyp } from './gv-typ';
import { DsfinvkRow } from './dsfinvk-csv-writer';
import { ClosingContext } from './dsfinvk-row-builders';

function closingKey(
  ctx: ClosingContext,
): Pick<DsfinvkRow, 'Z_KASSE_ID' | 'Z_ERSTELLUNG' | 'Z_NR'> {
  return {
    Z_KASSE_ID: ctx.kasseId,
    Z_ERSTELLUNG: ctx.erstellung,
    Z_NR: ctx.zNr,
  };
}

function splitBruttoBySatz(
  brutto: number,
  ustSatz: number,
): { netto: number; ust: number } {
  const netto = Math.round((brutto / (1 + ustSatz / 100)) * 100) / 100;
  const ust = Math.round((brutto - netto) * 100) / 100;
  return { netto, ust };
}

/**
 * One "Vorgang" (Beleg) -- either an Order, or the Phase 0 reversal of one.
 * A reversal is its OWN Vorgang with its own BON_ID, per the spec's
 * explicit instruction (page 84-85 of the v2.4 PDF): a TSE-protected system
 * cannot flip AVBelegstorno on the original, it must create "einen zweiten
 * Datensatz, der mit umgekehrten Vorzeichen die Beträge des ersten
 * Datensatzes rechnerisch wieder ausgleicht" with BON_STORNO=1, while "Der
 * Ursprungsbeleg (erster Datensatz) bleibt unveraendert." Phase 0's
 * reversal Payment.id is the natural BON_ID for that second Vorgang --
 * openEOS has no separate "reversal order" entity, and doesn't need one.
 */
export interface VorgangInput {
  bonId: string;
  bonNr: number;
  isStorno: boolean;
  /** Device whose clientId was actually used to sign this Vorgang's TSE transaction, if any. */
  terminalId: string | null;
  bonStart: string;
  bonEnde: string;
  bedienerId: string | null;
  bedienerName: string;
  /** Gross total for this Vorgang. Negative for a reversal. */
  umsBrutto: number;
  notiz?: string;
}

/**
 * transactions.csv (Bonkopf): BON_TYP is always "Beleg" -- the only
 * Vorgangstyp openEOS's TSE integration ever signs (Kassenbeleg-V1). No
 * KUNDE_* fields are populated in v1 -- openEOS doesn't collect full
 * customer address/UStID at the till (that's Bewirtungsbeleg territory,
 * tracked separately).
 */
export function buildTransactionsRow(
  ctx: ClosingContext,
  input: VorgangInput,
): DsfinvkRow {
  return {
    ...closingKey(ctx),
    BON_ID: input.bonId,
    BON_NR: input.bonNr,
    BON_TYP: 'Beleg',
    BON_NAME: '',
    TERMINAL_ID: input.terminalId ?? '',
    BON_STORNO: input.isStorno ? '1' : '0',
    BON_START: input.bonStart,
    BON_ENDE: input.bonEnde,
    BEDIENER_ID: input.bedienerId ?? '',
    BEDIENER_NAME: input.bedienerName,
    UMS_BRUTTO: input.umsBrutto,
    KUNDE_NAME: '',
    KUNDE_ID: '',
    KUNDE_TYP: '',
    KUNDE_STRASSE: '',
    KUNDE_PLZ: '',
    KUNDE_ORT: '',
    KUNDE_LAND: '',
    KUNDE_USTID: '',
    BON_NOTIZ: input.notiz ?? '',
  };
}

export interface VatSplitLine {
  ustSchluessel: UstSchluessel;
  ustSatz: number;
  brutto: number;
}

/** transactions_vat.csv: this Vorgang's total split by UST_SCHLUESSEL, one row per rate actually used. */
export function buildTransactionsVatRows(
  ctx: ClosingContext,
  bonId: string,
  lines: VatSplitLine[],
): DsfinvkRow[] {
  const totals = new Map<UstSchluessel, { ustSatz: number; brutto: number }>();
  for (const line of lines) {
    const existing = totals.get(line.ustSchluessel);
    if (existing) existing.brutto += line.brutto;
    else
      totals.set(line.ustSchluessel, {
        ustSatz: line.ustSatz,
        brutto: line.brutto,
      });
  }
  return Array.from(totals.entries()).map(
    ([ustSchluessel, { ustSatz, brutto }]) => {
      const { netto, ust } = splitBruttoBySatz(brutto, ustSatz);
      return {
        ...closingKey(ctx),
        BON_ID: bonId,
        UST_SCHLUESSEL: ustSchluessel,
        BON_BRUTTO: Math.round(brutto * 100) / 100,
        BON_NETTO: netto,
        BON_UST: ust,
      };
    },
  );
}

/** datapayment.csv: one row per Payment against this Vorgang. openEOS is EUR-only, so ZAHLWAEH_BETRAG === BASISWAEH_BETRAG always. */
export function buildDatapaymentRow(
  ctx: ClosingContext,
  bonId: string,
  payment: { paymentMethod: PaymentMethod; amount: number },
  zahlartTyp: string,
  zahlartName: string,
): DsfinvkRow {
  return {
    ...closingKey(ctx),
    BON_ID: bonId,
    ZAHLART_TYP: zahlartTyp,
    ZAHLART_NAME: zahlartName,
    ZAHLWAEH_CODE: 'EUR',
    ZAHLWAEH_BETRAG: payment.amount,
    BASISWAEH_BETRAG: payment.amount,
  };
}

export interface OrderItemLineInput {
  posZeile: string;
  productName: string;
  productId: string;
  categoryId: string;
  categoryName: string;
  quantity: number;
  /** Per-unit gross price, excluding any Pfand -- unitPrice + optionsPrice. */
  unitGrossPrice: number;
  taxRate: number;
  ustSchluessel: UstSchluessel;
  /** Per-unit deposit amount, 0 when no Pfand or when refilling (see gv-typ.ts's classifyOrderItem). */
  depositAmount: number;
  isRefill: boolean;
  isStorno: boolean;
}

/**
 * lines.csv (Bonpos): one OrderItem can produce TWO rows, not one -- the
 * product itself (GV_TYP Umsatz) and, if it carries a deposit, a second
 * Pfand row for the deposit portion. DSFinV-K's businesscases.csv expects
 * Pfand and Umsatz as genuinely separate business cases (see gv-typ.ts), so
 * folding the deposit into the product's own line would misclassify it.
 *
 * INHAUS defaults to "1" (on-premises) regardless of fulfillmentType --
 * openEOS's TABLE_SERVICE/COUNTER_PICKUP distinguishes ordering flow, not
 * whether the guest actually leaves the venue, and at a typical
 * Verein/event venue counter pickup is still consumed on-site. NOT
 * verified against a real off-premises use case -- flag if openEOS ever
 * adds actual takeaway/delivery.
 */
export function buildLinesRows(
  ctx: ClosingContext,
  bonId: string,
  input: OrderItemLineInput,
): DsfinvkRow[] {
  const rows: DsfinvkRow[] = [];
  rows.push({
    ...closingKey(ctx),
    BON_ID: bonId,
    POS_ZEILE: input.posZeile,
    GUTSCHEIN_NR: '',
    ARTIKELTEXT: input.productName,
    POS_TERMINAL_ID: '',
    GV_TYP: GvTyp.UMSATZ,
    GV_NAME: '',
    INHAUS: '1',
    P_STORNO: input.isStorno ? '1' : '0',
    AGENTUR_ID: 0,
    ART_NR: input.productId,
    GTIN: '',
    WARENGR_ID: input.categoryId,
    WARENGR: input.categoryName,
    MENGE: input.quantity,
    FAKTOR: 1,
    EINHEIT: 'Stk',
    STK_BR: input.unitGrossPrice,
  });
  if (input.depositAmount > 0 && !input.isRefill) {
    rows.push({
      ...closingKey(ctx),
      BON_ID: bonId,
      POS_ZEILE: `${input.posZeile}-pfand`,
      GUTSCHEIN_NR: '',
      ARTIKELTEXT: 'Pfand',
      POS_TERMINAL_ID: '',
      GV_TYP: GvTyp.PFAND,
      GV_NAME: '',
      INHAUS: '1',
      P_STORNO: input.isStorno ? '1' : '0',
      AGENTUR_ID: 0,
      ART_NR: input.productId,
      GTIN: '',
      WARENGR_ID: input.categoryId,
      WARENGR: input.categoryName,
      MENGE: input.quantity,
      FAKTOR: 1,
      EINHEIT: 'Stk',
      STK_BR: input.depositAmount,
    });
  }
  return rows;
}

/** lines_vat.csv: each lines.csv row has exactly one VAT rate, so this is always a 1:1 split -- never multiple rows per line. */
export function buildLinesVatRow(
  ctx: ClosingContext,
  bonId: string,
  posZeile: string,
  ustSchluessel: UstSchluessel,
  brutto: number,
  ustSatz: number,
): DsfinvkRow {
  const { netto, ust } = splitBruttoBySatz(brutto, ustSatz);
  return {
    ...closingKey(ctx),
    BON_ID: bonId,
    POS_ZEILE: posZeile,
    UST_SCHLUESSEL: ustSchluessel,
    POS_BRUTTO: Math.round(brutto * 100) / 100,
    POS_NETTO: netto,
    POS_UST: ust,
  };
}

/**
 * references.csv: links a Phase 0 reversal Vorgang back to the original it
 * cancels. REF_TYP "Transaktion" is the only enum member relevant here --
 * it means "references another Vorgang inside this DSFinV-K export", as
 * opposed to the other three enum values (ExterneRechnung/
 * ExternerLieferschein/ExterneSonstige), which reference something outside
 * the till entirely and don't apply to a same-system reversal.
 */
export function buildReferenceRow(
  ctx: ClosingContext,
  reversalBonId: string,
  original: { bonId: string; kasseId: string; zNr: number; erstellung: string },
): DsfinvkRow {
  return {
    ...closingKey(ctx),
    BON_ID: reversalBonId,
    POS_ZEILE: '',
    REF_TYP: 'Transaktion',
    REF_NAME: '',
    REF_DATUM: original.erstellung,
    REF_Z_KASSE_ID: original.kasseId,
    REF_Z_NR: original.zNr,
    REF_BON_ID: original.bonId,
  };
}
