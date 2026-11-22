// The owner portal: what the signed-in person owns and owes, and (for admins) every lot and the
// sign-up requests. All text from the sheet is inserted with textContent, never as HTML.
import { api, goToLogin, isSignedIn, signOut } from './auth.js';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
/** Every lot, for the admin table (replaced after each approval). */
let adminLots = [];
let filterWired = false;

/**
 * Loads the account and shows the right view.
 */
async function main() {
  if (!isSignedIn()) {
    goToLogin();
    return;
  }
  document.getElementById('sign-out').addEventListener('click', () => {
    signOut();
    location.assign('/');
  });
  try {
    const me = await api('/api/me');
    document.getElementById('signed-in-as').textContent = `Signed in as ${me.email}`;
    if (me.kind === 'member') {
      showMember(me);
      if (me.allLots) {
        showAdmin(me.allLots);
        await loadRequests();
      }
    } else {
      showVisitor(me);
    }
  } catch (error) {
    document.getElementById('greeting').textContent = 'My account';
    showMessage(error.message);
  }
}

/**
 * Fills in the owner view.
 * @param {any} me the /api/me answer
 */
function showMember(me) {
  document.getElementById('greeting').textContent = `Hello, ${me.name}`;
  document.getElementById('gate-code').textContent = me.gateCode || 'Ask the board';
  const owed = document.getElementById('total-owed');
  owed.textContent = me.totalOwed > 0 ? money.format(me.totalOwed) : me.totalOwed < 0 ? `${money.format(-me.totalOwed)} credit` : 'Nothing';
  owed.classList.toggle('ok', me.totalOwed <= 0);
  document.getElementById('lot-count').textContent = me.lots.length ? me.lots.map((lot) => lot.lot).join(', ') : 'None on record';
  fillRows(
    'my-lots',
    me.lots.map((lot) => [lot.lot, lot.status || '—', lot.owners.join(', ') || '—', lot.taxNames.join('; ') || '—', num(money.format(lot.annualDues)), num(money.format(lot.balance))]),
  );
  fillRows(
    'ledger',
    me.ledger.map((entry) => [
      entry.date,
      entry.lot,
      entry.description,
      num(entry.charge ? money.format(entry.charge) : ''),
      num(entry.payment ? money.format(entry.payment) : ''),
      entry.method,
    ]),
  );
  document.getElementById('ledger-empty').hidden = me.ledger.length > 0;
  document.getElementById('ledger-wrap').hidden = me.ledger.length === 0;
  document.getElementById('member').hidden = false;
}

/**
 * Fills in the admin table of every lot, with a filter box.
 * @param {any[]} lots every lot
 */
function showAdmin(lots) {
  adminLots = lots;
  if (!filterWired) {
    document.getElementById('lot-filter').addEventListener('input', renderAllLots);
    filterWired = true;
  }
  renderAllLots();
  const total = lots.reduce((sum, lot) => sum + Math.max(lot.balance, 0), 0);
  document.getElementById('all-total').textContent = `${lots.length} lots · ${money.format(total)} owed in total`;
  document.getElementById('admin').hidden = false;
}

/**
 * Draws the all-lots table, keeping only rows that match the filter box (lot number or owner name).
 */
function renderAllLots() {
  const query = document.getElementById('lot-filter').value.trim().toLowerCase();
  const shown = adminLots.filter(
    (lot) => !query || lot.lot === query || [...lot.owners, ...lot.taxNames].join(' ').toLowerCase().includes(query),
  );
  fillRows(
    'all-lots',
    shown.map((lot) => [
      lot.lot,
      lot.owners.join(', ') || '—',
      lot.taxNames.join('; ') || '—',
      lot.status || '—',
      num(money.format(lot.balance)),
      lot.gateCodes.join(', ') || '—',
      lot.hasLogin ? 'Yes' : 'No',
    ]),
  );
}

/**
 * Loads and shows pending sign-up requests, each with an owner picker and Approve / Reject.
 */
async function loadRequests() {
  const { requests, owners } = await api('/api/admin/requests');
  const list = document.getElementById('requests');
  list.replaceChildren();
  document.getElementById('requests-empty').hidden = requests.length > 0;
  for (const request of requests) {
    list.append(requestCard(request, owners));
  }
}

/**
 * Builds one request card.
 * @param {any} request the pending request
 * @param {any[]} owners every active owner record
 * @returns {HTMLElement}
 */
function requestCard(request, owners) {
  const card = el('div', { class: 'card request' });
  const details = el('dl');
  for (const [label, value] of [
    ['Name', request.name],
    ['Email', request.email],
    ['Phone', request.phone || '—'],
    ['Says they own', request.lotsClaimed],
    ['Asked on', request.submitted],
  ]) {
    details.append(el('dt', {}, label), el('dd', {}, value));
  }
  const select = el('select', { 'aria-label': `Owner record for ${request.email}` });
  select.append(el('option', { value: '' }, 'Choose the owner record…'));
  const suggested = new Set(request.suggestedOwnerIds);
  const ordered = [...owners.filter((owner) => suggested.has(owner.id)), ...owners.filter((owner) => !suggested.has(owner.id))];
  for (const owner of ordered) {
    const lots = owner.lots.length ? `lot ${owner.lots.join(', ')}` : 'no lots';
    const label = `${suggested.has(owner.id) ? '★ ' : ''}${owner.name} (${lots})${owner.hasEmail ? ' · has a login' : ''}`;
    select.append(el('option', { value: owner.id }, label));
  }
  const approve = el('button', { type: 'button' }, 'Approve');
  const reject = el('button', { type: 'button', class: 'danger' }, 'Reject');
  approve.addEventListener('click', () => {
    if (!select.value) {
      showMessage('Choose which owner record this person belongs to first.');
      select.focus();
      return;
    }
    review(card, 'approve', { email: request.email, ownerId: select.value });
  });
  reject.addEventListener('click', () => {
    if (confirm(`Reject the request from ${request.email}?`)) {
      review(card, 'reject', { email: request.email });
    }
  });
  const picker = el('label', {}, 'Link to owner record');
  picker.append(select);
  const actions = el('div', { class: 'actions' });
  actions.append(picker, approve, reject);
  card.append(details, actions);
  return card;
}

/**
 * Sends an approve/reject decision, then reloads the page data.
 * @param {HTMLElement} card the request's card (its buttons are disabled meanwhile)
 * @param {'approve'|'reject'} decision
 * @param {object} body what to send
 */
async function review(card, decision, body) {
  for (const button of card.querySelectorAll('button')) {
    button.disabled = true;
  }
  try {
    await api(`/api/admin/requests/${decision}`, { method: 'POST', body });
    showMessage(decision === 'approve' ? `Approved. ${body.email} can now see their account.` : `Rejected the request from ${body.email}.`, 'info');
    const me = await api('/api/me');
    showAdmin(me.allLots);
    await loadRequests();
  } catch (error) {
    showMessage(error.message);
    for (const button of card.querySelectorAll('button')) {
      button.disabled = false;
    }
  }
}

/**
 * Shows the "not on the owner list yet" view: the request status, or the request form.
 * @param {any} me the /api/me answer
 */
function showVisitor(me) {
  document.getElementById('greeting').textContent = 'Welcome';
  const status = document.getElementById('request-status');
  const form = document.getElementById('request-form');
  if (me.request?.status === 'Pending') {
    status.append(
      el('h2', { style: 'margin-top:0' }, 'Your request is with the board'),
      el('p', {}, `You asked on ${me.request.submitted}. Once a board member checks the county records, this page will show your lots, balance and gate code.`),
    );
  } else {
    if (me.request?.status === 'Rejected') {
      status.append(el('p', { class: 'message info' }, 'The board couldn’t match your last request to a lot. Check the details and try again, or talk to a board member.'));
    }
    form.hidden = false;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        const fields = form.elements;
        await api('/api/requests', { method: 'POST', body: { name: fields.namedItem('name').value, lots: fields.namedItem('lots').value, phone: fields.namedItem('phone').value } });
        location.reload();
      } catch (error) {
        showMessage(error.message);
        button.disabled = false;
      }
    });
  }
  document.getElementById('visitor').hidden = false;
}

/**
 * Replaces a table body's rows. A cell is text, or {text, num: true} for a right-aligned number.
 * @param {string} id the tbody id
 * @param {Array<Array<string|{text: string, num: boolean}>>} rows
 */
function fillRows(id, rows) {
  const body = document.getElementById(id);
  body.replaceChildren(
    ...rows.map((cells) => {
      const row = el('tr');
      for (const cell of cells) {
        row.append(typeof cell === 'object' ? el('td', { class: 'num' }, cell.text) : el('td', {}, String(cell ?? '')));
      }
      return row;
    }),
  );
}

/**
 * Marks a cell as a right-aligned number.
 * @param {string} text
 * @returns {{text: string, num: boolean}}
 */
function num(text) {
  return { text, num: true };
}

/**
 * Creates an element with attributes and text.
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, value);
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/**
 * Shows a message at the top of the page.
 * @param {string} text
 * @param {'error'|'info'} [kind]
 */
function showMessage(text, kind = 'error') {
  const box = document.getElementById('message');
  box.textContent = text;
  box.className = `message ${kind}`;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}

main();
