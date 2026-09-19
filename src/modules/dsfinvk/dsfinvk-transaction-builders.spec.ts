import {
  buildDatapaymentRow,
  buildLinesRows,
  buildLinesVatRow,
  buildReferenceRow,
  buildTransactionsRow,
  buildTransactionsVatRows,
} from './dsfinvk-transaction-builders';
import { UstSchluessel } from '../../common/constants/dsfinvk-ust-schluessel';
import { PaymentMethod } from '../../database/entities/payment.entity';
import { GvTyp } from './gv-typ';
import { ClosingContext } from './dsfinvk-row-builders';

const ctx: ClosingContext = {
  kasseId: 'device-1',
  erstellung: '2026-09-19T10:00:00+02:00',
  zNr: 1,
};

describe('buildTransactionsRow', () => {
  it('always uses BON_TYP "Beleg" -- the only Vorgangstyp openEOS signs', () => {
    const row = buildTransactionsRow(ctx, {
      bonId: 'order-1',
      bonNr: 5,
      isStorno: false,
      terminalId: 'device-1',
      bonStart: '2026-09-19T10:00:00Z',
      bonEnde: '2026-09-19T10:01:00Z',
      bedienerId: 'user-1',
      bedienerName: 'Anna',
      umsBrutto: 25.5,
    });
    expect(row.BON_TYP).toBe('Beleg');
    expect(row.BON_STORNO).toBe('0');
    expect(row.UMS_BRUTTO).toBe(25.5);
  });

  it('marks a reversal Vorgang with BON_STORNO=1 while leaving BON_TYP as Beleg', () => {
    const row = buildTransactionsRow(ctx, {
      bonId: 'payment-reversal-1',
      bonNr: 6,
      isStorno: true,
      terminalId: 'device-1',
      bonStart: '2026-09-19T11:00:00Z',
      bonEnde: '2026-09-19T11:00:01Z',
      bedienerId: 'user-1',
      bedienerName: 'Anna',
      umsBrutto: -25.5,
    });
    expect(row.BON_STORNO).toBe('1');
    expect(row.BON_TYP).toBe('Beleg');
    expect(row.UMS_BRUTTO).toBe(-25.5);
  });
});

describe('buildTransactionsVatRows', () => {
  it('splits a Vorgang total by UST_SCHLUESSEL into netto/UST', () => {
    const rows = buildTransactionsVatRows(ctx, 'order-1', [
      { ustSchluessel: UstSchluessel.ALLGEMEIN, ustSatz: 19, brutto: 119 },
      { ustSchluessel: UstSchluessel.ERMAESSIGT, ustSatz: 7, brutto: 10.7 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          UST_SCHLUESSEL: UstSchluessel.ALLGEMEIN,
          BON_BRUTTO: 119,
          BON_NETTO: 100,
          BON_UST: 19,
        }),
        expect.objectContaining({
          UST_SCHLUESSEL: UstSchluessel.ERMAESSIGT,
          BON_BRUTTO: 10.7,
          BON_NETTO: 10,
          BON_UST: 0.7,
        }),
      ]),
    );
  });
});

describe('buildDatapaymentRow', () => {
  it('mirrors ZAHLWAEH_BETRAG into BASISWAEH_BETRAG -- openEOS is EUR-only', () => {
    const row = buildDatapaymentRow(
      ctx,
      'order-1',
      { paymentMethod: PaymentMethod.CASH, amount: 20 },
      'Bar',
      'Bar',
    );
    expect(row.ZAHLWAEH_CODE).toBe('EUR');
    expect(row.ZAHLWAEH_BETRAG).toBe(20);
    expect(row.BASISWAEH_BETRAG).toBe(20);
  });
});

describe('buildLinesRows', () => {
  it('produces a single Umsatz row for a plain product with no Pfand', () => {
    const rows = buildLinesRows(ctx, 'order-1', {
      posZeile: '1',
      productName: 'Bier',
      productId: 'prod-1',
      categoryId: 'cat-1',
      categoryName: 'Getraenke',
      quantity: 2,
      unitGrossPrice: 3.5,
      taxRate: 19,
      ustSchluessel: UstSchluessel.ALLGEMEIN,
      depositAmount: 0,
      isRefill: false,
      isStorno: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        GV_TYP: GvTyp.UMSATZ,
        MENGE: 2,
        STK_BR: 3.5,
        ARTIKELTEXT: 'Bier',
      }),
    );
  });

  it('splits a deposit-bearing product into its own Umsatz row plus a separate Pfand row', () => {
    const rows = buildLinesRows(ctx, 'order-1', {
      posZeile: '1',
      productName: 'Bier im Becher',
      productId: 'prod-1',
      categoryId: 'cat-1',
      categoryName: 'Getraenke',
      quantity: 2,
      unitGrossPrice: 3.5,
      taxRate: 19,
      ustSchluessel: UstSchluessel.ALLGEMEIN,
      depositAmount: 2,
      isRefill: false,
      isStorno: false,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].GV_TYP).toBe(GvTyp.UMSATZ);
    expect(rows[1]).toEqual(
      expect.objectContaining({
        GV_TYP: GvTyp.PFAND,
        ARTIKELTEXT: 'Pfand',
        STK_BR: 2,
      }),
    );
  });

  it('does not charge Pfand again on a refill, even if a deposit amount is technically set', () => {
    const rows = buildLinesRows(ctx, 'order-1', {
      posZeile: '1',
      productName: 'Nachfuellen',
      productId: 'prod-1',
      categoryId: 'cat-1',
      categoryName: 'Getraenke',
      quantity: 1,
      unitGrossPrice: 3.5,
      taxRate: 19,
      ustSchluessel: UstSchluessel.ALLGEMEIN,
      depositAmount: 2,
      isRefill: true,
      isStorno: false,
    });
    expect(rows).toHaveLength(1);
  });
});

describe('buildLinesVatRow', () => {
  it('splits a single line into netto/UST -- always exactly one row, never a fan-out', () => {
    const row = buildLinesVatRow(
      ctx,
      'order-1',
      '1',
      UstSchluessel.ALLGEMEIN,
      11.9,
      19,
    );
    expect(row).toEqual(
      expect.objectContaining({
        POS_BRUTTO: 11.9,
        POS_NETTO: 10,
        POS_UST: 1.9,
      }),
    );
  });
});

describe('buildReferenceRow', () => {
  it('references the original Vorgang with REF_TYP "Transaktion"', () => {
    const row = buildReferenceRow(ctx, 'payment-reversal-1', {
      bonId: 'order-1',
      kasseId: 'device-1',
      zNr: 1,
      erstellung: '2026-09-19T10:00:00+02:00',
    });
    expect(row).toEqual(
      expect.objectContaining({
        BON_ID: 'payment-reversal-1',
        REF_TYP: 'Transaktion',
        REF_BON_ID: 'order-1',
        REF_Z_KASSE_ID: 'device-1',
        REF_Z_NR: 1,
      }),
    );
  });
});
