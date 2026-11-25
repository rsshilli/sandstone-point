// The login page: sign in (Google, Facebook or email), create an account, reset a password.
import { forgotPassword, isSignedIn, loadConfig, signIn, signInWithFacebook, signInWithGoogle, signUp } from './auth.js';

const PANELS = ['signin', 'signup', 'check', 'forgot'];

/**
 * Wires up the page once it has loaded.
 */
async function main() {
  for (const button of document.querySelectorAll('[data-show]')) {
    button.addEventListener('click', () => show(button.dataset.show));
  }
  handle('signin-form', async (form) => {
    try {
      await signIn(form.email.value, form.password.value);
    } catch (error) {
      if (error.code === 'auth/unverified') {
        logDevLink(form.email.value);
      }
      throw error;
    }
    location.assign('/portal.html');
  });
  handle('signup-form', async (form) => {
    await signUp(form.email.value, form.password.value);
    logDevLink(form.email.value);
    showCheck(form.email.value);
  });
  handle('forgot-form', async (form) => {
    await forgotPassword(form.email.value);
    logDevLink(form.email.value);
    showCheck(form.email.value);
    showMessage('If that email has an account, a reset link is on its way.', 'info');
  });
  handleProvider('google-signin', signInWithGoogle);
  handleProvider('facebook-signin', signInWithFacebook);
  if (new URLSearchParams(location.search).has('confirmed')) {
    showMessage('Thanks — you’re all set. Please sign in.', 'info');
  }
  try {
    if (await isSignedIn()) {
      location.replace('/portal.html');
    }
  } catch (error) {
    showMessage(error.message, 'error');
  }
}

/**
 * Runs a form's action on submit, disabling its button and showing any error.
 * @param {string} id the form id
 * @param {(form: HTMLFormControlsCollection) => Promise<void>} action what to do
 */
function handle(id, action) {
  const form = document.getElementById(id);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    hideMessage();
    try {
      await action(form.elements);
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

/**
 * Wires a "Sign in with …" button. On success it opens the portal; a new account whose email
 * still needs confirming sees the "check your email" panel.
 * @param {string} id the button id
 * @param {() => Promise<void>} signInWith the provider's sign-in
 */
function handleProvider(id, signInWith) {
  const button = document.getElementById(id);
  button.addEventListener('click', async () => {
    button.disabled = true;
    hideMessage();
    try {
      await signInWith();
      location.assign('/portal.html');
    } catch (error) {
      if (error.code === 'auth/unverified' && error.email) {
        // A normal first step, not a failure: the "check your email" panel says it all.
        logDevLink(error.email);
        showCheck(error.email);
        return;
      }
      showMessage(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

/**
 * On `npm run dev` only (its config names the Auth emulator), prints the newest link the
 * emulator "emailed" to this address in the browser console, since nothing is really emailed
 * locally. Does nothing deployed.
 * @param {string} email the address the link went to
 */
async function logDevLink(email) {
  try {
    const config = await loadConfig();
    if (!config.emulatorUrl) {
      return;
    }
    const address = email.trim().toLowerCase();
    const response = await fetch(`${config.emulatorUrl}/emulator/v1/projects/${config.projectId}/oobCodes`, { cache: 'no-store' });
    const { oobCodes = [] } = await response.json();
    const latest = oobCodes.filter((entry) => entry.email === address).pop();
    console.log(latest ? `%cLocal dev: link for ${address}: ${latest.oobLink}` : `Local dev: no link for ${address}.`, 'font-size: 14px; font-weight: bold');
  } catch (error) {
    console.log('Local dev: could not read the emulator’s emailed links.', error);
  }
}

/**
 * Shows the "check your email" step.
 * @param {string} email where the link went
 */
function showCheck(email) {
  document.getElementById('check-email').textContent = email.trim().toLowerCase();
  show('check');
}

/**
 * Shows one panel and hides the rest, moving focus to its first field.
 * @param {string} name the panel id
 */
function show(name) {
  hideMessage();
  for (const panel of PANELS) {
    document.getElementById(panel).hidden = panel !== name;
  }
  document.querySelector(`#${name} input`)?.focus();
}

/**
 * Shows a message above the form.
 * @param {string} text the message
 * @param {'error'|'info'} kind its style
 */
function showMessage(text, kind) {
  const box = document.getElementById('message');
  box.textContent = text;
  box.className = `message ${kind}`;
  box.hidden = false;
}

/** Hides the message. */
function hideMessage() {
  document.getElementById('message').hidden = true;
}

main();
