// Owner login: talks straight to Amazon Cognito (or cognito-local when running `npm run dev`).
// Where Cognito lives comes from /config.json, written at deploy time. Tokens are kept in
// sessionStorage, so closing the tab signs you out.

const TOKENS_KEY = 'sandstone.tokens';
let configPromise;

/** A Cognito error with a plain-words message. */
export class LoginError extends Error {
  /**
   * @param {string} code Cognito's error name, e.g. "NotAuthorizedException"
   * @param {string} message text safe to show
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Loads /config.json once.
 * @returns {Promise<{region: string, userPoolId: string, clientId: string, cognitoEndpoint: string}>}
 */
export function loadConfig() {
  configPromise ??= fetch('/config.json', { cache: 'no-store' }).then((response) => {
    if (!response.ok) {
      throw new LoginError('NoConfig', 'Owner login is not switched on for this copy of the site.');
    }
    return response.json();
  });
  return configPromise;
}

/**
 * Signs in with email and password and keeps the tokens.
 * @param {string} email
 * @param {string} password
 */
export async function signIn(email, password) {
  const config = await loadConfig();
  let result;
  try {
    result = await cognito('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: config.clientId,
      AuthParameters: { USERNAME: normalise(email), PASSWORD: password },
    });
  } catch (error) {
    // cognito-local answers a wrong password with InvalidPasswordException; AWS with NotAuthorizedException.
    if (error.code === 'InvalidPasswordException') {
      throw new LoginError('NotAuthorizedException', friendlyMessage('NotAuthorizedException'));
    }
    throw error;
  }
  if (!result.AuthenticationResult) {
    throw new LoginError('Challenge', 'This account needs a step the website does not support yet. Please contact the board.');
  }
  saveTokens(result.AuthenticationResult);
}

/**
 * Creates an account. Cognito then emails a 6-digit code.
 * @param {string} email
 * @param {string} password
 */
export async function signUp(email, password) {
  const config = await loadConfig();
  await cognito('SignUp', {
    ClientId: config.clientId,
    Username: normalise(email),
    Password: password,
    UserAttributes: [{ Name: 'email', Value: normalise(email) }],
  });
}

/**
 * Confirms a new account with the emailed code.
 * @param {string} email
 * @param {string} code
 */
export async function confirmSignUp(email, code) {
  const config = await loadConfig();
  await cognito('ConfirmSignUp', { ClientId: config.clientId, Username: normalise(email), ConfirmationCode: code.trim() });
}

/**
 * Emails a new sign-up code.
 * @param {string} email
 */
export async function resendCode(email) {
  const config = await loadConfig();
  await cognito('ResendConfirmationCode', { ClientId: config.clientId, Username: normalise(email) });
}

/**
 * Emails a password-reset code.
 * @param {string} email
 */
export async function forgotPassword(email) {
  const config = await loadConfig();
  await cognito('ForgotPassword', { ClientId: config.clientId, Username: normalise(email) });
}

/**
 * Sets a new password using the emailed reset code.
 * @param {string} email
 * @param {string} code
 * @param {string} password
 */
export async function confirmForgotPassword(email, code, password) {
  const config = await loadConfig();
  await cognito('ConfirmForgotPassword', { ClientId: config.clientId, Username: normalise(email), ConfirmationCode: code.trim(), Password: password });
}

/** Forgets the tokens on this device. */
export function signOut() {
  sessionStorage.removeItem(TOKENS_KEY);
}

/** @returns {boolean} whether tokens are stored */
export function isSignedIn() {
  return sessionStorage.getItem(TOKENS_KEY) !== null;
}

/**
 * Calls the portal API with the ID token, refreshing it first when it is about to expire.
 * Sends the visitor to the login page when the sign-in is no longer valid.
 * @param {string} path e.g. "/api/me"
 * @param {{method?: string, body?: unknown}} [options]
 * @returns {Promise<any>} the JSON body
 */
export async function api(path, options = {}) {
  const token = await currentIdToken();
  if (!token) {
    goToLogin();
    throw new LoginError('SignedOut', 'Please sign in.');
  }
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    signOut();
    goToLogin();
  }
  if (!response.ok) {
    throw new LoginError(String(response.status), body.error ?? 'Something went wrong. Please try again.');
  }
  return body;
}

/** Sends the visitor to the login page. */
export function goToLogin() {
  location.assign('/login.html');
}

/**
 * Returns a usable ID token, refreshing it with the refresh token when under a minute is left.
 * @returns {Promise<string|null>}
 */
async function currentIdToken() {
  const stored = JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? 'null');
  if (!stored) {
    return null;
  }
  if (stored.expiresAt - Date.now() > 60_000) {
    return stored.idToken;
  }
  try {
    const config = await loadConfig();
    const result = await cognito('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: config.clientId,
      AuthParameters: { REFRESH_TOKEN: stored.refreshToken },
    });
    saveTokens({ ...result.AuthenticationResult, RefreshToken: stored.refreshToken });
    return result.AuthenticationResult.IdToken;
  } catch {
    signOut();
    return null;
  }
}

/**
 * Stores the tokens from a Cognito AuthenticationResult.
 * @param {{IdToken: string, RefreshToken?: string, ExpiresIn: number}} result
 */
function saveTokens(result) {
  sessionStorage.setItem(
    TOKENS_KEY,
    JSON.stringify({ idToken: result.IdToken, refreshToken: result.RefreshToken, expiresAt: Date.now() + result.ExpiresIn * 1000 }),
  );
}

/**
 * Calls one Cognito action.
 * @param {string} action e.g. "InitiateAuth"
 * @param {object} payload the request
 * @returns {Promise<any>} the response
 */
async function cognito(action, payload) {
  const config = await loadConfig();
  let response;
  try {
    response = await fetch(config.cognitoEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}` },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new LoginError('Network', 'Could not reach the login service. Check your connection and try again.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(body.__type ?? 'Unknown').split('#').pop();
    throw new LoginError(code, friendlyMessage(code, body.message));
  }
  return body;
}

/**
 * Turns a Cognito error into plain words.
 * @param {string} code Cognito's error name
 * @param {string|undefined} message Cognito's own message
 * @returns {string}
 */
function friendlyMessage(code, message) {
  const messages = {
    NotAuthorizedException: 'That email and password don’t match.',
    UserNotFoundException: 'That email and password don’t match.',
    UserNotConfirmedException: 'Please confirm your email first. We sent you a code.',
    UsernameExistsException: 'There is already an account for that email. Sign in, or reset your password.',
    CodeMismatchException: 'That code isn’t right. Check the email and try again.',
    ExpiredCodeException: 'That code has expired. Ask for a new one.',
    LimitExceededException: 'Too many tries. Please wait a few minutes and try again.',
    TooManyRequestsException: 'Too many tries. Please wait a few minutes and try again.',
    InvalidPasswordException: 'Passwords need at least 10 characters, with upper and lower case letters and a number.',
  };
  return messages[code] ?? message ?? 'Something went wrong. Please try again.';
}

/**
 * Lower-cases and trims an email.
 * @param {string} email
 * @returns {string}
 */
function normalise(email) {
  return email.trim().toLowerCase();
}
