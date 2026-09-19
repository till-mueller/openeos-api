import { Entity, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Event } from './event.entity';
import { Device } from './device.entity';

/**
 * One DSFinV-K Kassenabschluss (cash-closing) that was actually exported.
 *
 * The spec's Z_NR is a legally load-bearing sequence: a gap or repeat in a
 * till's Z_NR history is exactly the kind of thing a Finanzamt audit looks
 * for, so it cannot be computed ad-hoc from existing order data at export
 * time -- it has to be a persisted, monotonic counter per device (Kasse),
 * allocated once and never reused, even if the export that used it is
 * later regenerated or fails downstream. Confirmed with Till that exports
 * must be runnable mid-event (not only after it ends), so one Event can
 * have many closings over time, each with the next zNr for that device.
 */
@Entity('dsfinvk_closings')
@Index(['organizationId'])
@Index(['eventId'])
@Unique(['deviceId', 'zNr'])
export class DsfinvkClosing extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  /** The "Kasse" this closing belongs to -- one physical till (Device), per cashregister.csv's per-device model. */
  @Column({ name: 'device_id', type: 'uuid' })
  deviceId: string;

  @Column({ name: 'z_nr', type: 'int' })
  zNr: number;

  /** Timestamp this closing was generated, in the exact format written to every table's Z_ERSTELLUNG column. */
  @Column({ name: 'erstellung', type: 'varchar', length: 30 })
  erstellung: string;

  @Column({ name: 'start_bon_id', type: 'varchar', length: 40 })
  startBonId: string;

  @Column({ name: 'end_bon_id', type: 'varchar', length: 40 })
  endBonId: string;

  @Column({ name: 'period_start', type: 'timestamp with time zone' })
  periodStart: Date;

  @Column({ name: 'period_end', type: 'timestamp with time zone' })
  periodEnd: Date;

  // Relations
  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  /**
   * RESTRICT, not SET NULL like other Device references in this codebase --
   * deviceId is part of the (deviceId, zNr) audit sequence and can't go
   * null without breaking that uniqueness/ordering guarantee.
   */
  @ManyToOne(() => Device, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'device_id' })
  device: Device;
}
