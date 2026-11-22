// The login page: sign in, create an account, confirm the emailed code, reset a password.
import { confirmForgotPassword, confirmSignUp, forgotPassword, isSignedIn, loadConfig, resendCode, signIn, signUp } from './auth.js';

const PANELS = ['signin', 'signup', 'confirm', 'forgot', 'reset'];
/** Remembered between steps so a new account signs in right after its code is confirmed. */
const pending = { email: '', password: '' };

/**
 * Wires up the page once it has loaded.
 */
function main() {
  if (isSignedIn()) {
    location.replace('/portal.html');
    return;
  }
  loadConfig().catch((error) => showMessage(error.message, 'error'));
  for (const button of document.querySelectorAll('[data-show]')) {
    button.addEventListener('click', () => show(button.dataset.show));
  }
  handle('signin-form', async (form) => {
    pending.email = form.email.value;
    pending.password = form.password.value;
    try {
      await signIn(pending.email, pending.password);
      location.assign('/portal.html');
    } catch (error) {
      if (error.code === 'UserNotConfirmedException') {
        const since = Date.now();
        await resendCode(pending.email);
        logDevCode(pending.email, since);
        showConfirm('Please confirm your email first. We just sent you a new code.');
        return;
      }
      throw error;
    }
  });
  handle('signup-form', async (form) => {
    pending.email = form.email.value;
    pending.password = form.password.value;
    const since = Date.now();
    await signUp(pending.email, pending.password);
    logDevCode(pending.email, since);
    showConfirm();
  });
  handle('confirm-form', async (form) => {
    await confirmSignUp(pending.email, form.code.value);
    if (pending.password) {
      await signIn(pending.email, pending.password);
      location.assign('/portal.html');
      return;
    }
    show('signin');
    showMessage('Email confirmed. Please sign in.', 'info');
  });
  handle('forgot-form', async (form) => {
    pending.email = form.email.value;
    const since = Date.now();
    await forgotPassword(pending.email);
    logDevCode(pending.email, since);
    document.getElementById('reset-email').textContent = pending.email.trim().toLowerCase();
    show('reset');
    showMessage('If that email has an account, a code is on its way.', 'info');
  });
  handle('reset-form', async (form) => {
    await confirmForgotPassword(pending.email, form.code.value, form.password.value);
    show('signin');
    document.querySelector('#signin-form [name=email]').value = pending.email;
    showMessage('Password saved. Please sign in.', 'info');
  });
  document.getElementById('resend').addEventListener('click', async () => {
    try {
      const since = Date.now();
      await resendCode(pending.email);
      logDevCode(pending.email, since);
      showMessage('A new code is on its way.', 'info');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  });
}

/**
 * Runs a form's action on submit, disabling its button and showing any error.
 * @param {string} id the form id
 * @param {(form: HTMLFormElement) => Promise<void>} action what to do
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
 * On `npm run dev` only (its config sets devCodes), prints the code cognito-local "emailed" in
 * the browser console, since nothing is really emailed locally. Polls briefly because the dev
 * server reads the code from Docker's log a moment after Cognito answers. Does nothing deployed.
 * @param {string} email the address the code went to
 * @param {number} since only a code sent at or after this time (ms) counts, not an older one
 */
async function logDevCode(email, since) {
  const config = await loadConfig();
  if (config.devCodes !== 'true') {
    return;
  }
  const address = email.trim().toLowerCase();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`/dev/code?email=${encodeURIComponent(address)}`, { cache: 'no-store' });
    const found = await response.json();
    if (found.code && found.sentAt >= since - 1000) {
      console.log(`%cLocal dev: code for ${address} is ${found.code}`, 'font-size: 16px; font-weight: bold');
      return;
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
  console.log(`Local dev: no code showed up for ${address}. If the account doesn't exist, none is sent.`);
}

/**
 * Shows the code step for the remembered email.
 * @param {string} [note] an extra message to show
 */
function showConfirm(note) {
  document.getElementById('confirm-email').textContent = pending.email.trim().toLowerCase();
  show('confirm');
  if (note) {
    showMessage(note, 'info');
  }
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
