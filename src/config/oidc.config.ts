import { registerAs } from '@nestjs/config';

export interface OidcConfig {
  enabled: boolean;
  provider: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

export default registerAs('oidc', (): OidcConfig => {
  const issuerUrl = process.env.AUTHENTIK_ISSUER_URL || '';
  const clientId = process.env.AUTHENTIK_CLIENT_ID || '';
  const clientSecret = process.env.AUTHENTIK_CLIENT_SECRET || '';

  return {
    // SSO is opt-in: it only activates once an operator has configured an
    // issuer + client credentials for their Authentik (or other OIDC) instance.
    enabled: Boolean(issuerUrl && clientId && clientSecret),
    provider: process.env.AUTHENTIK_PROVIDER_NAME || 'authentik',
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri:
      process.env.AUTHENTIK_REDIRECT_URI ||
      `${process.env.API_URL || 'http://localhost:3001'}/api/auth/sso/authentik/callback`,
    scope: process.env.AUTHENTIK_SCOPE || 'openid profile email',
  };
});
