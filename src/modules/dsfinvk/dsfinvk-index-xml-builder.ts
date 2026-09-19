import { DSFINVK_SCHEMA } from './dsfinvk-schema';

/**
 * Builds index.xml -- the GDPdU manifest describing every CSV in the
 * export, per the exact structure of the vendored gdpdu-01-09-2004.dtd.
 * Format settings (';' delimiter, '\r\n' records, '"' encapsulator, UTF-8,
 * comma decimals) match dsfinvk-csv-writer.ts exactly -- these two files
 * must never drift from each other, since a mismatch would make the ZIP
 * internally inconsistent (index.xml claiming a format the CSVs don't use).
 */
export function buildDsfinvkIndexXml(): string {
  const tables = DSFINVK_SCHEMA.map((table) => {
    const columns = table.columns
      .map((col) => {
        const typeTag =
          col.type === 'numeric'
            ? '<Numeric DecimalChar="."/>'
            : '<AlphaNumeric/>';
        const maxLength =
          col.maxLength !== null
            ? `\n          <MaxLength>${col.maxLength}</MaxLength>`
            : '';
        return `        <VariableColumn>
          <Name>${col.name}</Name>
          ${typeTag}${maxLength}
        </VariableColumn>`;
      })
      .join('\n');
    return `    <Table>
      <URL>${table.file}</URL>
      <Name>${table.tableName}</Name>
      <Description>${table.file}</Description>
      <UTF8/>
      <DecimalSymbol>,</DecimalSymbol>
      <DigitGroupingSymbol>.</DigitGroupingSymbol>
      <Range>
        <From>2</From>
      </Range>
      <VariableLength>
        <ColumnDelimiter>;</ColumnDelimiter>
        <RecordDelimiter>&#xD;&#xA;</RecordDelimiter>
        <TextEncapsulator>"</TextEncapsulator>
${columns}
      </VariableLength>
    </Table>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">
<DataSet>
  <Version>1.0</Version>
  <DataSupplier>
    <Name/>
    <Location/>
    <Comment>Datentraegerueberlassung nach GDPdU vom 12.11.2010</Comment>
  </DataSupplier>
  <Media>
    <Name>DSFinV-K Export</Name>
${tables}
  </Media>
</DataSet>
`;
}
