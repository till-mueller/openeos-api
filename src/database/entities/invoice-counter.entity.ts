import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * Serialized per-month invoice number allocation (GoBD Lückenlosigkeit).
 * Replaces the old COUNT+1 approach, which raced under concurrency and
 * could burn numbers on unique-violation retries.
 */
@Entity('invoice_counters')
export class InvoiceCounter {
  /** YYYYMM — matches the INV-YYYYMM-NNNN prefix. */
  @PrimaryColumn({ name: 'year_month', type: 'varchar', length: 6 })
  yearMonth: string;

  /** Next unallocated sequence; the allocated number is nextValue - 1 after the upsert. */
  @Column({ name: 'next_value', type: 'int' })
  nextValue: number;
}