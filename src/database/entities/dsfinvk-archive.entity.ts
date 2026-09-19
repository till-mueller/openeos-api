import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Event } from './event.entity';
import { Device } from './device.entity';

/**
 * A durably-stored copy of a DSFinV-K export, written by the recurring
 * archival job (DsfinvkArchivalService). Exists because fiskaly only
 * retains signed transaction data for 3 months -- the 10-year
 * Aufbewahrungspflicht cannot rely on fiskaly's own storage, so this is
 * the record of what was pulled and where it landed on disk.
 *
 * Deliberately separate from DsfinvkClosing: that entity is the
 * legally-load-bearing audit sequence (Z_NR, Bon range); this is the
 * stored artifact the closing produced. One closing could in principle
 * be re-archived (checksum would differ if regenerated, though the
 * underlying Z_NR/data does not change), so keeping them distinct avoids
 * overloading the audit-sequence record with storage concerns.
 */
@Entity('dsfinvk_archives')
@Index(['organizationId'])
@Index(['deviceId', 'createdAt'])
export class DsfinvkArchive extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'device_id', type: 'uuid' })
  deviceId: string;

  @Column({ name: 'period_start', type: 'timestamp with time zone' })
  periodStart: Date;

  @Column({ name: 'period_end', type: 'timestamp with time zone' })
  periodEnd: Date;

  /** Absolute path on the archive volume -- never the request-facing uploads volume, this one is never pruned. */
  @Column({ name: 'archive_path', type: 'varchar', length: 500 })
  archivePath: string;

  @Column({ name: 'size_bytes', type: 'int' })
  sizeBytes: number;

  /** SHA-256 of the archive contents at write time, to detect silent corruption of a decade-old file. */
  @Column({ name: 'checksum_sha256', type: 'varchar', length: 64 })
  checksumSha256: string;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @ManyToOne(() => Device, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'device_id' })
  device: Device;
}
