/* ============================================================
   CABO — browser edition (you vs AI bots)
   Vanilla JS, no build step. Open index.html directly.
   ============================================================ */

/* ---------- Constants & card model ---------- */
const SUITS = ['♠', '♥', '♦', '♣']; // spade, heart, diamond, club
const RED = new Set(['♥', '♦']);
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

let CARD_ID = 0;

function cardValue(rank, suit) {
  if (rank === 'JOKER') return 0;
  if (rank === 'A') return 1;
  if (rank === 'J' || rank === 'Q') return 10;
  if (rank === 'K') return RED.has(suit) ? -1 : 10; // red king = -1
  return parseInt(rank, 10);
}

function cardPower(rank) {
  switch (rank) {
    case '7': case '8': return 'peekSelf';   // peek your own card
    case '9': case '10': return 'peekOpp';    // peek an opponent card
    case 'J': return 'blindSwap';             // swap blind
    case 'Q': return 'seeSwap';               // look then swap
    default: return null;                      // incl. K (black useless / red just -1) and Joker
  }
}

function makeCard(rank, suit) {
  return { id: ++CARD_ID, rank, suit, value: cardValue(rank, suit), power: cardPower(rank) };
}

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(makeCard(r, s));
  deck.push(makeCard('JOKER', null));
  deck.push(makeCard('JOKER', null));
  return deck;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Game state ---------- */
const G = {
  players: [],      // {id, name, isHuman, grid:[{card}|null], mem:{ownerId:[card|undefined]}}
  drawPile: [],
  discard: [],
  current: 0,
  caboCaller: null,
  turnCounter: 0,
  revealAll: false,
  mode: null,           // 'pickSlot' | 'stacking' | null
  slotFilter: null,
  slotResolver: null,
  stackPending: null,
  peekReveal: null,    // {owner, slot} currently flipped face-up for a peek
  seenFlash: null,     // {owner, slot} a card someone is peeking — shows an eye badge
  swapHighlight: null, // [{owner,slot},...] cards just swapped (J/Q), flashed briefly
  roundOver: false,
};

const byId = (id) => G.players.find((p) => p.id === id);
const human = () => G.players[0];
const topDiscard = () => G.discard[G.discard.length - 1] || null;

/* ---------- Belief / memory helpers ---------- */
// p.mem[ownerId][slotIdx] = card the player remembers in that slot (else undefined)
function forgetAll(ownerId, slot) {
  for (const p of G.players) if (p.mem[ownerId]) delete p.mem[ownerId][slot];
}
function learn(observerId, ownerId, slot) {
  const owner = byId(ownerId);
  const cell = owner.grid[slot];
  byId(observerId).mem[ownerId][slot] = cell ? cell.card : undefined;
}
function known(p, ownerId, slot) {
  return p.mem[ownerId] ? p.mem[ownerId][slot] : undefined;
}

/* ---------- Setup ---------- */
function newGame(numPlayers, startIndex = 0) {
  CARD_ID = 0;
  G.players = [];
  const names = ['You', 'Bea', 'Cleo', 'Dax', 'Evan', 'Fin'];
  for (let i = 0; i < numPlayers; i++) {
    const mem = {};
    for (let j = 0; j < numPlayers; j++) mem[j] = [];
    G.players.push({
      id: i,
      name: names[i],
      isHuman: i === 0,
      grid: [],
      mem,
    });
  }
  G.drawPile = shuffle(makeDeck());
  G.discard = [];
  G.caboCaller = null;
  G.turnCounter = 0;
  G.revealAll = false;
  G.roundOver = false;
  G.current = startIndex;

  // deal 4 face-down to each
  for (const p of G.players) {
    p.grid = [];
    for (let k = 0; k < 4; k++) p.grid.push({ card: G.drawPile.pop() });
  }
  // each player secretly knows their two closest cards = bottom row (slots 2,3)
  for (const p of G.players) {
    p.mem[p.id][2] = p.grid[2].card;
    p.mem[p.id][3] = p.grid[3].card;
  }
  // start discard pile
  G.discard.push(G.drawPile.pop());
}

/* ---------- Rendering ---------- */
const $ = (sel) => document.querySelector(sel);

function cardFaceEl(card) {
  const el = document.createElement('div');
  el.className = 'card face' + (card.suit && RED.has(card.suit) ? ' red' : '');
  if (card.rank === 'JOKER') {
    el.innerHTML = `<span class="rank">JK</span><span class="suit">★</span><span class="val">0</span>`;
  } else if (card.rank === 'K') {
    el.innerHTML = `<span class="rank">K</span><span class="suit">${card.suit}</span><span class="val">${card.value}</span>`;
  } else {
    el.innerHTML = `<span class="rank">${card.rank}</span><span class="suit">${card.suit || ''}</span><span class="val">${card.value}</span>`;
  }
  return el;
}

function slotEl(ownerId, slot) {
  const owner = byId(ownerId);
  const cell = owner.grid[slot];
  const wrap = document.createElement('div');
  wrap.className = 'slot';
  wrap.dataset.owner = ownerId;
  wrap.dataset.slot = slot;

  if (!cell) {
    const e = document.createElement('div');
    e.className = 'card empty';
    wrap.appendChild(e);
    return wrap;
  }

  const picking = G.mode === 'pickSlot' && G.slotFilter;
  const isTarget = picking && G.slotFilter(ownerId, slot);
  const peeked = G.peekReveal && G.peekReveal.owner === ownerId && G.peekReveal.slot === slot;

  // Pure memory: face-down until the final reveal — EXCEPT a card you are
  // actively peeking, which flips face-up in place so you can clearly see it.
  let el;
  if (G.revealAll || peeked) {
    el = cardFaceEl(cell.card);
    if (peeked && !G.revealAll) el.classList.add('reveal'); // 3D flip on peek
  } else {
    el = document.createElement('div');
    el.className = 'card back';
  }

  // highlighting / click gating
  if (isTarget) el.classList.add('selectable');
  else if (picking) el.classList.add('dim'); // not a legal target → dim + unclickable
  if ((G.mode === 'stacking' || G.mode === 'turnStack') && ownerId === 0) el.classList.add('stackable');
  if (G.swapHighlight && G.swapHighlight.some((h) => h.owner === ownerId && h.slot === slot)) el.classList.add('swapped');

  // "being seen" eye badge: while a card is peeked (by you or a bot)
  const seen = G.seenFlash && G.seenFlash.owner === ownerId && G.seenFlash.slot === slot;
  if (peeked || seen) {
    el.classList.add('being-seen');
    const eye = document.createElement('div');
    eye.className = 'seen-badge';
    eye.textContent = '\u{1F441}';
    el.appendChild(eye);
  }

  el.addEventListener('click', () => onCardClick(ownerId, slot));
  wrap.appendChild(el);
  return wrap;
}

function gridEl(ownerId) {
  const owner = byId(ownerId);
  const g = document.createElement('div');
  g.className = 'grid';
  for (let i = 0; i < owner.grid.length; i++) g.appendChild(slotEl(ownerId, i));
  return g;
}

// Seat header: brass avatar disc + name + live card count.
function seatHeaderHTML(p) {
  const count = p.grid.filter(Boolean).length;
  const cabo = G.caboCaller === p.id;
  return `<span class="avatar">${p.name[0]}</span>`
    + `<span class="seat-name">${p.name}</span>`
    + `<span class="seat-meta${cabo ? ' is-cabo' : ''}">${cabo ? 'CABO · ' : ''}${count} card${count === 1 ? '' : 's'}</span>`;
}

function render() {
  // opponents
  const opp = $('#opponents');
  opp.innerHTML = '';
  for (let i = 1; i < G.players.length; i++) {
    const p = G.players[i];
    const box = document.createElement('div');
    box.className = 'player' + (G.current === i ? ' active' : '') + (G.caboCaller === i ? ' cabo' : '');
    const name = document.createElement('div');
    name.className = 'player-name';
    name.innerHTML = seatHeaderHTML(p);
    box.appendChild(name);
    box.appendChild(gridEl(i));
    opp.appendChild(box);
  }

  // human
  $('#humanName').innerHTML = seatHeaderHTML(human());
  const hg = $('#humanGrid');
  hg.innerHTML = '';
  const owner = human();
  for (let i = 0; i < owner.grid.length; i++) hg.appendChild(slotEl(0, i));
  const ha = $('#humanArea');
  if (ha) ha.className = (G.current === 0 ? 'active' : '') + (G.caboCaller === 0 ? ' cabo' : '');

  // center
  $('#drawCount').textContent = `(${G.drawPile.length})`;
  const dc = $('#discardCard');
  dc.className = 'card empty';
  dc.innerHTML = '';
  const t = topDiscard();
  if (t) {
    const f = cardFaceEl(t);
    dc.replaceWith(f);
    f.id = 'discardCard';
  }
  const drawC = $('#drawCard');
  // The draw pile is never a pickSlot target (you draw via the button), and the
  // owner-based filters throw if handed a non-player owner like 'draw'. Guard it.
  let drawSelectable = false;
  try { drawSelectable = G.mode === 'pickSlot' && !!G.slotFilter && !!G.slotFilter('draw', -1); } catch (e) { drawSelectable = false; }
  drawC.classList.toggle('selectable', drawSelectable);
}

function setStatus(s) { $('#status').textContent = s; }

// Signature moment: a "CABO!" call, or a "CABO CANCELLED" when a swap breaks it.
function showCaboStamp(name, cancelled) {
  const host = $('#app');
  if (!host || !host.appendChild) return;
  const s = document.createElement('div');
  s.className = 'cabo-stamp' + (cancelled ? ' cancelled' : '');
  const word = cancelled ? 'CABO CANCELLED' : 'CABO!';
  const sub = cancelled ? `${name}'s call was broken by a swap` : `${name} called it — one last turn each`;
  s.innerHTML = `<div class="cabo-stamp-inner"><span class="cabo-word">${word}</span><span class="cabo-sub">${sub}</span></div>`;
  host.appendChild(s);
  setTimeout(() => { if (s.remove) s.remove(); }, 1900);
}

function log(msg, hl = false) {
  const el = document.createElement('div');
  el.className = 'entry' + (hl ? ' hl' : '');
  el.textContent = msg;
  const box = $('#log');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

/* ---------- Input helpers (promise-based) ---------- */
function onCardClick(ownerId, slot) {
  if (G.mode === 'stacking' || G.mode === 'turnStack') {
    if (ownerId === 0 && human().grid[slot] && G.stackPending) G.stackPending(slot);
    return;
  }
  if (G.mode === 'pickSlot' && G.slotFilter && G.slotFilter(ownerId, slot)) {
    const r = G.slotResolver;
    G.mode = null; G.slotFilter = null; G.slotResolver = null;
    render();
    r({ owner: ownerId, slot });
  }
}

function pickSlot(filter, statusText) {
  setStatus(statusText);
  return new Promise((resolve) => {
    G.mode = 'pickSlot';
    G.slotFilter = filter;
    G.slotResolver = resolve;
    render();
  });
}

function actionButtons(buttons, statusText) {
  if (statusText) setStatus(statusText);
  const bar = $('#actionBar');
  bar.innerHTML = '';
  return new Promise((resolve) => {
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.disabled = !!b.disabled;
      el.addEventListener('click', () => { bar.innerHTML = ''; resolve(b.value); });
      bar.appendChild(el);
    }
  });
}

function modal(html) {
  const ov = $('#overlay');
  $('#modal').innerHTML = html;
  ov.classList.remove('hidden');
  return {
    onClick: (sel, fn) => $('#modal').querySelector(sel).addEventListener('click', fn),
    close: () => ov.classList.add('hidden'),
  };
}

function revealModal(card, text) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${text}</h2><div class="big-card" id="rc"></div><div class="row"><button class="btn" id="ok">OK</button></div>`);
    $('#rc').appendChild(cardFaceEl(card));
    m.onClick('#ok', () => { m.close(); resolve(); });
  });
}

/* ---------- Card movement primitives ---------- */
function ensureDraw() {
  if (G.drawPile.length === 0 && G.discard.length > 1) {
    const top = G.discard.pop();
    G.drawPile = shuffle(G.discard);
    G.discard = [top];
    log('Draw pile reshuffled from discards.');
  }
}

// Put a card on the discard pile, then open the stacking race for everyone.
async function pushDiscard(card) {
  G.discard.push(card);
  render();
  await openStacking(card);
}

function attemptStack(playerId, slot, top) {
  const p = byId(playerId);
  const cell = p.grid[slot];
  if (cell && cell.card.rank === top.rank) {
    // success — remove the matched card (hand shrinks)
    const c = cell.card;
    const fromR = rectOf(slotDom(playerId, slot));
    p.grid[slot] = null;
    forgetAll(playerId, slot);
    G.discard.push(c);
    log(`${p.name} stacked a ${c.rank}! (${p.grid.filter(Boolean).length} cards left)`, true);
    if (fromR) animateToDiscard(fromR, c); // cosmetic fly to discard
    return true;
  }
  // penalty — non-matching attempt: card stays, draw an unknown penalty card
  ensureDraw();
  const pen = G.drawPile.pop();
  if (pen) {
    p.grid.push({ card: pen });
    log(`${p.name} mis-stacked — penalty card added (${p.grid.filter(Boolean).length} cards).`, true);
  }
  return false;
}

function showStackBar(ms) {
  const wrap = $('#stackBarWrap');
  const bar = $('#stackBar');
  wrap.classList.add('active');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  // force reflow then animate
  void bar.offsetWidth;
  bar.style.transition = `width ${ms}ms linear`;
  bar.style.width = '0%';
}
function hideStackBar() { $('#stackBarWrap').classList.remove('active'); }

// The live "slap" window after any discard.
function openStacking(top) {
  const WINDOW = 3200;
  setStatus(`⚡ SLAP! A ${top.rank} was discarded — click a matching card to stack it!`);
  return new Promise((resolve) => {
    let done = false;
    const aiTimers = [];
    const finish = () => {
      if (done) return;
      done = true;
      G.mode = null; G.stackPending = null;
      aiTimers.forEach(clearTimeout);
      clearTimeout(endTimer);
      hideStackBar();
      render();
      resolve();
    };

    G.mode = 'stacking';
    G.stackPending = (slot) => {
      if (done) return;
      attemptStack(0, slot, top);
      finish();
    };

    // each AI that *knows* it holds a matching card may slap, at a human-ish reaction time.
    // Only stack a card worth dumping (value >= 5) — never a red King (-1), Joker, or low card,
    // since removing a score-reducer would hurt the bot.
    for (const p of G.players) {
      if (p.isHuman) continue;
      let matchSlot = -1;
      for (let i = 0; i < p.grid.length; i++) {
        const m = known(p, p.id, i);
        if (p.grid[i] && m && m.rank === top.rank && m.value >= 5) { matchSlot = i; break; }
      }
      if (matchSlot >= 0) {
        const delay = 900 + Math.random() * 1800;
        aiTimers.push(setTimeout(() => {
          if (done) return;
          attemptStack(p.id, matchSlot, top);
          finish();
        }, delay));
      }
    }

    showStackBar(WINDOW);
    render();
    const endTimer = setTimeout(finish, WINDOW);
  });
}

// Swap a drawn (known to actor) card into actor's slot; old card to discard.
async function swapDrawnIntoSlot(actorId, slot, drawn) {
  const a = byId(actorId);
  const old = a.grid[slot].card;
  a.grid[slot].card = drawn;
  forgetAll(actorId, slot);
  a.mem[actorId][slot] = drawn; // actor saw the drawn card
  render();
  await animateDrawSwap(actorId, slot, old); // show the card movement to/from the slot
  await pushDiscard(old);
}

// Swap two cards between slots (blind unless caller updates beliefs).
function swapSlots(p1, s1, p2, s2) {
  const A = byId(p1), B = byId(p2);
  const tmp = A.grid[s1].card;
  A.grid[s1].card = B.grid[s2].card;
  B.grid[s2].card = tmp;
  forgetAll(p1, s1);
  forgetAll(p2, s2);
  // A J/Q swap touching the CABO caller's cards CANCELS their CABO — round continues.
  if (G.caboCaller !== null && (G.caboCaller === p1 || G.caboCaller === p2)) {
    const caller = byId(G.caboCaller);
    G.caboCaller = null;
    log(`CABO cancelled — a swap hit ${caller.name}'s cards! The round continues.`, true);
    showCaboStamp(caller.name, true);
  }
}

/* ---------- AI helpers ---------- */
const ownSlots = (p) => p.grid.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
function worstKnownSlot(p) {
  let best = -1, bv = -100;
  for (const i of ownSlots(p)) {
    const m = known(p, p.id, i);
    if (m && m.value > bv) { bv = m.value; best = i; }
  }
  return best;
}
function unknownOwnSlot(p) {
  for (const i of ownSlots(p)) if (!known(p, p.id, i)) return i;
  return -1;
}
function estimateScore(p) {
  let sum = 0;
  for (const i of ownSlots(p)) {
    const m = known(p, p.id, i);
    sum += m ? m.value : 5; // unknown ~5
  }
  return sum;
}
function randomOppSlot(p, predicate) {
  const opts = [];
  for (const o of G.players) {
    if (o.id === p.id) continue;
    for (let i = 0; i < o.grid.length; i++) {
      if (!o.grid[i]) continue;
      if (predicate && !predicate(o.id, i)) continue;
      opts.push({ owner: o.id, slot: i });
    }
  }
  return opts.length ? opts[Math.floor(Math.random() * opts.length)] : null;
}

/* ---------- AI turn ---------- */
async function aiTurn(p) {
  setStatus(`${p.name} is thinking…`);
  await sleep(650);
  ensureDraw();

  const worst = worstKnownSlot(p);
  const worstVal = worst >= 0 ? known(p, p.id, worst).value : null;

  // Only action: draw from the deck (taking from the discard is not allowed).
  if (G.drawPile.length === 0) { await maybeCabo(p); return; }
  const drawn = G.drawPile.pop();
  await sleep(350);

  // decide swap target
  let target = -1;
  if (worst >= 0 && drawn.value < worstVal) target = worst;
  else {
    const u = unknownOwnSlot(p);
    if (u >= 0 && drawn.value < 5) target = u;
  }

  if (target >= 0) {
    log(`${p.name} swaps a card from the draw pile into their hand.`);
    await swapDrawnIntoSlot(p.id, target, drawn);
  } else {
    log(`${p.name} discards a ${labelCard(drawn)}.`);
    await animateToDiscard(rectOf($('#drawCard')), drawn); // deck → discard
    await pushDiscard(drawn);
    await aiUsePower(p, drawn);
  }
  await maybeCabo(p);
}

async function aiUsePower(p, card) {
  if (!card.power) return;
  await sleep(300);
  if (card.power === 'peekSelf') {
    const u = unknownOwnSlot(p);
    if (u >= 0) { learn(p.id, p.id, u); log(`${p.name} peeks at one of their own cards.`); }
  } else if (card.power === 'peekOpp') {
    const t = randomOppSlot(p, (o, i) => !known(p, o, i));
    if (t) {
      learn(p.id, t.owner, t.slot);
      log(`${p.name} peeks at ${byId(t.owner).name}'s card.`);
      await flashSeen(t.owner, t.slot); // owner sees their card was looked at
    }
  } else if (card.power === 'blindSwap') {
    const w = worstKnownSlot(p);
    if (w >= 0) {
      // prefer swapping our worst with an opponent card we believe is low
      let t = randomOppSlot(p, (o, i) => { const m = known(p, o, i); return m && m.value <= 3; });
      if (!t) t = randomOppSlot(p);
      if (t) {
        swapSlots(p.id, w, t.owner, t.slot);
        log(`${p.name} blind-swaps a card with ${byId(t.owner).name}.`);
        await showSwap(p.id, w, t.owner, t.slot);
      }
    }
  } else if (card.power === 'seeSwap') {
    const t = randomOppSlot(p, (o, i) => !known(p, o, i)) || randomOppSlot(p);
    if (t) {
      learn(p.id, t.owner, t.slot);
      await flashSeen(t.owner, t.slot); // owner sees their card was looked at
      const seen = known(p, t.owner, t.slot);
      const w = worstKnownSlot(p);
      const myW = w >= 0 ? w : (ownSlots(p).length ? ownSlots(p)[0] : -1);
      const myWVal = (myW >= 0 && known(p, p.id, myW)) ? known(p, p.id, myW).value : 5;
      if (myW < 0) {
        log(`${p.name} looks at ${byId(t.owner).name}'s card.`); // no card to swap (edge)
      } else if (seen && seen.value < myWVal) {
        swapSlots(p.id, myW, t.owner, t.slot);
        p.mem[p.id][myW] = byId(p.id).grid[myW].card;
        log(`${p.name} takes ${byId(t.owner).name}'s card with a Queen.`);
        await showSwap(p.id, myW, t.owner, t.slot);
      } else {
        // a Queen must swap — blind-swap a different opponent card
        const t2 = randomOppSlot(p, (o, i) => !(o === t.owner && i === t.slot)) || t;
        swapSlots(p.id, myW, t2.owner, t2.slot);
        log(`${p.name} blind-swaps a different card with a Queen.`);
        await showSwap(p.id, myW, t2.owner, t2.slot);
      }
    }
  }
  await sleep(250);
}

function labelCard(card) {
  if (card.rank === 'JOKER') return 'Joker';
  if (!card.suit) return card.rank;
  return card.rank + card.suit;
}

/* ---------- Human turn ---------- */
// On your turn you may draw, take the discard, OR click one of your own
// (face-down) cards to stack it from memory — a gamble: wrong rank = penalty.
function chooseTurnAction() {
  setStatus('Your turn — draw a card, or click one of your own cards to stack a remembered match.');
  const bar = $('#actionBar');
  bar.innerHTML = '';
  return new Promise((resolve) => {
    const finish = (val) => { G.mode = null; G.stackPending = null; bar.innerHTML = ''; resolve(val); };
    G.mode = 'turnStack';
    G.stackPending = (slot) => {
      const t = topDiscard();
      if (!t) return;
      attemptStack(0, slot, t);
      render(); // stay in turnStack; the Draw button remains available
    };
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = 'Draw from pile';
    b.disabled = G.drawPile.length === 0;
    b.addEventListener('click', () => finish('draw'));
    bar.appendChild(b);
    render();
  });
}

async function humanTurn() {
  setStatus('Your turn.');
  ensureDraw();
  await chooseTurnAction(); // resolves when you draw (you may stack matches first)

  const drawn = G.drawPile.pop();
  if (drawn) {
    render();
    const what = await new Promise((resolve) => {
      const m = modal(
        `<h2>You drew…</h2><div class="big-card" id="dc"></div>
         <p>Swap it into your grid, or discard it${drawn.power ? ' (its power will trigger)' : ''}.</p>
         <div class="row">
           <button class="btn" id="swap">Swap into grid</button>
           <button class="btn secondary" id="disc">Discard${drawn.power ? ' + use power' : ''}</button>
         </div>`);
      $('#dc').appendChild(cardFaceEl(drawn));
      m.onClick('#swap', () => { m.close(); resolve('swap'); });
      m.onClick('#disc', () => { m.close(); resolve('disc'); });
    });

    if (what === 'swap') {
      const { slot } = await pickSlot((o, i) => o === 0 && human().grid[i], 'Pick which of your cards to replace.');
      log('You swap the drawn card into your hand.');
      await swapDrawnIntoSlot(0, slot, drawn);
    } else {
      log(`You discard a ${labelCard(drawn)}.`);
      await animateToDiscard(rectOf($('#drawCard')), drawn); // deck → discard
      G.discard.push(drawn);
      render();
      await humanUsePower(drawn);   // use the power FIRST — clicks mean peek/swap, not stack
      await openStacking(drawn);    // THEN the slap window opens for matching cards
    }
  }

  // End of turn: option to call CABO
  if (G.caboCaller === null) {
    const end = await actionButtons([
      { label: 'End turn', value: 'end' },
      { label: 'Call CABO!', value: 'cabo', cls: 'danger' },
    ], 'End your turn, or call CABO if you think you have the lowest hand.');
    if (end === 'cabo') {
      G.caboCaller = 0;
      log('You called CABO! Everyone else gets one last turn.', true);
      showCaboStamp('You');
      render();
    }
  }
}

// is there any card on the table matching this filter?
function anySlot(filter) {
  for (const p of G.players) for (let i = 0; i < p.grid.length; i++) if (p.grid[i] && filter(p.id, i)) return true;
  return false;
}
function skipPower(reason) {
  log(reason);
  setStatus(reason);
  return sleep(900);
}

// Flip a card face-up in place, show the reveal popup, then flip it back.
async function peekRevealInPlace(owner, slot, title) {
  G.peekReveal = { owner, slot };
  render();
  await revealModal(byId(owner).grid[slot].card, title);
  G.peekReveal = null;
  render();
}

// Show an eye on a card while it is being peeked, so its owner knows it was seen.
async function flashSeen(owner, slot, hold = 1100) {
  G.seenFlash = { owner, slot };
  render();
  await sleep(hold);
  G.seenFlash = null;
  render();
}

// Find the on-screen slot element for (owner, slot).
function slotDom(owner, slot) {
  if (!document.querySelector) return null;
  try { return document.querySelector(`.slot[data-owner="${owner}"][data-slot="${slot}"]`); }
  catch (e) { return null; }
}
function ghostAt(r) {
  const g = document.createElement('div');
  g.className = 'card back swap-ghost';
  Object.assign(g.style, {
    position: 'fixed', left: r.left + 'px', top: r.top + 'px',
    width: r.width + 'px', height: r.height + 'px', margin: '0',
    transition: 'transform 0.6s cubic-bezier(.4,0,.2,1)', zIndex: '60',
  });
  return g;
}
// Animate the two cards physically crossing the table.
async function animateSwap(p1, s1, p2, s2) {
  const a = slotDom(p1, s1), b = slotDom(p2, s2);
  if (!a || !b || !a.getBoundingClientRect || !document.body) return;
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  if (!ra.width) return;
  const ca = a.firstElementChild, cb = b.firstElementChild;
  if (ca) ca.style.visibility = 'hidden';
  if (cb) cb.style.visibility = 'hidden';
  const g1 = ghostAt(ra), g2 = ghostAt(rb);
  document.body.appendChild(g1); document.body.appendChild(g2);
  const dx = rb.left - ra.left, dy = rb.top - ra.top;
  const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : (fn) => setTimeout(fn, 16);
  raf(() => raf(() => {
    g1.style.transform = `translate(${dx}px, ${dy}px)`;
    g2.style.transform = `translate(${-dx}px, ${-dy}px)`;
  }));
  await sleep(640);
  if (g1.remove) g1.remove();
  if (g2.remove) g2.remove();
  if (ca) ca.style.visibility = '';
  if (cb) cb.style.visibility = '';
}

// Briefly flash the two slots that just swapped (J / Q).
async function flashSwap(p1, s1, p2, s2) {
  G.swapHighlight = [{ owner: p1, slot: s1 }, { owner: p2, slot: s2 }];
  render();
  await sleep(800);
  G.swapHighlight = null;
  render();
}

// Slide the cards across, then flash the destinations.
async function showSwap(p1, s1, p2, s2) {
  render();
  await animateSwap(p1, s1, p2, s2);
  await flashSwap(p1, s1, p2, s2);
}

/* ---------- card-movement animations (clarity on where cards go) ---------- */
function rectOf(el) { return el && el.getBoundingClientRect ? el.getBoundingClientRect() : null; }
function ghostBack() { const g = document.createElement('div'); g.className = 'card back'; return g; }
function placeGhost(el, r) {
  el.classList.add('swap-ghost');
  Object.assign(el.style, {
    position: 'fixed', left: r.left + 'px', top: r.top + 'px',
    width: r.width + 'px', height: r.height + 'px', margin: '0',
    transition: 'transform 0.5s cubic-bezier(.4,0,.2,1)', zIndex: '60',
  });
}
function flyGhost(el, fromR, toR) {
  return new Promise((res) => {
    if (!document.body) { res(); return; }
    document.body.appendChild(el);
    const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : (fn) => setTimeout(fn, 16);
    raf(() => raf(() => { el.style.transform = `translate(${toR.left - fromR.left}px, ${toR.top - fromR.top}px)`; }));
    setTimeout(() => { if (el.remove) el.remove(); res(); }, 520);
  });
}
// Fly a card from a source rect to the discard pile (face-up = public).
async function animateToDiscard(fromR, card) {
  const toR = rectOf($('#discardCard'));
  if (!fromR || !toR || !document.body) return;
  const g = card ? cardFaceEl(card) : ghostBack();
  placeGhost(g, fromR);
  await flyGhost(g, fromR, toR);
}
// Keeping a drawn card: a back slides deck→slot, the replaced card flies slot→discard.
async function animateDrawSwap(owner, slot, oldCard) {
  if (!document.body) return;
  const sEl = slotDom(owner, slot);
  const sR = rectOf(sEl), dR = rectOf($('#drawCard')), discR = rectOf($('#discardCard'));
  if (!sR) return;
  const sCard = sEl && sEl.firstElementChild;
  if (sCard) sCard.style.visibility = 'hidden';
  const jobs = [];
  if (dR) { const g = ghostBack(); placeGhost(g, dR); jobs.push(flyGhost(g, dR, sR)); }
  if (discR && oldCard) { const g = cardFaceEl(oldCard); placeGhost(g, sR); jobs.push(flyGhost(g, sR, discR)); }
  await Promise.all(jobs);
  if (sCard) sCard.style.visibility = '';
}

async function humanUsePower(card) {
  if (!card.power) return;
  // Skip gracefully if there is no legal target for the power.
  if (card.power === 'peekSelf' && !anySlot((o, i) => o === 0))
    return skipPower('No cards to peek — power skipped.');
  if ((card.power === 'peekOpp' || card.power === 'seeSwap') && !anySlot((o, i) => o !== 0))
    return skipPower('No opponent cards available — power skipped.');
  if (card.power === 'blindSwap' && (!anySlot((o, i) => o === 0) || !anySlot((o, i) => o !== 0)))
    return skipPower('No valid cards to blind-swap — power skipped.');

  if (card.power === 'peekSelf') {
    const { slot } = await pickSlot((o, i) => o === 0 && human().grid[i],
      'Power: peek at one of your own cards (memorize it!).');
    learn(0, 0, slot);
    await peekRevealInPlace(0, slot, 'Your card is:');
  } else if (card.power === 'peekOpp') {
    const { owner, slot } = await pickSlot((o, i) => o !== 0 && byId(o).grid[i],
      'Power: peek at one opponent card.');
    learn(0, owner, slot);
    await peekRevealInPlace(owner, slot, `${byId(owner).name}'s card is:`);
  } else if (card.power === 'blindSwap') {
    const own = await pickSlot((o, i) => o === 0 && human().grid[i], 'Blind Swap: pick YOUR card (no peeking).');
    const opp = await pickSlot((o, i) => o !== 0 && byId(o).grid[i], 'Blind Swap: pick an opponent card to swap with.');
    // carry any prior knowledge across the swap (you can track cards you already knew)
    const myKnew = known(human(), 0, own.slot);
    const oppKnew = known(human(), opp.owner, opp.slot);
    swapSlots(0, own.slot, opp.owner, opp.slot);
    if (oppKnew) human().mem[0][own.slot] = oppKnew;   // card you knew now sits in your slot
    if (myKnew) human().mem[opp.owner][opp.slot] = myKnew; // your card now sits in their slot
    log(`You blind-swap with ${byId(opp.owner).name}.`);
    await showSwap(0, own.slot, opp.owner, opp.slot);
  } else if (card.power === 'seeSwap') {
    const opp = await pickSlot((o, i) => o !== 0 && byId(o).grid[i], 'See & Swap: pick an opponent card to look at.');
    learn(0, opp.owner, opp.slot);
    const seen = byId(opp.owner).grid[opp.slot].card;
    G.peekReveal = { owner: opp.owner, slot: opp.slot }; // flip it up on the table
    render();
    const decision = await new Promise((resolve) => {
      const m = modal(`<h2>${byId(opp.owner).name}'s card</h2><div class="big-card" id="sc"></div>
        <p>A Queen always swaps. Take this card into your hand, or swap a <b>different</b> card blind (without seeing it).</p>
        <div class="row"><button class="btn" id="sw">Take this card</button>
        <button class="btn secondary" id="blind">Swap a different card (blind)</button></div>`);
      $('#sc').appendChild(cardFaceEl(seen));
      m.onClick('#sw', () => { m.close(); resolve('take'); });
      m.onClick('#blind', () => { m.close(); resolve('blind'); });
    });
    G.peekReveal = null;
    render();
    if (decision === 'take') {
      const own = await pickSlot((o, i) => o === 0 && human().grid[i], 'Pick YOUR card to swap for it.');
      const myKnew = known(human(), 0, own.slot);
      swapSlots(0, own.slot, opp.owner, opp.slot);
      human().mem[0][own.slot] = seen;              // you saw it, now you hold it
      if (myKnew) human().mem[opp.owner][opp.slot] = myKnew;
      log(`You take ${byId(opp.owner).name}'s card with your Queen.`);
      await showSwap(0, own.slot, opp.owner, opp.slot);
    } else {
      // you must still swap — blind-swap a DIFFERENT card (no peeking)
      const hasOther = anySlot((o, i) => o !== 0 && !(o === opp.owner && i === opp.slot));
      const own = await pickSlot((o, i) => o === 0 && human().grid[i], 'Blind swap: pick YOUR card (no peeking).');
      const opp2 = await pickSlot(
        (o, i) => o !== 0 && byId(o).grid[i] && (hasOther ? !(o === opp.owner && i === opp.slot) : true),
        'Blind swap: pick an opponent card to swap with (no peeking).');
      const myKnew = known(human(), 0, own.slot);
      const oppKnew = known(human(), opp2.owner, opp2.slot);
      swapSlots(0, own.slot, opp2.owner, opp2.slot);
      if (oppKnew) human().mem[0][own.slot] = oppKnew;
      if (myKnew) human().mem[opp2.owner][opp2.slot] = myKnew;
      log(`You blind-swap a different card with your Queen.`);
      await showSwap(0, own.slot, opp2.owner, opp2.slot);
    }
  }
}

/* ---------- CABO decision for AI ---------- */
async function maybeCabo(p) {
  if (G.caboCaller !== null) return;
  if (G.turnCounter < G.players.length) return; // don't call before everyone's had a turn
  if (estimateScore(p) <= 7) {
    G.caboCaller = p.id;
    log(`${p.name} calls CABO! Everyone else gets one last turn.`, true);
    showCaboStamp(p.name);
    render();
    await sleep(400);
  }
}

/* ---------- Round flow ---------- */
async function memorizePhase() {
  // briefly show the human their two known cards
  const h = human();
  await new Promise((resolve) => {
    const c2 = cardFaceEl(h.grid[2].card).outerHTML;
    const c3 = cardFaceEl(h.grid[3].card).outerHTML;
    const m = modal(`<h2>Memorize your two cards</h2>
      <p>You'll only remember these — they flip back face-down after.</p>
      <div class="row">${c2}${c3}</div>
      <div class="row"><button class="btn" id="ok">Got it</button></div>`);
    m.onClick('#ok', () => { m.close(); resolve(); });
  });
}

async function gameLoop() {
  while (true) {
    const p = G.players[G.current];
    G.turnCounter++;
    render();
    if (p.isHuman) await humanTurn();
    else await aiTurn(p);

    if (G.drawPile.length === 0 && G.discard.length <= 1) break; // ran out of cards
    const next = (G.current + 1) % G.players.length;
    if (G.caboCaller !== null && next === G.caboCaller) break;    // others have each had a turn
    G.current = next;
  }
  endRound();
}

function endRound() {
  G.revealAll = true;
  G.mode = null;
  render();

  const scores = G.players.map((p) => ({
    p,
    score: p.grid.filter(Boolean).reduce((s, c) => s + c.card.value, 0),
  }));
  const min = Math.min(...scores.map((s) => s.score));
  const lowest = scores.filter((s) => s.score === min);

  // CABO caller only wins if strictly lowest (untied). Otherwise lowest non-caller wins.
  let winner;
  let resultLine;
  if (lowest.length === 1) {
    winner = lowest[0].p;
    if (G.caboCaller === winner.id) resultLine = `${winner.name} called CABO and nailed it — lowest hand!`;
    else if (G.caboCaller !== null) resultLine = `${winner.name} undercut ${byId(G.caboCaller).name}'s CABO and wins!`;
    else resultLine = `${winner.name} has the lowest hand and wins!`;
  } else {
    // tie for lowest — a tied caller does NOT win; pick a tied non-caller, else it's a draw
    const nonCaller = lowest.find((s) => s.p.id !== G.caboCaller);
    winner = nonCaller ? nonCaller.p : null;
    resultLine = winner
      ? `Tie at ${min} — ${winner.name} wins (CABO caller loses ties).`
      : `Tie at ${min} — nobody wins this round.`;
  }

  log(resultLine, true);

  const rows = scores
    .slice()
    .sort((a, b) => a.score - b.score)
    .map((s) => `<tr class="${winner && s.p.id === winner.id ? 'winner' : ''}"><td>${s.p.name}${G.caboCaller === s.p.id ? ' (CABO)' : ''}</td><td>${s.score}</td></tr>`)
    .join('');

  const startNext = winner ? winner.id : 0;
  const m = modal(`<h2>Round Over</h2><p>${resultLine}</p>
    <table class="scores">${rows}</table>
    <div class="row">
      <button class="btn" id="next">Next round</button>
      <button class="btn secondary" id="newg">New game</button>
    </div>`);
  m.onClick('#next', () => { m.close(); startRound(G.players.length, startNext); });
  m.onClick('#newg', () => { m.close(); showStartScreen(); });
}

async function startRound(numPlayers, startIndex) {
  newGame(numPlayers, startIndex);
  $('#log').innerHTML = '';
  log(`New round — ${numPlayers} players. ${G.players[startIndex].name} start${startIndex === 0 ? '' : 's'}.`, true);
  render();
  await memorizePhase();
  // hide the two memorized cards again (they stay in human's memory via mem[])
  render();
  await gameLoop();
}

/* ---------- Start screen ---------- */
function showStartScreen() {
  G.revealAll = false;
  $('#log').innerHTML = '';
  setStatus('Choose how many players.');
  const m = modal(`<h2>CABO</h2>
    <p>A memory card game — lowest hand wins. You play against AI bots.</p>
    <p>How many players?</p>
    <div class="row">
      <button class="btn" data-n="3">3</button>
      <button class="btn" data-n="4">4</button>
      <button class="btn" data-n="5">5</button>
      <button class="btn" data-n="6">6</button>
    </div>`);
  $('#modal').querySelectorAll('button[data-n]').forEach((b) =>
    b.addEventListener('click', () => { m.close(); showInstructions(parseInt(b.dataset.n, 10)); }));
}

// Full rules, shown after the player picks a count.
function showInstructions(numPlayers) {
  setStatus('How to play.');
  const m = modal(`<h2>How to play</h2>
    <div class="rules">
      <p><span class="r-h">Goal</span> End the round with the lowest total card value.</p>
      <p><span class="r-h">Values</span> A = 1 · 2–10 = face · J/Q = 10 · ♠♣ K = 10 · <b>♥♦ K = −1</b> · Joker = 0</p>
      <p><span class="r-h">Memory</span> You get 4 face-down cards and only memorize your two closest — then they flip down. Remember them!</p>
      <p><span class="r-h">Your turn</span> Draw a card, then <b>swap</b> it into your grid (the replaced card is discarded) or <b>discard</b> it.</p>
      <p><span class="r-h">Powers</span> Only when you draw <i>then discard</i> that card: 7/8 peek your own · 9/10 peek an opponent's · J blind-swap two cards · Q look at an opponent's card, then swap it in (or blind-swap a different one — a Queen always swaps).</p>
      <p><span class="r-h">Slap</span> When a card hits the discard, click a matching rank in your hand to dump it (your hand shrinks). Wrong rank = a penalty card.</p>
      <p><span class="r-h">CABO</span> Think you're lowest? Call CABO at the end of your turn — everyone else gets one last turn, then the lowest hand wins. But a J/Q swap onto your cards <b>cancels</b> your CABO and play continues!</p>
    </div>
    <div class="row"><button class="btn" id="ready">I know how to play</button></div>`);
  m.onClick('#ready', () => { m.close(); startRound(numPlayers, 0); });
}

window.addEventListener('DOMContentLoaded', showStartScreen);
