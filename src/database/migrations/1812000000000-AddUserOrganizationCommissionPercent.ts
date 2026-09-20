import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserOrganizationCommissionPercent1812000000000
  implements MigrationInterface
{
  name = 'AddUserOrganizationCommissionPercent1812000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_organizations" ADD COLUMN IF NOT EXISTS "commission_percent" numeric(5,2) NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_organizations" DROP COLUMN IF EXISTS "commission_percent"`,
    );
  }
}
