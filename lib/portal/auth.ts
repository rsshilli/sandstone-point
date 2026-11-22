import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Who is calling, taken from a verified Cognito ID token. */
export interface Identity {
  /** Lower-cased email address. */
  email: string;
  /** Cognito's permanent user id. */
  sub: string;
}

/** Checks the Authorization header and says who is calling. */
export interface TokenVerifier {
  /**
   * @param authorization the Authorization header, "Bearer <ID token>"
   * @returns the caller
   * @throws AuthError when the token is missing, forged, expired or for another app
   */
  verify(authorization: string | undefined): Promise<Identity>;
}

/** Settings for {@link createTokenVerifier}. */
export interface TokenVerifierOptions {
  /** The token's expected `iss`, e.g. https://cognito-idp.us-east-1.amazonaws.com/<pool id>. */
  issuer: string;
  /** Where the signing keys are published; defaults to `<issuer>/.well-known/jwks.json`. */
  jwksUrl?: string;
  /** The app client id the token must be issued to (`aud`). */
  clientId: string;
  /**
   * Refuse tokens whose email is not verified. Always true in AWS. cognito-local leaves
   * `email_verified` false even after the code is confirmed (probed 2026-11-22), so local dev
   * turns this off.
   */
  requireVerifiedEmail: boolean;
  /** Key lookup override, for tests. */
  keys?: JWTVerifyGetKey;
}

/** A login problem; the API answers 401 with this message. */
export class AuthError extends Error {}

/**
 * Builds a verifier for Cognito ID tokens. It checks the signature against the pool's public
 * keys, the issuer, the audience (our app client), expiry, and that it is an ID token (which
 * carries the email).
 * @param options issuer, client id and key location
 * @returns the verifier
 */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const keys = options.keys ?? createRemoteJWKSet(new URL(options.jwksUrl ?? `${options.issuer}/.well-known/jwks.json`));
  return {
    async verify(authorization) {
      const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
      if (!token) {
        throw new AuthError('Please sign in.');
      }
      let payload;
      try {
        ({ payload } = await jwtVerify(token, keys, { issuer: options.issuer, audience: options.clientId, algorithms: ['RS256'] }));
      } catch {
        throw new AuthError('Your sign-in has expired. Please sign in again.');
      }
      if (payload.token_use !== 'id' || typeof payload.email !== 'string' || typeof payload.sub !== 'string') {
        throw new AuthError('Please sign in again.');
      }
      if (options.requireVerifiedEmail && payload.email_verified !== true) {
        throw new AuthError('Please confirm your email address first.');
      }
      return { email: payload.email.trim().toLowerCase(), sub: payload.sub };
    },
  };
}
