import { buildDsfinvkIndexXml } from './dsfinvk-index-xml-builder';
import { DSFINVK_SCHEMA } from './dsfinvk-schema';

describe('buildDsfinvkIndexXml', () => {
  const xml = buildDsfinvkIndexXml();

  it('declares the GDPdU DTD doctype', () => {
    expect(xml).toContain('<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">');
  });

  it('lists every table from DSFINVK_SCHEMA, not a hardcoded subset', () => {
    for (const table of DSFINVK_SCHEMA) {
      expect(xml).toContain(`<URL>${table.file}</URL>`);
    }
  });

  it('declares the exact format dsfinvk-csv-writer.ts actually uses', () => {
    expect(xml).toContain('<ColumnDelimiter>;</ColumnDelimiter>');
    expect(xml).toContain('<DecimalSymbol>,</DecimalSymbol>');
    expect(xml).toContain('<TextEncapsulator>"</TextEncapsulator>');
  });

  it('lists every column of a known table with the correct type tag', () => {
    expect(xml).toContain('<Name>UST_SCHLUESSEL</Name>');
    expect(xml).toMatch(/<Name>UST_SCHLUESSEL<\/Name>\s*<Numeric/);
    expect(xml).toMatch(/<Name>LOC_NAME<\/Name>\s*<AlphaNumeric/);
  });
});
