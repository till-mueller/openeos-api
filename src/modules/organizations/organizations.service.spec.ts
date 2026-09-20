import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { ErrorCodes } from '../../common/constants/error-codes';

describe('OrganizationsService', () => {
  const ORG_ID = '11111111-1111-4111-8111-111111111111';
  const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
  const TARGET_ID = '33333333-3333-4333-8333-333333333333';
  const IP = '127.0.0.1';
  const UA = 'jest';

  let userOrganizationRepository: {
    findOne: jest.Mock;
  };
  let auditLogRepository: {
    create: jest.Mock;
    save: jest.Mock;
  };
  let usersService: {
    getUserById: jest.Mock;
    anonymizeUser: jest.Mock;
    assertNotLastOrgAdmin: jest.Mock;
  };
  let service: OrganizationsService;

  const makeUser = (overrides: Record<string, unknown> = {}) => ({
    id: ADMIN_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'admin@example.com',
    isSuperAdmin: false,
    ...overrides,
  });

  beforeEach(() => {
    userOrganizationRepository = {
      findOne: jest.fn(),
    };
    auditLogRepository = {
      create: jest.fn(),
      save: jest.fn(),
    };
    usersService = {
      getUserById: jest.fn(),
      anonymizeUser: jest.fn(),
      assertNotLastOrgAdmin: jest.fn(),
    };
    service = new OrganizationsService(
      {} as any, // organizationRepository
      {} as any, // userRepository
      userOrganizationRepository as any,
      {} as any, // invitationRepository
      auditLogRepository as any,
      {} as any, // dataSource
      {} as any, // emailService
      {} as any, // platformSettingsService
      {} as any, // configService
      usersService as any,
    );
  });

  describe('anonymizeMember', () => {
    it('requires org admin role', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({
        id: 'uo-member',
        role: OrganizationRole.MEMBER,
      });

      const error = await service
        .anonymizeMember(ORG_ID, TARGET_ID, makeUser() as any, IP, UA)
        .catch((e) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({ code: ErrorCodes.FORBIDDEN });
      expect(usersService.anonymizeUser).not.toHaveBeenCalled();
      expect(auditLogRepository.save).not.toHaveBeenCalled();
    });

    it('requires the target to be a member', async () => {
      userOrganizationRepository.findOne.mockImplementation(async ({ where }) => {
        if (where.userId === ADMIN_ID) {
          return { id: 'uo-admin', role: OrganizationRole.ADMIN };
        }
        return null;
      });

      const error = await service
        .anonymizeMember(ORG_ID, TARGET_ID, makeUser() as any, IP, UA)
        .catch((e) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.getResponse()).toMatchObject({ code: ErrorCodes.NOT_FOUND });
      expect(usersService.getUserById).not.toHaveBeenCalled();
      expect(usersService.anonymizeUser).not.toHaveBeenCalled();
      expect(auditLogRepository.save).not.toHaveBeenCalled();
    });

    it('blocks when the target is the last admin of an organization', async () => {
      userOrganizationRepository.findOne.mockImplementation(async ({ where }) => {
        if (where.userId === ADMIN_ID) {
          return { id: 'uo-admin', role: OrganizationRole.ADMIN };
        }
        return { id: 'uo-target', role: OrganizationRole.ADMIN };
      });
      usersService.assertNotLastOrgAdmin.mockRejectedValue(
        new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Du bist der letzte Administrator',
        }),
      );

      const error = await service
        .anonymizeMember(ORG_ID, TARGET_ID, makeUser() as any, IP, UA)
        .catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(usersService.assertNotLastOrgAdmin).toHaveBeenCalledWith(TARGET_ID);
      expect(usersService.anonymizeUser).not.toHaveBeenCalled();
      expect(auditLogRepository.save).not.toHaveBeenCalled();
    });

    it('anonymizes and writes an audit log entry with the pre-anonymization PII', async () => {
      userOrganizationRepository.findOne.mockImplementation(async ({ where }) => {
        if (where.userId === ADMIN_ID) {
          return { id: 'uo-admin', role: OrganizationRole.ADMIN };
        }
        return { id: 'uo-target', role: OrganizationRole.MEMBER };
      });
      usersService.getUserById.mockResolvedValue({
        id: TARGET_ID,
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      usersService.assertNotLastOrgAdmin.mockResolvedValue(undefined);
      usersService.anonymizeUser.mockResolvedValue({});
      const auditLog = { id: 'log-1' };
      auditLogRepository.create.mockReturnValue(auditLog);
      auditLogRepository.save.mockResolvedValue(auditLog);

      await service.anonymizeMember(ORG_ID, TARGET_ID, makeUser() as any, IP, UA);

      expect(usersService.assertNotLastOrgAdmin).toHaveBeenCalledWith(TARGET_ID);
      expect(usersService.anonymizeUser).toHaveBeenCalledWith(TARGET_ID);
      expect(auditLogRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          adminUserId: ADMIN_ID,
          organizationId: ORG_ID,
          action: AdminAction.ANONYMIZE_USER,
          resourceType: 'user',
          resourceId: TARGET_ID,
          details: {
            before: {
              email: 'ada@example.com',
              firstName: 'Ada',
              lastName: 'Lovelace',
            },
          },
          ipAddress: IP,
          userAgent: UA,
          reason: null,
        }),
      );
      expect(auditLogRepository.save).toHaveBeenCalledWith(auditLog);
    });
  });
});

export {};