import { buildDsfinvkZip } from './dsfinvk-zip-builder';

describe('buildDsfinvkZip', () => {
  it('produces a non-empty ZIP archive with the requested filename', async () => {
    const result = await buildDsfinvkZip(
      { 'vat.csv': 'UST_SCHLUESSEL;UST_SATZ\r\n1;19\r\n' },
      'dsfinvk-export.zip',
    );
    expect(result.filename).toBe('dsfinvk-export.zip');
    expect(result.data.length).toBeGreaterThan(0);
    // ZIP local file header magic number.
    expect(result.data.subarray(0, 2).toString('hex')).toBe('504b');
  });

  it('bundles multiple CSVs without throwing', async () => {
    const result = await buildDsfinvkZip(
      {
        'vat.csv': 'A;B\r\n1;2\r\n',
        'location.csv': 'C;D\r\n3;4\r\n',
      },
      'export.zip',
    );
    expect(result.data.length).toBeGreaterThan(0);
  });
});
