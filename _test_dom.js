/* Headless test: drive the opponent-peek flow with a fake DOM and confirm it
   resolves (no crash, modal shows the card). Run: node _test_dom.js */
const fs = require('fs');

const ID_INDEX = {};
class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parent = null;
    this._id = ''; this.className = ''; this.dataset = {}; this.style = {};
    this._html = ''; this._listeners = {}; this.textContent = ''; this.offsetWidth = 10;
    const set = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => set.add(x)),
      remove: (...c) => c.forEach(x => set.delete(x)),
      toggle: (c, on) => { if (on === undefined) (set.has(c) ? set.delete(c) : set.add(c)); else if (on) set.add(c); else set.delete(c); },
      contains: (c) => set.has(c),
      _set: set,
    };
  }
  set id(v) { this._id = v; ID_INDEX[v] = this; }
  get id() { return this._id; }
  set innerHTML(v) {
    this._html = v; this.children = [];
    const re = /id="([^"]+)"/g; let m;
    while ((m = re.exec(v))) { const e = new El('div'); e.id = m[1]; this.appendChild(e); }
  }
  get innerHTML() { return this._html; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  replaceWith(n) { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children[i] = n; n.parent = this.parent; } }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  click() { (this._listeners['click'] || []).forEach((fn) => fn()); }
  querySelector(sel) { return ID_INDEX[sel.replace(/^#/, '')] || null; }
  querySelectorAll() { return []; }
  get firstElementChild() { return this.children[0]; }
}

function mk(id) { const e = new El('div'); e.id = id; return e; }
// static DOM matching index.html ids used by the code
['status', 'opponents', 'humanGrid', 'drawCount', 'drawCard', 'log', 'stackBarWrap', 'stackBar', 'actionBar', 'overlay', 'modal'].forEach(mk);
const humanArea = mk('humanArea');
humanArea.appendChild(mk('humanName'));
humanArea.appendChild(mk('humanGrid')); // will be re-resolved by id anyway
const discardPile = new El('div'); discardPile.appendChild(mk('discardCard'));

const document = {
  createElement: (t) => new El(t),
  querySelector: (sel) => ID_INDEX[sel.replace(/^#/, '')] || null,
  querySelectorAll: () => [],
};
const windowStub = { addEventListener: () => {} };

const code = fs.readFileSync(__dirname + '/game.js', 'utf8');
const wrapped = new Function(
  'module', 'exports', 'document', 'window', 'setTimeout', 'clearTimeout', 'console', 'Math',
  code + '\n;module.exports = { G, newGame, humanUsePower, onCardClick, render, chooseTurnAction, topDiscard };'
);
const mod = { exports: {} };
wrapped(mod, mod.exports, document, windowStub, setTimeout, clearTimeout, console, Math);
const { G, newGame, humanUsePower, onCardClick, render, chooseTurnAction, topDiscard } = mod.exports;

const tick = () => new Promise((r) => setImmediate(r));
function assert(c, m) { if (!c) throw new Error('ASSERT FAILED: ' + m); }

(async () => {
  newGame(4);
  render(); // must not throw
  console.log('✓ render() with no active pick: OK');

  // Simulate the human discarding a 9 (peek-opponent power) and using it.
  const card = { rank: '9', suit: '♠', value: 9, power: 'peekOpp' };
  let resolved = false, error = null;
  const p = humanUsePower(card).then(() => { resolved = true; }).catch((e) => { error = e; });

  await tick();
  if (error) throw error;
  assert(G.mode === 'pickSlot', 'after discarding 9, mode should be pickSlot, got ' + G.mode);
  console.log('✓ pickSlot mode active, opponent cards selectable, render did not crash');

  // Click opponent #1's card slot 0
  onCardClick(1, 0);
  await tick();
  if (error) throw error;
  assert(G.peekReveal && G.peekReveal.owner === 1, 'peekReveal should be set to the clicked opponent card');
  console.log('✓ clicked opponent card → peekReveal set (card flips face-up on table)');

  // The reveal modal should now be open with an OK button
  const ok = ID_INDEX['ok'];
  assert(ok, 'reveal modal OK button should exist');
  console.log('✓ reveal popup rendered with the card');
  ok.click();
  await tick();
  if (error) throw error;
  assert(resolved, 'humanUsePower should resolve after dismissing the reveal');
  assert(G.peekReveal === null, 'peekReveal should clear after reveal');
  console.log('✓ dismissed reveal, flow completed cleanly');

  console.log('\nALL GOOD — opponent peek works end-to-end.');

  // ---- Discard pile must NOT be takeable ----
  console.log('\n--- discard is output-only ---');
  newGame(4);
  render();
  const pTurn = chooseTurnAction();
  await tick();
  const discEl = ID_INDEX['discardCard'];
  assert(discEl && !discEl.classList.contains('selectable'), 'discard pile must NOT be clickable/selectable');
  const bar = ID_INDEX['actionBar'];
  const hasTake = bar.children.some((b) => /take/i.test(b.textContent || ''));
  assert(!hasTake, 'there should be no "Take discard" button');
  const onlyDraw = bar.children.length === 1 && /draw/i.test(bar.children[0].textContent);
  assert(onlyDraw, 'the only turn button should be "Draw from pile"');
  console.log('✓ no take-from-discard: discard not clickable, only "Draw from pile" offered');

  console.log('\nALL GOOD — discard pile is output-only.');
})().catch((e) => { console.error('\n✗ TEST FAILED:', e.message); process.exit(1); });
