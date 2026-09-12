# Handoff — live casino monitor

Written 2026-09-12, at the end of a long working session. This is the context a future
session needs that is **not** obvious from the code: what was reverse-engineered and how,
which bugs were subtle, what is measured versus assumed, and what is still open.

`FINDINGS.md` is the protocol reference (how the feeds work). `PATTERNS.md` is the spec
for the counting logic. **This file is the state of play.**

---

## 1. What the app is

A local, read-only monitor for live casino tables on operators that carry **Pragmatic
Play** and **Playtech**. `npm run dev` serves four pages on :3001 behind one nav rail:

| Page | What it is |
|---|---|
| `/` | Blackjack wall — card counting on tables you pin |
| `/roulette` | Roulette wall — live results, both providers |
| `/patterns` | Two pattern counters over roulette spins (PATTERNS.md) |
| `/settings` | Which tables appear, plus display rules |

It never bets. The only things ever sent to a game socket are keepalives.

---

## 2. The three feeds, and why they differ

This is the single most important thing to understand. They are **not** interchangeable.

### Pragmatic game socket — cards, capped
`wss://gs<N>.pragmaticplaylive.net/game` — the only source of blackjack **cards**.
Needs a `JSESSIONID`. **Hard-capped at 6 concurrent per account** (`duplicatePlayerSession`),
per account not per session. Hence the multi-operator design: 6 × number of logins.

### Pragmatic DGA lobby — all tables, free
`wss://dga-lc.pragmaticplaylive.net/ws` — **no token at all** (`credentials: "omit"`).
Carries every table's occupancy, dealer, open/closed, and for roulette the
`last20Results`. Costs nothing from the 6-socket budget. This was the big find of the
session; `FINDINGS.md §6k` documents the protocol.
**It carries no cards** — the client's own parser only handles
`globalStats` / `tableKey` / `tableId` / `pongTime`.

### Playtech gateway — reverse-engineered protobuf
`wss://ielive-gateway.ptielive.com/ws` — base64-free binary protobuf, no published
schema. Reversed in `tools/pt-decode.mjs` (reader) and `tools/pt-proto.mjs` (lossless
parse/encode, verified byte-identical on 98/98 captured frames).

Handshake: `InitRequest` → context id → `loginRequest{3.103.1 = s-token}` →
**`lobbySettings` + `favorites` then `subscribe`** (subscribing alone is answered
"not authenticated" — that ordering cost two debugging rounds).

Results are encoded **number + 100**.

---

## 3. Tokens and login

- **Playtech's `s-` token lives ~5 minutes**, but it is only a *handshake* credential.
  Once the socket authenticates, the session persists — so a fresh token is needed
  **per connection**, not every 5 minutes.
- Minting requires a **real browser** (Cloudflare/DataDome blocks headless and plain
  fetch — `FINDINGS.md §6h`). `tools/pt-mint.mjs` drives the real game launch in the
  signed-in Chrome profile and lifts the token off the wire. **A mint takes ~5s.**
- `tools/auto-login.mjs` signs the profile back in from DPAPI-encrypted credentials
  (`src/credentials.mjs`, imported via `npm run creds`, plaintext file shredded).
  The server calls it automatically when a mint fails "signed out".

**Playtech feeds only ONE lobby session per account.** A second socket opened alongside
the server's received zero notifications. Any future design must respect that.

---

## 4. Bugs fixed this session — the subtle ones

Recorded because each was invisible from the outside and cost real time.

| Symptom | Root cause |
|---|---|
| Pragmatic roulette numbers frozen while the socket was healthy | `mergeResults` sorted by `Date.parse(time)`. Snapshot and delta timestamps use **different zones** — a delta for a *newer* spin reads an hour *earlier*. Every new spin sorted below the existing 20 and got cut by `slice(0,20)`. Fix: never sort by time; arrival order is the truth. |
| Playtech "live" while dead for hours | The heartbeat's own `timeResponse` refreshed `lastDataAt`, the very field the staleness watchdog measures — so it could never fire. Fix: two clocks (`lastDataAt` = table data, `lastPongAt` = heartbeat). |
| Pragmatic feed silently dead, status still "live" | `DgaLobby` had no staleness watchdog at all. A quiet-but-open socket never fires `close`, so nothing reconnects. Fix: 90s watchdog + `stale` state. |
| A phantom number appearing mid-sequence (Playtech) | Field 58's repeated `7` block is a **prior-results** list excluding the current spin. It replaced our history whenever it was longer, splicing old numbers into a live sequence. Fix: that block is ignored entirely. |
| Back-to-back repeats not counted | We deduped by value, assuming the feed re-sent results. Measured: it does **not** — one notification = one spin, ~30s apart. Fix: append unconditionally; each spin gets a synthetic per-table `sid` so the tracker diffs by **id**, not by value. |
| Auto-login reported `needs-human` despite succeeding | Two separate causes, both mine. (a) The submit button is `disabled` at the instant fields are filled — filling and clicking in one atomic `evaluate` clicked a disabled button, a silent no-op. Fix: fill, wait for it to enable, then click. (b) `isSignedIn()` navigated before probing, racing a half-loaded page. Fix: only navigate on the first check. |
| Roulette tables vanishing when switching casino | `dgaState` is keyed by physical table id, but every operator reports the same table — last writer won the single `operator` field. Fix: track the **set** of operators; filter by membership. 32 of 33 wheels are carried by more than one casino. |
| A wheel showing another casino's name | Casinos brand the same physical table differently ("Roulette Latina" vs "Betsson Spanish Roulette"). Fix: names stored **per operator**; the primary casino's name is canonical everywhere. |
| Playtech mint failing every second attempt | `spawned.kill()` left Chrome's child processes holding the profile lock. Fix: shut down via CDP `Browser.close`. |

---

## 5. Verification lessons — read this before trusting a "pass"

I reported things as working that were not, twice. Both times the test was wrong, not
the code.

1. **"31/33 tables advanced"** — I compared `updatedAt`, which changes on any *occupancy*
   delta (a player sitting down), not on a new spin. The feed was completely frozen.
   **Compare the top number, not a timestamp.**
2. **"auto-login works"** — every success was the `already signed in` short-circuit. The
   fresh-login path had never once been exercised. **A no-op path passing is not a pass.**
   The tell was timing: 24s was too fast for a real login.

Also: `tr.get(id)` returns a **live object**. Capturing it and reading a field after the
next ingest reads the *new* value. Snapshot the number, not the reference.

---

## 6. Pattern counting (PATTERNS.md)

`src/patterns.mjs` — pure state machine, both patterns are one function with a variant
flag. `npm run test:patterns` runs the full contract: all §7 vectors, event-order
assertions, carry states, the §10 checklist, and §8 detection guards. **39 tests.**

Counts advance **server-side** off the same `rouletteTables()` the wall reads (§8.5), so
a browser reload never loses one.

**On a Playtech reconnect the counts are wiped deliberately.** Playtech results have no
stable provider id, so spins missed during a gap cannot be recovered. Per user decision
(stricter than §8.3): previous numbers are dropped, both counts go to 0, the first window
after reconnect is adopted as a **baseline only** — not replayed, not displayed — and
counting restarts from spins that arrive afterwards. Pragmatic is deliberately exempt: it
has `gameId`s, so its diffing already knows exactly what was missed.

---

## 7. Measured facts (not assumptions)

- **Playtech's lobby flushes every ~29s**, ~75 tables per batch. Verified identical on a
  *fresh* socket (median 29.0s, min 28.0, max 29.2), so it is the provider's cadence —
  not subscription decay, not our pipeline. This is the floor for lobby-channel latency
  and explains "2-3 numbers behind".
- A Playtech mint is **~5s**. The old "3 minutes" was the reconnect backoff escalating to
  a 120s ceiling; a deliberate recycle no longer inherits it.
- Pragmatic DGA: 33 roulette tables for stoiximan, 3 operator sockets.
- Playtech: 87 tables in the lobby snapshot, 31 of them roulette.
- The 6-socket cap is per **account**; extra `JSESSIONID`s do not raise it.

---

## 8. Known limitations / open work

- **Playtech results are ~30-60s behind the wheel.** The lobby channel cannot do better.
  The real-time path exists in the protocol — `pt.live.game/JoinTableRequest` →
  `TableEventRequest`, what a browser gets when you *open* a table — but it is per-table
  and the concurrent-join limit is **unmeasured**. Next step would be joining one table
  and measuring the gain before building on it.
- **Playtech has no table names for non-roulette games** in some paths; roulette names
  come from the subscribe snapshot (field 4).
- Automated tables report their own name as the dealer ("Auto Roulette 2"), cosmetic.
- Auto-login is best-effort: a CAPTCHA or 2FA returns `needs-human` with the reason.
- Pattern history is in memory only — a server restart re-seeds from the visible window.
- `.chrome-profile` is ~650MB; the operator session inside it lapses every few hours,
  which is what auto-login exists to handle.

---

## 9. Operating it

```
npm run dev                     # everything, :3001 (Playtech ON by default)
npm run creds                   # import data/credentials.json -> DPAPI, shred plaintext
npm run autologin               # sign the profile back in
npm run login -- <operator>     # manual sign-in, when auto-login says needs-human
npm run test:patterns           # 39 pattern tests
npm run probe:platform -- <tok> # re-test the platform services (FINDINGS §6i)
```

Useful env knobs: `PLAYTECH=0` (disable), `PT_STALE_MS`, `PT_PONG_STALE_MS`,
`PT_BACKOFF_MS`, `PT_MIN_SPIN_GAP_MS`, `SESSION_CHECK_MS`, `PORT`, `RECORD_DIR`.

**Restart the server after code changes** — Node does not hot-reload, and more than once
a "bug" was a stale process.

---

## 10. Watch for these in `scraper.log`

| Line | Meaning |
|---|---|
| `dga[op] stale for Ns — reconnecting` | DGA watchdog fired; feed was dead |
| `playtech recycling: no table data for Ns` | Playtech watchdog fired |
| `playtech loginResponse 340B REJECTED` | token stale/raced — normal once, repeated means something is recycling too aggressively |
| `playtech reconnected — pattern counts reset for N tables` | expected after every re-mint |
| `no token minted — is the profile signed in` | the profile lapsed; auto-login should follow |

---

## 11. Worth knowing

This reads a logged-in account's own session. Operator terms commonly restrict automated
access, and automating **login** (which this now does) is more likely to trip account or
bot-protection flags than reusing an existing session. The 6-socket cap also makes a wide
monitor visible server-side as an unusual pattern. Worth re-reading the terms before
running this continuously.
