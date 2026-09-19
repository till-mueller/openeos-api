import {
  buildCashregisterRow,
  buildLocationRow,
  buildTransactionsTseRow,
  buildVatRows,
  ClosingContext,
} from './dsfinvk-row-builders';
import { UstSchluessel } from '../../common/constants/dsfinvk-ust-schluessel';
import { TseTransactionData } from '../../database/entities/payment.entity';

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
