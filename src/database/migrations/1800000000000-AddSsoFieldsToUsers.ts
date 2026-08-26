import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds OIDC SSO linkage columns (e.g. for Authentik) to users and makes
 * password_hash nullable for SSO-only accounts that never set a password.
 */
export class AddSsoFieldsToUsers1800000000000 implements MigrationInterface {
  name = 'AddSsoFieldsToUsers1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
      ADD COLUMN sso_provider varchar(50),
      ADD COLUMN sso_subject varchar(255)
    `);

    await queryRunner.query(`
      ALTER TABLE users
      ALTER COLUMN password_hash DROP NOT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_users_sso_provider_subject"
      ON users (sso_provider, sso_subject)
      WHERE sso_subject IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_users_sso_provider_subject"`);

    // Prevent failure when SSO-only rows without a password exist.
    await queryRunner.query(`
      UPDATE users SET password_hash = '' WHERE password_hash IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE users
      ALTER COLUMN password_hash SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE users
      DROP COLUMN sso_provider,
      DROP COLUMN sso_subject
    `);
  }
}
