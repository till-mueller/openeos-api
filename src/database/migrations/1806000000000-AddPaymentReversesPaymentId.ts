import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sobald eine TSE eingesetzt wird, kann eine bereits signierte Zahlung nicht
 * mehr nachtraeglich "genullt" werden -- ein Storno muss als zweite,
 * eigenstaendig signierte Transaktion mit umgekehrtem Vorzeichen erfolgen,
 * waehrend der urspruengliche Beleg unveraendert bleibt (vgl. DSFinV-K Anhang B,
 * AVBelegstorno). Diese Spalte verknuepft eine Storno-Zahlung mit der
 * urspruenglichen -- das Aequivalent zu DSFinV-K's references.csv.
 */
export class AddPaymentReversesPaymentId1806000000000 implements MigrationInterface {
  name = 'AddPaymentReversesPaymentId1806000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS reverses_payment_id uuid NULL
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "payments" ADD CONSTRAINT "FK_payments_reverses_payment"
          FOREIGN KEY ("reverses_payment_id") REFERENCES "payments"("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "FK_payments_reverses_payment"`);
    await queryRunner.query(`ALTER TABLE payments DROP COLUMN IF EXISTS reverses_payment_id`);
  }
}
