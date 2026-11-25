import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/** Who is calling, taken from a verified Firebase ID token. */
export interface Identity {
  /** Lower-cased email address. */
  email: string;
  /** Firebase's permanent user id (the token's `sub`). */
  sub: string;
}

/** Checks the Authorization header and says who is calling. */
export interface TokenVerifier {
  /**
   * @param authorization the Authorization header, "Bearer <ID token>"
   * @returns the caller
   * @throws AuthError when the token is missing, forged, expired or for another project
   */
  verify(authorization: string | undefined): Promise<Identity>;
}

/** Where Google publishes the keys that sign Firebase ID tokens. */
export const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/** Settings for {@link createTokenVerifier}. */
export interface TokenVerifierOptions {
  /** The Firebase / Google Cloud project id; tokens must be issued by and for it. */
  projectId: string;
  /** Refuse tokens whose email is not verified. Always true when deployed. */
  requireVerifiedEmail: boolean;
  /**
   * Local `npm run dev` only: accept the Firebase Auth emulator's tokens, which are unsigned
   * (`alg: none`). The issuer, audience and expiry are still checked. Only allowed with a
   * "demo-" project id (the emulator's offline projects). Never set when deployed.
   */
  emulator?: boolean;
  /** Key lookup override, for tests. */
  keys?: JWTVerifyGetKey;
}

/** A login problem; the API answers 401 with this message. */
export class AuthError extends Error {}

/**
 * Builds a verifier for Firebase ID tokens. It checks the signature against Google's published
 * keys, the issuer and audience (our project), expiry, and that the token carries an email.
 * @param options project id and key location
 * @returns the verifier
 */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  // Unsigned tokens are only ever fine for an offline "demo-" project; refuse a wiring mistake outright.
  if (options.emulator && !options.projectId.startsWith('demo-')) {
    throw new Error(`Emulator tokens are only allowed for a demo- project, not ${options.projectId}`);
  }
  const issuer = `https://securetoken.google.com/${options.projectId}`;
  const keys = options.keys ?? createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
  return {
    async verify(authorization) {
      const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
      if (!token) {
        throw new AuthError('Please sign in.');
      }
      let payload: JWTPayload;
      try {
        payload = options.emulator ? checkEmulatorToken(token, issuer, options.projectId) : (await jwtVerify(token, keys, { issuer, audience: options.projectId, algorithms: ['RS256'] })).payload;
      } catch {
        throw new AuthError('Your sign-in has expired. Please sign in again.');
      }
      if (typeof payload.email !== 'string' || typeof payload.sub !== 'string' || payload.sub === '') {
        throw new AuthError('Please sign in again.');
      }
      if (options.requireVerifiedEmail && payload.email_verified !== true) {
        throw new AuthError('Please confirm your email address first.');
      }
      return { email: payload.email.trim().toLowerCase(), sub: payload.sub };
    },
  };
}

/**
 * Reads an unsigned emulator token and checks everything but the (absent) signature.
 * @param token the compact JWT
 * @param issuer the expected issuer
 * @param audience the expected audience
 * @returns its claims
 * @throws Error when it is for another project or has expired
 */
function checkEmulatorToken(token: string, issuer: string, audience: string): JWTPayload {
  const payload = decodeJwt(token);
  if (payload.iss !== issuer || payload.aud !== audience || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
    throw new Error('Not a current emulator token for this project');
  }
  return payload;
}
