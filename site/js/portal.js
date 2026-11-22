// The owner portal: what the signed-in person owns and owes, and (for admins) every lot and the
// sign-up requests. All text from the sheet is inserted with textContent, never as HTML.
import { api, goToLogin, isSignedIn, signOut } from './auth.js';
import { showLotMap } from './lot-map.js';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
/** Every lot, for the admin table (replaced after each approval). */
let adminLots = [];
let filterWired = false;
/** Every owner record with contact details, by owner ID (admins only). */
let ownerContacts = new Map();
/** The owner record open in the contact window. */
let openOwnerId = '';
/** The board's email (from /api/me, so it never sits in the published HTML). */
let boardEmail = '';

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
    boardEmail = me.boardEmail || '';
    document.querySelectorAll('a[data-board-email]').forEach(linkToBoard);
    if (me.kind === 'member') {
      showMember(me);
      if (me.allLots) {
        showAdmin(me.allLots);
        showTabs();
        wireOwnerDialog();
        await Promise.all([loadRequests(), loadOwners()]);
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
 * Points an "Ask the board" link at an email to the board, with its `data-subject` as the subject.
 * Without the address the link stays plain text.
 * @param {HTMLAnchorElement} link
 */
function linkToBoard(link) {
  if (!boardEmail) {
    return;
  }
  const subject = link.dataset.subject;
  link.href = `mailto:${boardEmail}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
}

/**
 * Makes an "Ask the board" email link.
 * @param {string} text the link text
 * @param {string} subject the email's subject
 * @returns {HTMLAnchorElement}
 */
function boardLink(text, subject) {
  const link = el('a', { 'data-board-email': '', 'data-subject': subject }, text);
  linkToBoard(link);
  return link;
}

/**
 * Fills in the owner view.
 * @param {any} me the /api/me answer
 */
function showMember(me) {
  document.getElementById('greeting').textContent = `Hello, ${me.name}`;
  const gate = document.getElementById('gate-code');
  if (me.gateCode) {
    gate.textContent = me.gateCode;
  } else {
    gate.replaceChildren(boardLink('Ask the board', 'Gate code'));
  }
  const owed = document.getElementById('total-owed');
  owed.textContent = me.totalOwed > 0 ? money.format(me.totalOwed) : me.totalOwed < 0 ? `${money.format(-me.totalOwed)} credit` : 'Nothing';
  owed.classList.toggle('ok', me.totalOwed <= 0);
  document.getElementById('lot-count').textContent = me.lots.length ? me.lots.map((lot) => lot.lot).join(', ') : 'None on record';
  const mapSlot = document.getElementById('lot-map');
  showLotMap(mapSlot, me.lots.map((lot) => lot.lot)).catch((error) => {
    mapSlot.replaceChildren(el('p', { class: 'muted' }, error.message));
  });
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
  if (me.canMessageBoard) {
    wireBoardForm(me.email);
  }
  document.getElementById('member').hidden = false;
}

/**
 * Shows the "Message the board" form and sends it through the API.
 * @param {string} email the owner's email, which the board replies to
 */
function wireBoardForm(email) {
  document.getElementById('board-reply-to').textContent = email;
  document.getElementById('board-form').addEventListener('submit', sendBoardMessage);
  document.getElementById('board-message').hidden = false;
}

/**
 * Sends the board form, then clears it and says so (or shows why it couldn't be sent).
 * @param {SubmitEvent} event the form's submit event
 */
async function sendBoardMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type=submit]');
  const status = document.getElementById('board-status');
  const fields = form.elements;
  button.disabled = true;
  status.hidden = true;
  try {
    await api('/api/messages', { method: 'POST', body: { subject: fields.namedItem('subject').value, message: fields.namedItem('message').value } });
    form.reset();
    status.className = 'sent';
    status.textContent = 'Sent. The board will reply by email.';
  } catch (error) {
    status.className = 'failed';
    status.textContent = error.message;
  } finally {
    status.hidden = false;
    button.disabled = false;
  }
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
}

/**
 * Shows admins the Owner / Admin tabs, starting on the Owner page so it looks the same as every
 * other owner's. The admin tools stay out of sight until the Admin tab is picked.
 */
function showTabs() {
  const tabs = document.getElementById('view-tabs');
  for (const tab of tabs.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => selectTab(tab.dataset.view));
  }
  tabs.hidden = false;
  selectTab('member');
}

/**
 * Shows one view (the owner page or the admin tools) and marks its tab as picked.
 * @param {string} view the id of the section to show: "member" or "admin"
 */
function selectTab(view) {
  for (const tab of document.querySelectorAll('#view-tabs [role="tab"]')) {
    const picked = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(picked));
    document.getElementById(tab.dataset.view).hidden = !picked;
  }
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
      ownerLinks(lot.people, 'name'),
      ownerLinks(lot.people, 'taxName'),
      lot.status || '—',
      num(money.format(lot.balance)),
      lot.gateCodes.join(', ') || '—',
      lot.hasLogin ? 'Yes' : 'No',
    ]),
  );
}

/**
 * Builds a table cell's worth of name links, one per owner record, that open the contact window.
 * A name shared by two records (one tax name for a couple) is shown once.
 * @param {Array<{id: string, name: string, taxName: string}>} people the lot's owner records
 * @param {'name'|'taxName'} key which name to show
 * @returns {Node} the links, or a dash when there are none
 */
function ownerLinks(people, key) {
  const seen = new Set();
  const box = document.createDocumentFragment();
  for (const person of people) {
    const label = person[key];
    if (!label || seen.has(label)) {
      continue;
    }
    seen.add(label);
    const link = el('button', { type: 'button', class: 'link', title: 'Contact details' }, label);
    link.addEventListener('click', () => openOwner(person.id));
    box.append(link);
  }
  return box.childNodes.length ? box : document.createTextNode('—');
}

/**
 * Loads every owner record's contact details for the contact window.
 */
async function loadOwners() {
  const { owners } = await api('/api/admin/owners');
  ownerContacts = new Map(owners.map((owner) => [owner.id, owner]));
}

/**
 * Wires the contact window's buttons and form once.
 */
function wireOwnerDialog() {
  const dialog = document.getElementById('owner-dialog');
  for (const button of dialog.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => dialog.close());
  }
  document.getElementById('owner-edit').addEventListener('click', showOwnerForm);
  document.getElementById('owner-form').addEventListener('submit', saveOwner);
}

/**
 * Opens the contact window for one owner record: the details when there are any, otherwise
 * straight to the form so they can be filled in.
 * @param {string} id the owner ID
 */
async function openOwner(id) {
  if (!ownerContacts.has(id)) {
    // Not loaded yet, or the first load failed: try once more and say why if it fails again.
    try {
      await loadOwners();
    } catch (error) {
      showMessage(`Couldn't load the owner records: ${error.message}`);
      return;
    }
  }
  const owner = ownerContacts.get(id);
  if (!owner) {
    showMessage('That owner record is no longer in the sheet. Refresh the page.');
    return;
  }
  openOwnerId = id;
  document.getElementById('owner-title').textContent = owner.name || owner.taxName || owner.id;
  const facts = [
    owner.name && owner.taxName ? `Tax record: ${owner.taxName}` : '',
    owner.lots.length ? `Lot ${owner.lots.join(', ')}` : 'No lots',
    owner.role === 'Admin' ? 'Board admin' : '',
    owner.active ? '' : 'Inactive (no longer an owner)',
  ];
  document.getElementById('owner-summary').textContent = facts.filter((fact) => fact).join(' · ');
  document.getElementById('owner-message').hidden = true;
  const hasAny = owner.emails.length > 0 || owner.phone || owner.mailingAddress;
  if (hasAny) {
    showOwnerView(owner);
  } else {
    showOwnerForm();
  }
  document.getElementById('owner-dialog').showModal();
}

/**
 * Shows an owner's details, with email and phone as links that start an email or a call.
 * @param {any} owner the owner record
 */
function showOwnerView(owner) {
  const details = document.getElementById('owner-details');
  details.replaceChildren();
  const emails = document.createDocumentFragment();
  owner.emails.forEach((email, index) => {
    emails.append(index ? ', ' : '', el('a', { href: `mailto:${encodeURIComponent(email)}` }, email));
  });
  const phone = owner.phone ? el('a', { href: `tel:${owner.phone.replace(/[^\d+]/g, '')}` }, owner.phone) : '—';
  for (const [label, value] of [
    ['Email', owner.emails.length ? emails : '—'],
    ['Phone', phone],
    ['Mailing address', owner.mailingAddress || '—'],
  ]) {
    const dd = el('dd');
    dd.append(value);
    details.append(el('dt', {}, label), dd);
  }
  document.getElementById('owner-form').hidden = true;
  document.getElementById('owner-view').hidden = false;
}

/**
 * Switches the contact window to the form, filled with what is on record.
 */
function showOwnerForm() {
  const owner = ownerContacts.get(openOwnerId);
  const form = document.getElementById('owner-form');
  const fields = form.elements;
  fields.namedItem('emails').value = owner.emails.join(', ');
  fields.namedItem('phone').value = owner.phone;
  fields.namedItem('mailingAddress').value = owner.mailingAddress;
  // An admin's email decides who is an admin, and an Inactive record's would gain a login the
  // day it's set back to Active, so both are only changed in the sheet itself.
  const isAdmin = owner.role === 'Admin';
  const emailLocked = isAdmin || !owner.active;
  fields.namedItem('emails').readOnly = emailLocked;
  let note = 'Each email here can sign in and see this owner’s lots and gate code. Separate several with commas.';
  if (isAdmin) {
    note = 'Board admin emails can only be changed in the sheet itself.';
  } else if (!owner.active) {
    note = 'This record is Inactive, so its emails can only be changed in the sheet itself.';
  }
  document.getElementById('owner-email-note').textContent = note;
  document.getElementById('owner-view').hidden = true;
  form.hidden = false;
  fields.namedItem(emailLocked ? 'phone' : 'emails').focus();
}

/**
 * Saves the contact form to the sheet, then refreshes the owner records and the lot table
 * (a new email changes the Login column).
 * @param {SubmitEvent} event the form's submit
 */
async function saveOwner(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button[type=submit]');
  const fields = form.elements;
  const loaded = ownerContacts.get(openOwnerId);
  button.disabled = true;
  try {
    await api('/api/admin/owners/contact', {
      method: 'POST',
      body: {
        ownerId: openOwnerId,
        emails: fields.namedItem('emails').value,
        phone: fields.namedItem('phone').value,
        mailingAddress: fields.namedItem('mailingAddress').value,
        // What this page showed, so the server can refuse if the sheet changed since.
        previous: { emails: loaded.emails, phone: loaded.phone, mailingAddress: loaded.mailingAddress },
      },
    });
    const [me] = await Promise.all([api('/api/me'), loadOwners()]);
    showAdmin(me.allLots);
    showOwnerView(ownerContacts.get(openOwnerId));
    const note = document.getElementById('owner-message');
    note.textContent = 'Saved to the owner records.';
    note.className = 'message info';
    note.hidden = false;
  } catch (error) {
    const note = document.getElementById('owner-message');
    note.textContent = error.message;
    note.className = 'message error';
    note.hidden = false;
    // If the sheet changed underneath us, reopening the name should show the latest.
    loadOwners().catch(() => {});
  } finally {
    button.disabled = false;
  }
}

/**
 * Loads and shows pending sign-up requests, each with an owner picker and Approve / Reject.
 */
async function loadRequests() {
  const { requests, owners } = await api('/api/admin/requests');
  const list = document.getElementById('requests');
  list.replaceChildren();
  document.getElementById('requests-empty').hidden = requests.length > 0;
  const count = document.getElementById('request-count');
  count.textContent = String(requests.length);
  count.hidden = requests.length === 0;
  count.title = `${requests.length} sign-up ${requests.length === 1 ? 'request' : 'requests'} waiting`;
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
    await Promise.all([loadRequests(), loadOwners()]);
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
      const note = el('p', { class: 'message info' }, 'The board couldn’t match your last request to a lot. Check the details and try again, or ');
      note.append(boardLink('talk to a board member', 'My sign-up request'), '.');
      status.append(note);
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
 * Replaces a table body's rows. A cell is text, a DOM node (e.g. links), or {text, num: true}
 * for a right-aligned number.
 * @param {string} id the tbody id
 * @param {Array<Array<string|Node|{text: string, num: boolean}>>} rows
 */
function fillRows(id, rows) {
  const body = document.getElementById(id);
  body.replaceChildren(
    ...rows.map((cells) => {
      const row = el('tr');
      for (const cell of cells) {
        if (cell instanceof Node) {
          const td = el('td');
          td.append(cell);
          row.append(td);
        } else {
          row.append(typeof cell === 'object' ? el('td', { class: 'num' }, cell.text) : el('td', {}, String(cell ?? '')));
        }
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
