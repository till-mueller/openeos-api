import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persisted DSFinV-K Z_NR sequence per till (Device). See
 * dsfinvk-closing.entity.ts's class comment for why this can't be computed
 * ad-hoc from order data at export time.
 */
export class CreateDsfinvkClosings1807000000000 implements MigrationInterface {
  name = 'CreateDsfinvkClosings1807000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS dsfinvk_closings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
        z_nr integer NOT NULL,
        erstellung varchar(30) NOT NULL,
        start_bon_id varchar(40) NOT NULL,
        end_bon_id varchar(40) NOT NULL,
        period_start timestamp with time zone NOT NULL,
        period_end timestamp with time zone NOT NULL,
        CONSTRAINT "UQ_dsfinvk_closings_device_z_nr" UNIQUE (device_id, z_nr)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dsfinvk_closings_organization_id" ON dsfinvk_closings (organization_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dsfinvk_closings_event_id" ON dsfinvk_closings (event_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS dsfinvk_closings`);
  }
}
