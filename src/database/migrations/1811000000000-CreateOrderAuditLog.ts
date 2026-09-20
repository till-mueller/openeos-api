import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrderAuditLog1811000000000 implements MigrationInterface {
  name = 'CreateOrderAuditLog1811000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "order_audit_action" AS ENUM ('force_cancel', 'force_refund', 'force_update_status')`);
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "order_audit_log" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "order_id" uuid NOT NULL,
        "actor_user_id" uuid NOT NULL,
        "action" "order_audit_action" NOT NULL,
        "reason" text NULL,
        "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_order_audit_org_created" ON "order_audit_log" ("organization_id", "created_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_order_audit_order" ON "order_audit_log" ("order_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "order_audit_log"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "order_audit_action"`);
  }
}