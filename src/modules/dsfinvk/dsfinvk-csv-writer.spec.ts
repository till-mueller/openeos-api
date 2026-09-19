import { writeDsfinvkCsv } from './dsfinvk-csv-writer';
import { DsfinvkTable } from './dsfinvk-schema';

describe('writeDsfinvkCsv', () => {
  const table: DsfinvkTable = {
    file: 'test.csv',
    tableName: 'Test',
    columns: [
      { name: 'ID', type: 'string', maxLength: 10 },
      { name: 'AMOUNT', type: 'numeric', maxLength: null },
    ],
  };

  it('joins columns with ; and records with \\r\\n, header included', () => {
    const csv = writeDsfinvkCsv(table, [{ ID: 'a1', AMOUNT: 12.5 }]);
    expect(csv).toBe('ID;AMOUNT\r\na1;12,5\r\n');
  });

  it('uses a comma as the decimal separator, never a dot', () => {
    const csv = writeDsfinvkCsv(table, [{ ID: 'a1', AMOUNT: 1234.56 }]);
    expect(csv).toContain('1234,56');
    expect(csv).not.toContain('1234.56');
  });

  it('renders a missing value as an empty field, not "null" or "undefined"', () => {
    const csv = writeDsfinvkCsv(table, [{ ID: 'a1', AMOUNT: null }]);
    expect(csv).toBe('ID;AMOUNT\r\na1;\r\n');
  });

  it('encapsulates a text field containing the delimiter, and escapes embedded quotes', () => {
    const csv = writeDsfinvkCsv(table, [{ ID: 'a;b"c', AMOUNT: 1 }]);
    expect(csv).toContain('"a;b""c"');
  });

  it('rejects a text value that exceeds the schema-declared max length', () => {
    expect(() =>
      writeDsfinvkCsv(table, [{ ID: 'x'.repeat(11), AMOUNT: 1 }]),
    ).toThrow(/exceeds max length/);
  });

  it('rejects a non-numeric value in a numeric column', () => {
    expect(() =>
      writeDsfinvkCsv(table, [
        { ID: 'a1', AMOUNT: 'oops' as unknown as number },
      ]),
    ).toThrow(/numeric/);
  });
});
