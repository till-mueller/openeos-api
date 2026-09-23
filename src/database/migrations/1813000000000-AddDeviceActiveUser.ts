import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeviceActiveUser1813000000000 implements MigrationInterface {
  name = 'AddDeviceActiveUser1813000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "active_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "active_user_since" timestamp with time zone`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "devices" DROP COLUMN IF EXISTS "active_user_since"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" DROP COLUMN IF EXISTS "active_user_id"`,
    );
  }
}
