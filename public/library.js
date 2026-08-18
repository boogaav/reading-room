// A library: the same shelf, with a name on the door.
//
// The spines are rendered by the shared shelf module, so a library and the home
// page cannot drift apart visually — the only difference here is that the owner
// can take a book off the shelf.

import { wireThemeToggle } from '/theme.js';
import { wireVoice } from '/voice.js';
import { renderShelf } from '/shelf.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const username = decodeURIComponent(location.pathname.slice(1).split('/')[0] || '');
const state = { library: null, mine: false };

boot();

async function boot() {
  wireThemeToggle($('themeBtn'));
  document.title = `${username} — Reading Room`;

  let res, data;
  try {
    res = await fetch(`/api/library/${encodeURIComponent(username)}`);
    data = await res.json();
  } catch {
    return fail('Could not reach the server.');
  }

  if (res.status === 404) return unclaimed();
  if (!res.ok) return fail(data.error || 'Could not open this library.');

  state.library = data.library;
  state.mine = !!data.mine;
  paint();
}

// ---- the door ------------------------------------------------------------

/**
 * An unclaimed name and a private one answer identically, so visiting a name
 * cannot be used to discover whether it exists.
 */
function unclaimed() {
  $('libTitle').textContent = username;
  $('libSub').textContent = 'No library here yet.';
  $('shelfLoading')?.remove();

  const wrap = $('shelves');
  wrap.classList.add('empty-shelf');
  wrap.innerHTML =
    `<div class="claim">
       <h2 class="hall-label">Open this library</h2>
       <p class="claim-note">Pick a secret code and <b>${esc(username)}</b> is yours. Come back with the
         same name and code from any browser and your shelf is here.</p>
       <form class="claim-form" id="claimForm">
         <input id="code" type="password" autocomplete="new-password" minlength="8"
                placeholder="secret code, at least 8 characters" aria-label="Secret code">
         <button type="submit">Open</button>
       </form>
       <p class="claim-err" id="claimErr"></p>
       <p class="claim-warn">This is a soft lock on a shelf, not an account. There is no email and
         <b>no way to reset the code</b> — if you lose it the name stays taken. Please do not reuse a
         password you use anywhere else.</p>
     </div>`;

  $('claimForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('claimErr');
    err.textContent = '';
    const code = $('code').value;

    let out;
    try {
      const r = await fetch('/api/library/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, code }),
      });
      out = await r.json();
      if (!r.ok) { err.textContent = out.error || 'That did not work.'; return; }
    } catch { err.textContent = 'Could not reach the server.'; return; }

    state.library = out.library;
    state.mine = true;
    paint();
  });
}

function fail(message) {
  $('libTitle').textContent = username;
  $('libSub').textContent = '';
  $('shelves').innerHTML = `<p class="shelf-empty">${esc(message)}</p>`;
}

// ---- the shelf -----------------------------------------------------------

function paint() {
  const lib = state.library;
  $('libTitle').textContent = lib.title || `${lib.username}'s library`;
  $('libSub').textContent = `${lib.items.length} volume${lib.items.length === 1 ? '' : 's'}`
    + (lib.visibility === 'private' ? ' · private' : '');

  paintActions();

  const wrap = $('shelves');
  wrap.classList.remove('empty-shelf');
  wrap.replaceChildren();

  if (!lib.items.length) {
    wrap.innerHTML = `<p class="shelf-empty">Nothing on the shelf yet. Open any book or atlas and
      press <b>＋</b> in its header to put it here.</p>`;
    return;
  }

  renderShelf(wrap, lib.items, {
    removable: state.mine,
    onRemove: async (item) => {
      const r = await fetch(`/api/library/${encodeURIComponent(lib.username)}/items?href=${encodeURIComponent(item.href)}`,
        { method: 'DELETE' });
      const out = await r.json();
      if (out.library) { state.library = out.library; paint(); }
    },
  });
}

function paintActions() {
  const box = $('libActions');
  box.replaceChildren();
  if (!state.mine) return;

  const vis = document.createElement('button');
  vis.className = 'lib-btn';
  vis.textContent = state.library.visibility === 'private' ? 'Private' : 'Public';
  vis.title = 'Who can see this library';
  vis.onclick = async () => {
    const next = state.library.visibility === 'private' ? 'public' : 'private';
    const r = await fetch(`/api/library/${encodeURIComponent(state.library.username)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: next }),
    });
    const out = await r.json();
    if (out.library) { state.library = out.library; paint(); }
  };

  const out = document.createElement('button');
  out.className = 'lib-btn';
  out.textContent = 'Close';
  out.title = 'Sign out of this library';
  out.onclick = async () => {
    await fetch('/api/library/close', { method: 'POST' });
    location.reload();
  };

  box.append(vis, out);
}

// ---- read aloud ----------------------------------------------------------

wireVoice($('voiceBtn'), {
  lang: 'en',
  collect: () => {
    const lib = state.library;
    if (!lib) return [];
    const out = [{ text: `${lib.title}. ${lib.items.length} volumes.`, label: 'Library' }];
    for (const v of document.querySelectorAll('.vol')) {
      const title = v.querySelector('.vol-front-title')?.textContent;
      if (title) out.push({ text: title, label: title, node: v, lang: v.querySelector('.vol-lang')?.textContent || 'en' });
    }
    return out;
  },
});
