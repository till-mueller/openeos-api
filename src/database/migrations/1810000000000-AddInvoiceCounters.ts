import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInvoiceCounters1810000000000 implements MigrationInterface {
  name = 'AddInvoiceCounters1810000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "invoice_counters" (
        "year_month" varchar(6) PRIMARY KEY,
        "next_value" integer NOT NULL
      )`,
    );
    // Seed from existing invoices so numbering continues without collision.
    // Gap-aware: starting from the highest number issued so far, not the
    // row count, so a previously burned/gapped sequence can never collide
    // with an existing invoice number.
    await queryRunner.query(
      `INSERT INTO "invoice_counters" ("year_month", "next_value")
       SELECT substring("invoice_number" from 5 for 6),
              max(substring("invoice_number" from 12 for 4)::int) + 1
       FROM "invoices"
       WHERE "invoice_number" ~ '^INV-[0-9]{6}-[0-9]{4}$'
       GROUP BY 1
       ON CONFLICT ("year_month") DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "invoice_counters"`);
  }
}