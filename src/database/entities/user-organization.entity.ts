import { Entity, Column, ManyToOne, JoinColumn, Unique, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';
import { Organization } from './organization.entity';
import { numericTransformer } from '../transformers/numeric.transformer';

export enum OrganizationRole {
  ADMIN = 'admin',
  MEMBER = 'member',
}

export interface OrganizationPermissions {
  products?: boolean;
  events?: boolean;
  devices?: boolean;
  members?: boolean;
  shiftPlans?: boolean;
  discounts?: boolean;
  pfand?: boolean;
  reports?: boolean;
  inventory?: boolean;
}

@Entity('user_organizations')
@Unique(['userId', 'organizationId'])
@Index(['userId'])
@Index(['organizationId'])
export class UserOrganization extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({
    type: 'enum',
    enum: ['admin', 'member'],
    enumName: 'organization_role',
  })
  role: OrganizationRole;

  @Column({ type: 'jsonb', default: {} })
  permissions: OrganizationPermissions;

  @Column({ type: 'varchar', length: 255, nullable: true })
  pin: string | null;

  /**
   * Percentage of this server's captured sales they're paid as commission
   * (POS checkouts attributed to them via Payment.processedByUserId).
   * Defaults to 0 for every membership, including admins/the main register
   * — commission is opt-in per person, not role-based.
   */
  @Column({
    name: 'commission_percent',
    type: 'decimal',
    precision: 5,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  commissionPercent: number;

  // Relations
  @ManyToOne(() => User, (user) => user.userOrganizations, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Organization, (org) => org.userOrganizations, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;
}
