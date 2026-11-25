// Owner login: Firebase Authentication (or its local emulator when running `npm run dev`).
// The project's public web settings come from /config.json, written at deploy time. The sign-in
// is kept for this tab only, so closing the tab signs you out.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {
  browserSessionPersistence,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  FacebookAuthProvider,
  GoogleAuthProvider,
  initializeAuth,
  browserPopupRedirectResolver,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';

/** Passwords need 10+ characters with upper and lower case letters and a number. */
const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/;
const PASSWORD_HINT = 'Passwords need at least 10 characters, with upper and lower case letters and a number.';

let configPromise;
let authPromise;

/** A login problem with a plain-words message. */
export class LoginError extends Error {
  /**
   * @param {string} code Firebase's error code, e.g. "auth/invalid-credential"
   * @param {string} message text safe to show
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Loads /config.json once.
 * @returns {Promise<{apiKey: string, authDomain: string, projectId: string, emulatorUrl?: string}>}
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
 * Signs in with email and password. An account whose email isn't confirmed yet gets a fresh
 * confirmation link and stays signed out.
 * @param {string} email
 * @param {string} password
 */
export async function signIn(email, password) {
  const auth = await getAuthReady();
  const { user } = await friendly(() => signInWithEmailAndPassword(auth, normalise(email), password));
  await requireConfirmedEmail(auth, user);
}

/**
 * Signs in with a Google account in a pop-up window. Google has already confirmed the email.
 */
export async function signInWithGoogle() {
  const auth = await getAuthReady();
  await friendly(() => signInWithPopup(auth, new GoogleAuthProvider()));
}

/**
 * Signs in with a Facebook account in a pop-up window. Firebase does not count Facebook as having
 * confirmed the email, so the first time we email a link, exactly as for a password account.
 */
export async function signInWithFacebook() {
  const auth = await getAuthReady();
  const provider = new FacebookAuthProvider();
  provider.addScope('email');
  const { user } = await friendly(() => signInWithPopup(auth, provider));
  if (!user.email) {
    await user.delete().catch(() => firebaseSignOut(auth));
    throw new LoginError('auth/no-email', 'Facebook didn’t share an email address, and we need one to find your lots. Please use Google or your email instead.');
  }
  await requireConfirmedEmail(auth, user);
}

/**
 * Creates an account and emails a confirmation link. The new account stays signed out until
 * the link is clicked.
 * @param {string} email
 * @param {string} password
 */
export async function signUp(email, password) {
  if (!PASSWORD_RULE.test(password)) {
    throw new LoginError('auth/weak-password', PASSWORD_HINT);
  }
  const auth = await getAuthReady();
  const { user } = await friendly(() => createUserWithEmailAndPassword(auth, normalise(email), password));
  try {
    await friendly(() => sendEmailVerification(user, continueSettings()));
  } finally {
    // If the email failed, signing in later sends a fresh link.
    await firebaseSignOut(auth);
  }
}

/**
 * Emails a password-reset link. Says nothing about whether the account exists.
 * @param {string} email
 */
export async function forgotPassword(email) {
  const auth = await getAuthReady();
  try {
    await sendPasswordResetEmail(auth, normalise(email), continueSettings());
  } catch (error) {
    if (error.code !== 'auth/user-not-found') {
      throw toLoginError(error);
    }
  }
}

/** Signs out on this device. */
export async function signOut() {
  await firebaseSignOut(await getAuthReady());
}

/** @returns {Promise<boolean>} whether someone with a confirmed email is signed in */
export async function isSignedIn() {
  const user = (await getAuthReady()).currentUser;
  return Boolean(user?.emailVerified);
}

/**
 * Calls the portal API with the ID token (Firebase refreshes it when needed).
 * Sends the visitor to the login page when the sign-in is no longer valid.
 * @param {string} path e.g. "/api/me"
 * @param {{method?: string, body?: unknown}} [options]
 * @returns {Promise<any>} the JSON body
 */
export async function api(path, options = {}) {
  const user = (await getAuthReady()).currentUser;
  const token = user ? await user.getIdToken().catch(() => null) : null;
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
    await signOut();
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
 * Starts Firebase once and waits until it knows whether someone is signed in.
 * @returns {Promise<import('https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js').Auth>}
 */
function getAuthReady() {
  authPromise ??= loadConfig().then(async (config) => {
    const app = initializeApp({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId });
    const auth = initializeAuth(app, { persistence: browserSessionPersistence, popupRedirectResolver: browserPopupRedirectResolver });
    if (config.emulatorUrl) {
      connectAuthEmulator(auth, config.emulatorUrl, { disableWarnings: true });
    }
    await auth.authStateReady();
    return auth;
  });
  return authPromise;
}

/**
 * Lets a confirmed account stay signed in. An unconfirmed one gets a fresh confirmation link and
 * is signed out.
 * @param {import('https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js').Auth} auth
 * @param {import('https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js').User} user the account just signed in
 */
async function requireConfirmedEmail(auth, user) {
  if (user.emailVerified) {
    return;
  }
  try {
    await friendly(() => sendEmailVerification(user, continueSettings()));
  } finally {
    // Never leave an unconfirmed account signed in, even if the email couldn't be sent.
    await firebaseSignOut(auth);
  }
  const error = new LoginError('auth/unverified', `Please confirm your email first. We just sent a link to ${user.email}.`);
  error.email = user.email;
  throw error;
}

/**
 * Where an emailed link sends people back to: the login page, which then says they're confirmed.
 * @returns {{url: string}}
 */
function continueSettings() {
  return { url: `${location.origin}/login.html?confirmed=1` };
}

/**
 * Runs a Firebase call and turns its errors into plain words.
 * @template T
 * @param {() => Promise<T>} action the call
 * @returns {Promise<T>}
 */
async function friendly(action) {
  try {
    return await action();
  } catch (error) {
    throw toLoginError(error);
  }
}

/**
 * Turns a Firebase error into a LoginError with plain words.
 * @param {{code?: string, message?: string}} error
 * @returns {LoginError}
 */
function toLoginError(error) {
  const messages = {
    'auth/invalid-credential': 'That email and password don’t match.',
    'auth/invalid-login-credentials': 'That email and password don’t match.',
    'auth/wrong-password': 'That email and password don’t match.',
    'auth/user-not-found': 'That email and password don’t match.',
    'auth/invalid-email': 'That doesn’t look like an email address.',
    'auth/email-already-in-use': 'There is already an account for that email. Sign in, or reset your password.',
    'auth/account-exists-with-different-credential': 'That email already has an account here. Sign in the way you did before (Google, or your email and password).',
    'auth/weak-password': PASSWORD_HINT,
    'auth/password-does-not-meet-requirements': PASSWORD_HINT,
    'auth/too-many-requests': 'Too many tries. Please wait a few minutes and try again.',
    'auth/network-request-failed': 'Could not reach the login service. Check your connection and try again.',
    'auth/popup-closed-by-user': 'The sign-in window was closed before signing in finished.',
    'auth/cancelled-popup-request': 'The sign-in window was closed before signing in finished.',
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
    'auth/operation-not-allowed': 'That way of signing in isn’t switched on yet. Please use your email instead.',
    'auth/user-disabled': 'This account has been switched off. Please contact the board.',
  };
  const code = error?.code ?? 'Unknown';
  return new LoginError(code, messages[code] ?? 'Something went wrong. Please try again.');
}

/**
 * Lower-cases and trims an email.
 * @param {string} email
 * @returns {string}
 */
function normalise(email) {
  return email.trim().toLowerCase();
}
