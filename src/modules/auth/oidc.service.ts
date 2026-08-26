import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import * as crypto from 'crypto';
import { OidcConfig } from '../../config/oidc.config';

interface OidcMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

interface OidcState {
  codeVerifier: string;
  redirect?: string;
}

export interface OidcProfile {
  provider: string;
  sub: string;
  email: string;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
}

const STATE_TTL_SECONDS = 600;
const METADATA_CACHE_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private readonly config: OidcConfig;
  private metadataCache: { value: OidcMetadata; fetchedAt: number } | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {
    this.config = this.configService.get<OidcConfig>('oidc')!;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  get provider(): string {
    return this.config.provider;
  }

  /**
   * Builds the Authentik (or any OIDC-compliant IdP) authorization URL for
   * an Authorization Code + PKCE flow, and stashes the verifier server-side
   * under the returned state so the callback never has to trust the client.
   */
  async buildAuthorizationUrl(redirect?: string): Promise<string> {
    const metadata = await this.getMetadata();

    const state = crypto.randomBytes(24).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    await this.cacheManager.set(
      this.stateCacheKey(state),
      { codeVerifier, redirect } satisfies OidcState,
      STATE_TTL_SECONDS * 1000,
    );

    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', this.config.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return url.toString();
  }

  /**
   * Exchanges the authorization code for tokens, then fetches the userinfo
   * endpoint directly from the IdP over TLS — this sidesteps needing a JWT
   * verification library, since the profile comes from a trusted server-to-
   * server call rather than a client-supplied id_token.
   */
  async handleCallback(code: string, state: string): Promise<{ profile: OidcProfile; redirect?: string }> {
    const cached = await this.cacheManager.get<OidcState>(this.stateCacheKey(state));
    if (!cached) {
      throw new UnauthorizedException('Ungültiger oder abgelaufener SSO-Status');
    }
    await this.cacheManager.del(this.stateCacheKey(state));

    const metadata = await this.getMetadata();

    const tokenResponse = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code_verifier: cached.codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      this.logger.warn(`OIDC token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
      throw new UnauthorizedException('SSO-Anmeldung fehlgeschlagen');
    }

    const tokens = (await tokenResponse.json()) as { access_token: string };

    const userinfoResponse = await fetch(metadata.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userinfoResponse.ok) {
      this.logger.warn(`OIDC userinfo request failed: ${userinfoResponse.status}`);
      throw new UnauthorizedException('SSO-Anmeldung fehlgeschlagen');
    }

    const claims = (await userinfoResponse.json()) as Record<string, unknown>;

    const email = typeof claims.email === 'string' ? claims.email : null;
    const sub = typeof claims.sub === 'string' ? claims.sub : null;
    if (!email || !sub) {
      throw new UnauthorizedException('SSO-Profil enthält keine gültige E-Mail-Adresse');
    }

    const givenName = typeof claims.given_name === 'string' ? claims.given_name : '';
    const familyName = typeof claims.family_name === 'string' ? claims.family_name : '';
    const displayName = typeof claims.name === 'string' ? claims.name : '';
    const [fallbackFirst, ...fallbackRest] = displayName.split(' ');

    return {
      profile: {
        provider: this.config.provider,
        sub,
        email: email.toLowerCase(),
        emailVerified: claims.email_verified !== false,
        firstName: givenName || fallbackFirst || email.split('@')[0],
        lastName: familyName || fallbackRest.join(' ') || '',
      },
      redirect: cached.redirect,
    };
  }

  private async getMetadata(): Promise<OidcMetadata> {
    if (this.metadataCache && Date.now() - this.metadataCache.fetchedAt < METADATA_CACHE_TTL_MS) {
      return this.metadataCache.value;
    }

    const discoveryUrl = `${this.config.issuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const response = await fetch(discoveryUrl);
    if (!response.ok) {
      throw new Error(`OIDC discovery failed for ${discoveryUrl}: ${response.status}`);
    }

    const metadata = (await response.json()) as OidcMetadata;
    this.metadataCache = { value: metadata, fetchedAt: Date.now() };
    return metadata;
  }

  private stateCacheKey(state: string): string {
    return `oidc:state:${state}`;
  }
}
