import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { UnauthorizedException } from '@nestjs/common';
import { OidcService } from './oidc.service';
import { OidcConfig } from '../../config/oidc.config';

describe('OidcService', () => {
  let service: OidcService;
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let fetchMock: jest.Mock;

  const config: OidcConfig = {
    enabled: true,
    provider: 'authentik',
    issuerUrl: 'https://authentik.example.com/application/o/openeos',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://api.example.com/api/auth/sso/authentik/callback',
    scope: 'openid profile email',
  };

  const metadata = {
    authorization_endpoint: 'https://authentik.example.com/authorize',
    token_endpoint: 'https://authentik.example.com/token',
    userinfo_endpoint: 'https://authentik.example.com/userinfo',
  };

  beforeEach(async () => {
    cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OidcService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(config) },
        },
        { provide: CACHE_MANAGER, useValue: cache },
      ],
    }).compile();

    service = module.get(OidcService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isEnabled', () => {
    it('reflects the resolved config', () => {
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('buildAuthorizationUrl', () => {
    it('discovers the issuer, stashes the PKCE verifier under the state, and returns a valid authorize URL', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => metadata });

      const url = await service.buildAuthorizationUrl('/dashboard');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://authentik.example.com/application/o/openeos/.well-known/openid-configuration',
      );

      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(metadata.authorization_endpoint);
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('client_id')).toBe(config.clientId);
      expect(parsed.searchParams.get('redirect_uri')).toBe(config.redirectUri);
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
      expect(parsed.searchParams.get('state')).toBeTruthy();

      expect(cache.set).toHaveBeenCalledTimes(1);
      const [cacheKey, cachedValue, ttlMs] = cache.set.mock.calls[0];
      expect(cacheKey).toBe(`oidc:state:${parsed.searchParams.get('state')}`);
      expect(cachedValue.redirect).toBe('/dashboard');
      expect(typeof cachedValue.codeVerifier).toBe('string');
      expect(ttlMs).toBe(600 * 1000);
    });

    it('only fetches discovery metadata once across calls (cached)', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => metadata });

      await service.buildAuthorizationUrl();
      await service.buildAuthorizationUrl();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleCallback', () => {
    const state = 'the-state';
    const stashedState = { codeVerifier: 'verifier-123', redirect: '/dashboard' };

    beforeEach(() => {
      // Every handleCallback test needs discovery once for the token/userinfo endpoints.
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/.well-known/openid-configuration')) {
          return Promise.resolve({ ok: true, json: async () => metadata });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
    });

    it('rejects an unknown or expired state before touching the network', async () => {
      cache.get.mockResolvedValue(undefined);

      await expect(service.handleCallback('code', state)).rejects.toThrow(UnauthorizedException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('exchanges the code, fetches userinfo, and normalizes the profile', async () => {
      cache.get.mockResolvedValue(stashedState);
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith('/.well-known/openid-configuration')) {
          return Promise.resolve({ ok: true, json: async () => metadata });
        }
        if (url === metadata.token_endpoint) {
          const body = new URLSearchParams(init!.body as string);
          expect(body.get('grant_type')).toBe('authorization_code');
          expect(body.get('code')).toBe('auth-code');
          expect(body.get('code_verifier')).toBe(stashedState.codeVerifier);
          expect(body.get('client_secret')).toBe(config.clientSecret);
          return Promise.resolve({ ok: true, json: async () => ({ access_token: 'access-123' }) });
        }
        if (url === metadata.userinfo_endpoint) {
          expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer access-123');
          return Promise.resolve({
            ok: true,
            json: async () => ({
              sub: 'idp-subject-1',
              email: 'Person@Example.com',
              email_verified: true,
              given_name: 'Ada',
              family_name: 'Lovelace',
            }),
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const result = await service.handleCallback('auth-code', state);

      expect(cache.del).toHaveBeenCalledWith(`oidc:state:${state}`);
      expect(result.redirect).toBe('/dashboard');
      expect(result.profile).toEqual({
        provider: 'authentik',
        sub: 'idp-subject-1',
        email: 'person@example.com',
        emailVerified: true,
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
    });

    it('rejects when the token endpoint fails', async () => {
      cache.get.mockResolvedValue(stashedState);
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/.well-known/openid-configuration')) {
          return Promise.resolve({ ok: true, json: async () => metadata });
        }
        if (url === metadata.token_endpoint) {
          return Promise.resolve({ ok: false, status: 400, text: async () => 'invalid_grant' });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      await expect(service.handleCallback('bad-code', state)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a userinfo response missing sub or email', async () => {
      cache.get.mockResolvedValue(stashedState);
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/.well-known/openid-configuration')) {
          return Promise.resolve({ ok: true, json: async () => metadata });
        }
        if (url === metadata.token_endpoint) {
          return Promise.resolve({ ok: true, json: async () => ({ access_token: 'access-123' }) });
        }
        if (url === metadata.userinfo_endpoint) {
          return Promise.resolve({ ok: true, json: async () => ({ sub: 'idp-subject-1' }) });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      await expect(service.handleCallback('auth-code', state)).rejects.toThrow(UnauthorizedException);
    });
  });
});
