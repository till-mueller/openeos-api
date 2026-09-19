import { DSFINVK_SCHEMA, dsfinvkTable } from './dsfinvk-schema';

describe('DSFINVK_SCHEMA', () => {
  it('has all 20 tables from the official reference index.xml', () => {
    expect(DSFINVK_SCHEMA).toHaveLength(20);
  });

  it('exposes vat.csv with exactly the columns the export generator will need', () => {
    expect(dsfinvkTable('vat.csv').columns.map((c) => c.name)).toEqual([
      'Z_KASSE_ID',
      'Z_ERSTELLUNG',
      'Z_NR',
      'UST_SCHLUESSEL',
      'UST_SATZ',
      'UST_BESCHR',
    ]);
  });

  it('exposes cashregister.csv with the KASSE_* hardware fields', () => {
    const names = dsfinvkTable('cashregister.csv').columns.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['KASSE_BRAND', 'KASSE_MODELL', 'KASSE_SERIENNR', 'KASSE_SW_BRAND', 'KASSE_SW_VERSION']),
    );
  });

  it('throws on an unknown table name rather than returning undefined', () => {
    expect(() => dsfinvkTable('nonexistent.csv')).toThrow(/Unknown DSFinV-K table/);
  });
});
