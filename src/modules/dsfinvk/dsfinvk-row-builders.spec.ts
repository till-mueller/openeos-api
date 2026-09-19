import {
  buildCashPerCurrencyRow,
  buildCashregisterRow,
  buildLocationRow,
  buildPaymentRows,
  buildTransactionsTseRow,
  buildVatRows,
  ClosingContext,
} from './dsfinvk-row-builders';
import { UstSchluessel } from '../../common/constants/dsfinvk-ust-schluessel';
import {
  PaymentMethod,
  TseTransactionData,
} from '../../database/entities/payment.entity';

const ctx: ClosingContext = {
  kasseId: 'device-1',
  erstellung: '2026-09-19T10:00:00+02:00',
  zNr: 1,
};

describe('buildLocationRow', () => {
  it('converts an alpha-2 country to the ISO 3166 ALPHA-3 code DSFinV-K requires', () => {
    const row = buildLocationRow(ctx, {
      name: 'Verein e.V.',
      settings: {
        address: {
          street: 'Hauptstr. 1',
          city: 'Berlin',
          zip: '10115',
          country: 'DE',
        },
        taxId: 'DE123456789',
      } as any,
    });
    expect(row.LOC_LAND).toBe('DEU');
    expect(row.LOC_NAME).toBe('Verein e.V.');
    expect(row.LOC_USTID).toBe('DE123456789');
  });

  it('falls back to DEU when no address is set at all', () => {
    const row = buildLocationRow(ctx, {
      name: 'Verein e.V.',
      settings: {} as any,
    });
    expect(row.LOC_LAND).toBe('DEU');
  });
});

describe('buildCashregisterRow', () => {
  it('always reports EUR and no deferred-VAT flag -- openEOS has no invoicing feature', () => {
    const row = buildCashregisterRow(ctx, {
      settings: { kasseBrand: 'Sunmi', kasseModell: 'T3' } as any,
    });
    expect(row.KASSE_BASISWAEH_CODE).toBe('EUR');
    expect(row.KEINE_UST_ZUORDNUNG).toBe('0');
    expect(row.KASSE_BRAND).toBe('Sunmi');
  });
});

describe('buildVatRows', () => {
  it('lists all normal-rate DE rates with their UST_SCHLUESSEL', () => {
    const rows = buildVatRows(
      ctx,
      { settings: { vatExempt: false } as any },
      'DE',
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          UST_SATZ: 19,
          UST_SCHLUESSEL: UstSchluessel.ALLGEMEIN,
        }),
        expect.objectContaining({
          UST_SATZ: 7,
          UST_SCHLUESSEL: UstSchluessel.ERMAESSIGT,
        }),
      ]),
    );
  });

  it('collapses a vatExempt org to a single 0% row', () => {
    const rows = buildVatRows(
      ctx,
      { settings: { vatExempt: true } as any },
      'DE',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        UST_SATZ: 0,
        UST_SCHLUESSEL: UstSchluessel.UMSATZSTEUERFREI,
      }),
    );
  });
});

describe('buildPaymentRows', () => {
  it('sums each PaymentMethod into its ZAHLART_TYP bucket', () => {
    const rows = buildPaymentRows(ctx, [
      { paymentMethod: PaymentMethod.CASH, amount: 20 },
      { paymentMethod: PaymentMethod.CASH, amount: 5 },
      { paymentMethod: PaymentMethod.SUMUP_TERMINAL, amount: 10 },
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ZAHLART_TYP: 'Bar', Z_ZAHLART_BETRAG: 25 }),
        expect.objectContaining({ ZAHLART_TYP: 'Unbar', Z_ZAHLART_BETRAG: 10 }),
      ]),
    );
  });

  it('collapses CARD and SUMUP_TERMINAL onto the same Unbar row -- openEOS cannot tell EC from credit', () => {
    const rows = buildPaymentRows(ctx, [
      { paymentMethod: PaymentMethod.CARD, amount: 15 },
      { paymentMethod: PaymentMethod.SUMUP_TERMINAL, amount: 10 },
    ]);
    const unbar = rows.filter((r) => r.ZAHLART_TYP === 'Unbar');
    expect(unbar).toHaveLength(1);
    expect(unbar[0].Z_ZAHLART_BETRAG).toBe(25);
  });

  it('maps every digital-wallet method to ElZahlungsdienstleister', () => {
    const rows = buildPaymentRows(ctx, [
      { paymentMethod: PaymentMethod.PAYPAL, amount: 5 },
      { paymentMethod: PaymentMethod.GOOGLE_PAY, amount: 3 },
      { paymentMethod: PaymentMethod.APPLE_PAY, amount: 2 },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        ZAHLART_TYP: 'ElZahlungsdienstleister',
        Z_ZAHLART_BETRAG: 10,
      }),
    ]);
  });
});

describe('buildCashPerCurrencyRow', () => {
  it('sums only cash payments into a single EUR row', () => {
    const row = buildCashPerCurrencyRow(ctx, [
      { paymentMethod: PaymentMethod.CASH, amount: 20 },
      { paymentMethod: PaymentMethod.CARD, amount: 100 },
      { paymentMethod: PaymentMethod.CASH, amount: 5 },
    ]);
    expect(row).toEqual(
      expect.objectContaining({ ZAHLART_WAEH: 'EUR', ZAHLART_BETRAG_WAEH: 25 }),
    );
  });

  it('produces a zero row when there were no cash payments at all', () => {
    const row = buildCashPerCurrencyRow(ctx, [
      { paymentMethod: PaymentMethod.CARD, amount: 100 },
    ]);
    expect(row.ZAHLART_BETRAG_WAEH).toBe(0);
  });
});

describe('buildTransactionsTseRow', () => {
  it('maps Payment.tseData fields directly onto the TSE_* columns', () => {
    const tseData: TseTransactionData = {
      provider: 'fiskaly',
      clientId: 'device-1',
      transactionNumber: 42,
      serialNumber: 'SN',
      signatureCounter: 7,
      signatureValue: 'sig-value',
      signatureAlgorithm: 'algo',
      startTime: '2026-09-19T10:00:00Z',
      endTime: '2026-09-19T10:00:01Z',
      processType: 'Kassenbeleg-V1',
      processData: 'Beleg^10.00_...^10.00:Bar',
      qrCodeData: 'qr',
      failed: false,
    };

    const row = buildTransactionsTseRow(ctx, 'bon-1', tseData);

    expect(row).toEqual(
      expect.objectContaining({
        BON_ID: 'bon-1',
        TSE_ID: 1,
        TSE_TANR: 42,
        TSE_TA_SIGZ: 7,
        TSE_TA_SIG: 'sig-value',
        TSE_VORGANGSDATEN: 'Beleg^10.00_...^10.00:Bar',
        TSE_TA_FEHLER: '',
      }),
    );
  });
});
