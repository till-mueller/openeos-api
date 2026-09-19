import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable-storage record for archived DSFinV-K exports (see
 * dsfinvk-archive.entity.ts's class comment for why this exists
 * separately from dsfinvk_closings -- fiskaly's 3-month retention window
 * means the recurring archival job's output needs its own tracking row).
 */
export class CreateDsfinvkArchives1809000000000 implements MigrationInterface {
  name = 'CreateDsfinvkArchives1809000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS dsfinvk_archives (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
        period_start timestamp with time zone NOT NULL,
        period_end timestamp with time zone NOT NULL,
        archive_path varchar(500) NOT NULL,
        size_bytes integer NOT NULL,
        checksum_sha256 varchar(64) NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dsfinvk_archives_organization_id" ON dsfinvk_archives (organization_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dsfinvk_archives_device_id_created_at" ON dsfinvk_archives (device_id, created_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS dsfinvk_archives`);
  }
}
