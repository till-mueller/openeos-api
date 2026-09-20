import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAnonymizeUserAdminAction1806000000000 implements MigrationInterface {
  name = 'AddAnonymizeUserAdminAction1806000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "admin_action" ADD VALUE IF NOT EXISTS 'anonymize_user'`);
  }

  public async down(): Promise<void> {
    // Postgres enum values cannot be removed; no-op by design.
  }
}