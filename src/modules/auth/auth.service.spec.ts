import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import {
  User,
  Organization,
  UserOrganization,
  RefreshToken,
  Invitation,
} from '../../database/entities';
import { OidcProfile } from './oidc.service';

describe('AuthService.loginWithSsoProfile', () => {
  let service: AuthService;
  let userRepository: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let refreshTokenRepository: { create: jest.Mock; save: jest.Mock };

  const profile: OidcProfile = {
    provider: 'authentik',
    sub: 'idp-subject-1',
    email: 'ada@example.com',
    emailVerified: true,
    firstName: 'Ada',
    lastName: 'Lovelace',
  };

  beforeEach(async () => {
    userRepository = {
      findOne: jest.fn(),
      create: jest.fn((input) => ({ ...input })),
      save: jest.fn(async (user) => user),
    };
    refreshTokenRepository = {
      create: jest.fn((input) => ({ ...input })),
      save: jest.fn(async (token) => token),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(Organization), useValue: {} },
        { provide: getRepositoryToken(UserOrganization), useValue: {} },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokenRepository },
        { provide: getRepositoryToken(Invitation), useValue: {} },
        { provide: JwtService, useValue: { sign: jest.fn(() => 'signed-jwt') } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: DataSource, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: PlatformSettingsService, useValue: {} },
        { provide: CACHE_MANAGER, useValue: { set: jest.fn(), get: jest.fn(), del: jest.fn() } },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('creates a new SSO-only user (no password) on first login', async () => {
    userRepository.findOne.mockResolvedValue(null); // no match by provider+subject, none by email

    const result = await service.loginWithSsoProfile(profile);

    expect(userRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: profile.email,
        passwordHash: null,
        ssoProvider: profile.provider,
        ssoSubject: profile.sub,
        isActive: true,
      }),
    );
    expect(result.user.email).toBe(profile.email);
    expect(result.accessToken).toBe('signed-jwt');
    expect(result.refreshToken).toEqual(expect.any(String));
  });

  it('links an existing password account by email instead of creating a duplicate', async () => {
    const existing = {
      id: 'user-1',
      email: profile.email,
      passwordHash: 'bcrypt-hash',
      isActive: true,
      emailVerifiedAt: null,
      lockedUntil: null,
    } as unknown as User;

    userRepository.findOne
      .mockResolvedValueOnce(null) // no provider+subject match yet
      .mockResolvedValueOnce(existing); // found by email

    const result = await service.loginWithSsoProfile(profile);

    expect(userRepository.create).not.toHaveBeenCalled();
    expect(existing.ssoProvider).toBe(profile.provider);
    expect(existing.ssoSubject).toBe(profile.sub);
    expect(existing.emailVerifiedAt).toBeInstanceOf(Date);
    expect(result.user).toBe(existing);
  });

  it('reuses the existing account on a returning provider+subject match without re-linking by email', async () => {
    const existing = {
      id: 'user-1',
      email: profile.email,
      ssoProvider: profile.provider,
      ssoSubject: profile.sub,
      isActive: true,
      emailVerifiedAt: new Date(),
      lockedUntil: null,
    } as unknown as User;

    userRepository.findOne.mockResolvedValueOnce(existing);

    const result = await service.loginWithSsoProfile(profile);

    expect(userRepository.findOne).toHaveBeenCalledTimes(1);
    expect(result.user).toBe(existing);
  });

  it('rejects a deactivated account', async () => {
    userRepository.findOne.mockResolvedValueOnce({
      id: 'user-1',
      isActive: false,
    } as unknown as User);

    await expect(service.loginWithSsoProfile(profile)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a locked account', async () => {
    userRepository.findOne.mockResolvedValueOnce({
      id: 'user-1',
      isActive: true,
      lockedUntil: new Date(Date.now() + 60_000),
    } as unknown as User);

    await expect(service.loginWithSsoProfile(profile)).rejects.toThrow(UnauthorizedException);
  });
});
