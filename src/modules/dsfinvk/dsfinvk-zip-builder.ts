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

/**
 * Wraps several already-built per-till archives into one outer ZIP, one
 * inner .zip per device. Deliberately does NOT merge the per-till CSVs
 * together -- each till's Z_NR sequence, index.xml and DTD have to stay
 * independently reconstructable for an auditor to verify gaplessness per
 * Kasse (see dsfinvk-closing.entity.ts), so this is packaging, not merging.
 */
export function buildDsfinvkEventZip(
  archives: DsfinvkExportArchive[],
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

    for (const inner of archives) {
      archive.append(inner.data, { name: inner.filename });
    }

    void archive.finalize();
  });
}
