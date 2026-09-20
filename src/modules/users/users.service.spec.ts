import { BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';

describe('UsersService', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';

  let userRepository: {
    findOneOrFail: jest.Mock;
    save: jest.Mock;
  };
  let refreshTokenRepository: {
    createQueryBuilder: jest.Mock;
  };
  let userOrganizationRepository: {
    find: jest.Mock;
    count: jest.Mock;
  };
  let service: UsersService;

  const makeUser = (overrides: Record<string, unknown> = {}) => ({
    id: USER_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    avatarUrl: 'https://example.com/avatar.png',
    passwordHash: 'hash',
    isActive: true,
    emailVerifiedAt: new Date(),
    failedLoginAttempts: 3,
    lockedUntil: new Date(),
    passwordResetToken: 'tok',
    passwordResetExpiresAt: new Date(),
    emailVerificationToken: 'vtok',
    emailVerificationExpiresAt: new Date(),
    twoFactorEnabled: true,
    twoFactorMethod: 'totp',
    twoFactorSecretEncrypted: 'secret',
    twoFactorBackupCodesHash: 'backup',
    ssoProvider: 'authentik',
    ssoSubject: 'sub-123',
    pendingEmail: 'new@example.com',
    pendingEmailToken: 'pet',
    pendingEmailExpiresAt: new Date(),
    preferences: {
      theme: 'dark',
      locale: 'en',
      notifications: { email: true, push: false },
    },
    ...overrides,
  });

  const makeRevokeBuilder = () => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 2 }),
  });

  beforeEach(() => {
    userRepository = {
      findOneOrFail: jest.fn(),
      save: jest.fn(async (user) => user),
    };
    refreshTokenRepository = {
      createQueryBuilder: jest.fn(),
    };
    userOrganizationRepository = {
      find: jest.fn(),
      count: jest.fn(),
    };
    service = new UsersService(
      userRepository as any,
      refreshTokenRepository as any,
      userOrganizationRepository as any,
      {} as any,
    );
  });

  describe('anonymizeUser', () => {
    it('replaces all PII and revokes sessions', async () => {
      userRepository.findOneOrFail.mockResolvedValue(makeUser());
      refreshTokenRepository.createQueryBuilder.mockReturnValue(makeRevokeBuilder());

      const result = await service.anonymizeUser(USER_ID);

      expect(userRepository.findOneOrFail).toHaveBeenCalledWith({
        where: { id: USER_ID },
      });
      expect(result.firstName).toBe('Gelöschter');
      expect(result.lastName).toBe('Nutzer');
      expect(result.email).toBe(`deleted-${USER_ID}@anonymized.invalid`);
      expect(result.avatarUrl).toBeNull();
      expect(result.passwordHash).toBeNull();
      expect(result.isActive).toBe(false);
      expect(result.emailVerifiedAt).toBeNull();
      expect(result.failedLoginAttempts).toBe(0);
      expect(result.lockedUntil).toBeNull();
      expect(result.passwordResetToken).toBeNull();
      expect(result.passwordResetExpiresAt).toBeNull();
      expect(result.emailVerificationToken).toBeNull();
      expect(result.emailVerificationExpiresAt).toBeNull();
      expect(result.twoFactorEnabled).toBe(false);
      expect(result.twoFactorMethod).toBeNull();
      expect(result.twoFactorSecretEncrypted).toBeNull();
      expect(result.twoFactorBackupCodesHash).toBeNull();
      expect(result.ssoProvider).toBeNull();
      expect(result.ssoSubject).toBeNull();
      expect(result.pendingEmail).toBeNull();
      expect(result.pendingEmailToken).toBeNull();
      expect(result.pendingEmailExpiresAt).toBeNull();
      expect(result.preferences).toEqual({});

      expect(userRepository.save).toHaveBeenCalledWith(result);
      // every session is revoked (bulk update without an exclusion clause)
      expect(refreshTokenRepository.createQueryBuilder).toHaveBeenCalled();
    });

    it('is idempotent', async () => {
      const anonymized = makeUser({
        firstName: 'Gelöschter',
        lastName: 'Nutzer',
        email: `deleted-${USER_ID}@anonymized.invalid`,
        avatarUrl: null,
        passwordHash: null,
        isActive: false,
        emailVerifiedAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
        passwordResetToken: null,
        passwordResetExpiresAt: null,
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
        twoFactorEnabled: false,
        twoFactorMethod: null,
        twoFactorSecretEncrypted: null,
        twoFactorBackupCodesHash: null,
        ssoProvider: null,
        ssoSubject: null,
        pendingEmail: null,
        pendingEmailToken: null,
        pendingEmailExpiresAt: null,
        preferences: {},
      });
      userRepository.findOneOrFail.mockResolvedValue(anonymized);
      refreshTokenRepository.createQueryBuilder.mockReturnValue(makeRevokeBuilder());

      const first = await service.anonymizeUser(USER_ID);
      const second = await service.anonymizeUser(USER_ID);

      expect(second).toEqual(first);
    });
  });

  describe('assertNotLastOrgAdmin', () => {
    it('blocks the last admin of an organization', async () => {
      userOrganizationRepository.find.mockResolvedValue([
        {
          userId: USER_ID,
          organizationId: 'org-1',
          role: OrganizationRole.ADMIN,
          organization: { name: 'Testgarten' },
        },
      ]);
      userOrganizationRepository.count.mockResolvedValue(1);

      const error = await service.assertNotLastOrgAdmin(USER_ID).catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCodes.VALIDATION_ERROR,
        message: expect.stringContaining('Testgarten'),
      });
    });

    it('allows when another admin exists', async () => {
      userOrganizationRepository.find.mockResolvedValue([
        {
          userId: USER_ID,
          organizationId: 'org-1',
          role: OrganizationRole.ADMIN,
          organization: { name: 'Testgarten' },
        },
      ]);
      userOrganizationRepository.count.mockResolvedValue(2);

      await expect(service.assertNotLastOrgAdmin(USER_ID)).resolves.toBeUndefined();
    });

    it('allows users without admin memberships', async () => {
      userOrganizationRepository.find.mockResolvedValue([]);

      await expect(service.assertNotLastOrgAdmin(USER_ID)).resolves.toBeUndefined();
      expect(userOrganizationRepository.count).not.toHaveBeenCalled();
    });
  });
});

export {};