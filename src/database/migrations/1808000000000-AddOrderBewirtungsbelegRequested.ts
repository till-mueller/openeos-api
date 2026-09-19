import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderBewirtungsbelegRequested1808000000000 implements MigrationInterface {
  name = 'AddOrderBewirtungsbelegRequested1808000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS bewirtungsbeleg_requested boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE orders DROP COLUMN IF EXISTS bewirtungsbeleg_requested`,
    );
  }
}
