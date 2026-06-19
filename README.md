# CABO

A browser version of **CABO** — the memory card game — played against AI bots. No build step, just open it.

## Play

Pick how many players (3–6), memorize your two closest cards, and try to end the round with the **lowest total card value**.

- **Card values:** A = 1 · 2–10 = face · J/Q = 10 · ♠♣ K = 10 · **♥♦ K = −1** · Joker = 0
- **Your turn:** draw a card, then swap it into your grid (the replaced card is discarded) or discard it.
- **Powers** (only when you draw *then* discard that card): 7/8 peek your own · 9/10 peek an opponent's · J blind-swap · Q look then maybe swap.
- **Slap:** when a card hits the discard, click a matching rank in your hand to dump it. Wrong rank = a penalty card.
- **CABO:** think you're lowest? Call it — everyone else gets one last turn, then the lowest hand wins. A J/Q swap onto your cards **cancels** your CABO and play continues.

It's a memory game: your cards flip face-down after you peek them, so remember what you have.

## Run locally

It's static — no dependencies, no build.

```bash
# any static server works, e.g.
python3 -m http.server 8765
# then open http://localhost:8765
```

Or just open `index.html` in a browser.

## Files

- `index.html` — markup
- `styles.css` — all styling
- `game.js` — full game engine + AI
- `_test_dom.js` — headless smoke test (`node _test_dom.js`)
