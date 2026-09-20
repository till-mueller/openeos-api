import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';

describe('UsersService', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const PASSWORD_HASH = bcrypt.hashSync('correct-password', 4);

  let userRepository: {
    findOneOrFail: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let refreshTokenRepository: {
    createQueryBuilder: jest.Mock;
  };
  let userOrganizationRepository: {
    find: jest.Mock;
    count: jest.Mock;
  };
  let emailService: {
    sendAccountDeletionConfirmation: jest.Mock;
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

  const makeSessionBuilder = (sessions: Array<Record<string, unknown>>) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(sessions),
  });

  beforeEach(() => {
    userRepository = {
      findOneOrFail: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(async (user) => user),
    };
    refreshTokenRepository = {
      createQueryBuilder: jest.fn(),
    };
    userOrganizationRepository = {
      find: jest.fn(),
      count: jest.fn(),
    };
    emailService = {
      sendAccountDeletionConfirmation: jest.fn().mockResolvedValue(undefined),
    };
    service = new UsersService(
      userRepository as any,
      refreshTokenRepository as any,
      userOrganizationRepository as any,
      {} as any,
      emailService as any,
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

  describe('deleteAccount', () => {
    it('requires the password for password accounts', async () => {
      userRepository.findOneOrFail.mockResolvedValue(makeUser({ passwordHash: PASSWORD_HASH }));

      const error = await service.deleteAccount(USER_ID).catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCodes.VALIDATION_ERROR,
        message: expect.stringContaining('Passwort erforderlich'),
      });
      expect(userOrganizationRepository.find).not.toHaveBeenCalled();
    });

    it('rejects a wrong password with 403', async () => {
      userRepository.findOneOrFail.mockResolvedValue(makeUser({ passwordHash: PASSWORD_HASH }));
      userOrganizationRepository.find.mockResolvedValue([]);

      const error = await service.deleteAccount(USER_ID, 'wrong-password').catch((e) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCodes.FORBIDDEN,
        message: expect.stringContaining('Passwort ist falsch'),
      });
      expect(userOrganizationRepository.find).not.toHaveBeenCalled();
    });

    it('skips password for SSO-only accounts', async () => {
      userRepository.findOneOrFail.mockResolvedValue(makeUser({ passwordHash: null }));
      userOrganizationRepository.find.mockResolvedValue([]);
      refreshTokenRepository.createQueryBuilder.mockReturnValue(makeRevokeBuilder());

      await expect(service.deleteAccount(USER_ID)).resolves.toBeUndefined();
    });

    it('blocks super-admins even with a correct password', async () => {
      userRepository.findOneOrFail.mockResolvedValue(
        makeUser({ passwordHash: PASSWORD_HASH, isSuperAdmin: true }),
      );

      const error = await service.deleteAccount(USER_ID, 'correct-password').catch((e) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({
        code: ErrorCodes.FORBIDDEN,
        message: expect.stringContaining('Super-Admin'),
      });
    });

    it('runs the last-admin guard, then sends the confirmation email, then anonymizes on success', async () => {
      const user = makeUser({ passwordHash: PASSWORD_HASH, isSuperAdmin: false });
      userRepository.findOneOrFail.mockResolvedValue(user);
      userOrganizationRepository.find.mockResolvedValue([]);
      refreshTokenRepository.createQueryBuilder.mockReturnValue(makeRevokeBuilder());
      const anonymizeSpy = jest.spyOn(service as any, 'anonymizeUser').mockResolvedValue(user);

      await service.deleteAccount(USER_ID, 'correct-password');

      expect(userOrganizationRepository.find).toHaveBeenCalled();
      expect(emailService.sendAccountDeletionConfirmation).toHaveBeenCalledWith('ada@example.com');
      expect(anonymizeSpy).toHaveBeenCalledWith(USER_ID);
      expect(anonymizeSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
        emailService.sendAccountDeletionConfirmation.mock.invocationCallOrder[0],
      );
    });
  });

  describe('getDataExport', () => {
    it('returns profile, memberships and active sessions without secret fields', async () => {
      const createdAt = new Date('2024-01-01T00:00:00Z');
      const lastLoginAt = new Date('2024-06-01T00:00:00Z');
      const user = makeUser({
        createdAt,
        lastLoginAt,
        userOrganizations: [
          {
            organizationId: 'org-1',
            role: OrganizationRole.ADMIN,
            organization: { name: 'Testgarten' },
          },
        ],
      });
      userRepository.findOne.mockResolvedValue(user);
      const session = {
        id: 'sess-1',
        createdAt: new Date('2024-05-01T00:00:00Z'),
        expiresAt: new Date('2024-11-01T00:00:00Z'),
      };
      refreshTokenRepository.createQueryBuilder.mockReturnValue(makeSessionBuilder([session]));

      const result = await service.getDataExport(USER_ID);

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: USER_ID },
        relations: ['userOrganizations', 'userOrganizations.organization'],
      });
      expect(result.profile).toMatchObject({
        id: USER_ID,
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        avatarUrl: 'https://example.com/avatar.png',
        createdAt,
        lastLoginAt,
      });
      expect(result.profile).not.toHaveProperty('passwordHash');
      expect(result.profile).not.toHaveProperty('ssoSubject');
      expect(result.memberships).toEqual([
        { organizationId: 'org-1', organizationName: 'Testgarten', role: OrganizationRole.ADMIN },
      ]);
      expect(result.activeSessions).toEqual([
        { id: 'sess-1', createdAt: session.createdAt, expiresAt: session.expiresAt },
      ]);
      expect(result.exportedAt).toEqual(expect.any(String));
    });
  });
});

export {};
