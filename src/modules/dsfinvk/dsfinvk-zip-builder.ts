import archiver from 'archiver';
import { GDPDU_DTD } from './gdpdu-dtd';
import { buildDsfinvkIndexXml } from './dsfinvk-index-xml-builder';

export interface DsfinvkExportArchive {
  data: Buffer;
  filename: string;
}

/**
 * Bundles the generated CSVs plus index.xml and the GDPdU DTD into one ZIP
 * -- mirroring TseService.exportData's { data: Buffer, filename } shape so
 * the eventual controller can serve both the same way.
 */
export function buildDsfinvkZip(
  csvFiles: Record<string, string>,
  filename: string,
): Promise<DsfinvkExportArchive> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];

    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);
    archive.on('end', () => resolve({ data: Buffer.concat(chunks), filename }));

    archive.append(buildDsfinvkIndexXml(), { name: 'index.xml' });
    archive.append(GDPDU_DTD, { name: 'gdpdu-01-09-2004.dtd' });
    for (const [name, content] of Object.entries(csvFiles)) {
      archive.append(content, { name });
    }

    void archive.finalize();
  });
}
