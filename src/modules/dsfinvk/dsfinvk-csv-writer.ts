import { DsfinvkColumn, DsfinvkTable } from './dsfinvk-schema';

/**
 * Writes one DSFinV-K CSV per the exact format the reference index.xml
 * declares for every table: ';' column delimiter, '\r\n' record delimiter,
 * '"' text encapsulator, UTF-8, comma decimal separator. This is the
 * opposite of ReportsService.convertToCSV()'s writer (comma-delimited,
 * dot decimals) -- do not reuse that one here, it would produce a file a
 * GDPdU-compliant reader rejects.
 */
const DELIMITER = ';';
const RECORD_DELIMITER = '\r\n';
const ENCAPSULATOR = '"';

export type DsfinvkRow = Record<string, string | number | null | undefined>;

function formatNumeric(value: number): string {
  return value.toString().replace('.', ',');
}

function needsEncapsulation(field: string): boolean {
  return (
    field.includes(DELIMITER) ||
    field.includes(ENCAPSULATOR) ||
    field.includes('\n') ||
    field.includes('\r')
  );
}

function encapsulate(field: string): string {
  if (!needsEncapsulation(field)) return field;
  return (
    ENCAPSULATOR +
    field.replace(new RegExp(ENCAPSULATOR, 'g'), ENCAPSULATOR + ENCAPSULATOR) +
    ENCAPSULATOR
  );
}

function formatCell(
  column: DsfinvkColumn,
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined) return '';
  if (column.type === 'numeric') {
    if (typeof value !== 'number') {
      throw new Error(
        `Column ${column.name} is numeric but got ${typeof value}`,
      );
    }
    return formatNumeric(value);
  }
  const str = String(value);
  if (column.maxLength !== null && str.length > column.maxLength) {
    throw new Error(
      `Column ${column.name} exceeds max length ${column.maxLength}: "${str}"`,
    );
  }
  return encapsulate(str);
}

/**
 * Renders one table's rows to its CSV body, header included, exactly as
 * DSFinV-K expects it -- ready to write to a file inside the export ZIP.
 */
export function writeDsfinvkCsv(
  table: DsfinvkTable,
  rows: DsfinvkRow[],
): string {
  const header = table.columns.map((c) => c.name).join(DELIMITER);
  const lines = rows.map((row) =>
    table.columns.map((c) => formatCell(c, row[c.name])).join(DELIMITER),
  );
  return [header, ...lines].join(RECORD_DELIMITER) + RECORD_DELIMITER;
}
