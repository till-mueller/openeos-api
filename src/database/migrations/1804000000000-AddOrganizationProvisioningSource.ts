import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the admin "import customers from YAML" flow: tags an Organization
 * with the filename it was provisioned/last updated from, so re-uploading
 * the same file upserts instead of creating a duplicate org. Also adds the
 * corresponding admin_action enum value for audit logging.
 */
export class AddOrganizationProvisioningSource1804000000000 implements MigrationInterface {
  name = 'AddOrganizationProvisioningSource1804000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organizations"
        ADD COLUMN IF NOT EXISTS "provisioning_source" character varying(255)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_organizations_provisioning_source"
        ON "organizations" ("provisioning_source")
        WHERE "provisioning_source" IS NOT NULL
    `);
    await queryRunner.query(
      `ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS 'import_customer'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_organizations_provisioning_source"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN IF EXISTS "provisioning_source"`,
    );
    // Not reverting the admin_action ADD VALUE: Postgres has no ALTER TYPE
    // ... DROP VALUE, and any existing audit log rows using it would block
    // a type rebuild anyway.
  }
}
