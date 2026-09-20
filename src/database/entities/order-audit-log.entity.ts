import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

export enum OrderAuditAction {
  FORCE_CANCEL = 'force_cancel',
  FORCE_REFUND = 'force_refund',
  FORCE_UPDATE_STATUS = 'force_update_status',
}

export interface OrderAuditDetails {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** Present on a rejected attempt (e.g. required TSE reversal couldn't sign). */
  failure?: { errorCode?: string; httpStatus?: number; failureReason?: string };
  [key: string]: unknown;
}

/**
 * Org-scoped trail for FORCED order actions (org-ADMIN role). Distinct
 * from the platform-wide AdminAuditLog (super-admin) on purpose: an org
 * admin correcting their own order writes here so each organization's
 * trail stays self-contained.
 */
@Entity('order_audit_log')
@Index(['organizationId', 'createdAt'])
@Index(['orderId'])
export class OrderAuditLog extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'actor_user_id', type: 'uuid' })
  actorUserId: string;

  @Column({ type: 'enum', enum: OrderAuditAction, enumName: 'order_audit_action' })
  action: OrderAuditAction;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'jsonb', default: {} })
  details: OrderAuditDetails;
}