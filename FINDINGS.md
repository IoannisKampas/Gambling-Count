# Pragmatic Play live Blackjack — traced data feed

Everything here was captured from real traffic on 2026-09-06 via `tools/capture.mjs`
(Chrome under CDP, browser-level auto-attach so the out-of-process game iframe is
recorded too), then verified by connecting directly. Nothing below is guessed; the
one endpoint that looked promising but could not be confirmed is marked as such.

Raw evidence lives in `capture/` (JSONL event log + saved response bodies).

## 1. The layers

The operator and the game provider are separate systems. Only the provider carries
card data.

| Layer | Host | Carries |
|---|---|---|
| Operator page | `www.stoiximan.gr` | catalogue, auth, launch |
| Operator live feed (SignalR) | `wss://www.stoiximan.gr/customerhub_0` | player counts, seats, dealer name, roulette numbers |
| Provider REST | `games.pragmaticplaylive.net` | table list, table config, session |
| **Provider game socket** | `wss://gs<N>.pragmaticplaylive.net/game` | **all card and result data** |
| Provider video socket | `wss://ws<N>.pragmaticplaylive.net/<TABLE>` | fMP4 video segments only |

**The video is a completely separate socket from the game data.** Opening the game
socket without ever touching `ws1.…` yields the full round — verified across many
tables. This is the core of what you asked for.

## 2. How all Blackjack tables are discovered

One authenticated call returns the whole catalogue:

```
GET https://games.pragmaticplaylive.net/api/lobby/tables?JSESSIONID=<SESSION>
```

Captured response: **264 tables, 176 of them Blackjack** (`capture/bodies/25972.133.json`).

Each entry:

```json
{
  "id": "sobj027blackjack",
  "title": { "key": "BLACKJACK_10" },
  "dealer": { "name": "Micah-Lucas" },
  "limits": { "min": 100, "max": 5000, "minBalanceToPlay": 0 },
  "game": "blackjack",
  "gameLoaderKey": "blackjack3",
  "open": true
}
```

`id` is the `tableId` the game socket wants. Blackjack variants are split across
`gameLoaderKey`: `blackjack3` (110), `speedblackjack3` (40), `twosplitprivatebj` (13),
`freebetblackjack` (8), `blackjackx3` (5).

The operator's own `GET /casino/api/livefeed` returns 518 entries but is **metadata
only** — `GameId, DealerName, MinBet, MaxBet, OnlinePlayers`. No cards. Its SignalR
push (`LiveCasinoFeedUpdate`) adds `LastWinningNumbers`, but that is roulette;
Blackjack tables never carry it. The operator layer cannot feed a counter.

## 3. Getting a session

```
/casino/games/launch/live?gameId=35927        (operator, returns a 15-min JWT launch URL)
  -> gaming-launch-gr.betano.com/Game/Launch/<JWT>
  -> …/gs2c/playGame.do?…token=<ppToken>…
  -> games.pragmaticplaylive.net/api/secure/GameLaunch2?…  -> JSESSIONID
```

`JSESSIONID` then authenticates every provider REST call and the game socket.
`GET /api/session/ping?JSESSIONID=…` keeps it alive.

**The first call needs `X-Requested-With: json`.** Without that header the operator
returns the HTML casino page with status 200 instead of the launch JSON — no error,
just the wrong content type. The real request sends:

```
GET /casino/games/launch/live?gameId=35927
X-Requested-With: json
Accept: application/json
```

The chain is behind Cloudflare and DataDome, so `src/session.mjs` drives it in the
signed-in Chrome profile rather than replaying it with `fetch`, and reads the new
`JSESSIONID` off the network traffic. Measured cost of a refresh: ~2.4 s.

## 4. The game socket

```
wss://gs15.pragmaticplaylive.net/game?JSESSIONID=<SESSION>&tableId=<TABLE>&type=json&version=3
```

Two things the browser does that matter, both discovered the hard way:

- **`Origin: https://client.pragmaticplaylive.net` is mandatory.** Without it the
  socket opens and is closed immediately (code 1006) with no error message. This was
  the single blocker to connecting from outside the browser.
- **The server routes you itself.** Connect to any `gs` host and if the table lives
  elsewhere the first message is a redirect — follow `wsAddress`:

  ```json
  {"switch":{"gameServer":"gs13","tableId":"32pd67uvn4p4m1pi",
             "wsAddress":"wss://gs13.pragmaticplaylive.net/game","seq":0}}
  ```

  So you never need to know which server hosts a table. `pageRefresh=true` is optional.

Client-to-server is **XML**, not JSON. A read-only monitor needs exactly one message —
the keepalive:

```xml
<ping channel="table-sobj027blackjack" time="1788678436276"/>
```

Every other client command in the bundle (`<lpbet>`, `<decision>`, `<sitdown>`,
`<unseat>`, `<insurance>`, `<dealnow>`, `<predecision>`) is a wagering action. A
monitor sends none of them.

## 5. The messages with the game data

Server-to-client is JSON, one key per message.

**Card reveal** — the primary source:

```json
{"card":{"seat":"0","sc":"4D8","score":"4","game":"17417933115",
         "resulttime":"Sun Sep 06 07:08:07 UTC 2026","initial":"true",
         "hand":"0","seq":25,"value":"15"}}
```

**Full hand state** — repeated on every update, authoritative:

```json
{"playerSeat":{"gameId":"16342475513","seatNumber":6,"seq":33,
  "h0":{"score":"10","cards":[{"scanCode":"JC1","timestamp":1788678878371,
        "initial":true,"seq":1}],"parentHandIndex":"null"}}}
```

### Decoding a card

`sc` / `scanCode` is **rank + suit + deck index**: `4D8` = 4♦ from deck 8,
`0S1` = 10♠, `1H2` = A♥, `KD6` = K♦.

- rank `2`–`9` literal, `0` = ten, `1` = **ace**, `J`/`Q`/`K` as written
- suit `C D H S`
- trailing digit is the deck within the shoe

The ace being `1` and not `A` is easy to get wrong; it was confirmed against a live
hand reporting `score: "1/11"`.

`value` is a redundant 0–51 ordinal: `suit*13 + rankIndex`, ranks ordered 2→A
(`9C`→7, `4D`→15, `KD`→24, `6S`→43, `KS`→50). Either field decodes the card.

### The rest of a round

| Message | Meaning |
|---|---|
| `table` | physical table name, e.g. `SO-BJ02.7` |
| `currentShoe` | `{"cc":"0","code":"#4772A7"}` — **shoe id; `code` changing means a new shoe** |
| `dealer` | dealer name + id |
| `game` | round id — new round starts |
| `betsopen` / `betsclosingsoon` / `betsclosed` / `startDealing` | round phase |
| `card` | one card revealed |
| `cardinc` | a card is coming for a seat (no value yet) |
| `playerSeat` | full hand for a seat; `h0` main, `h1`… after a split |
| `score` | settled hand score |
| `handresult` | `Bust`, `Blackjack`, `CashOut`, … |
| `wins` | per-seat win amounts |
| `bjGameEnd` | round over |
| `subscribe` / `pong` | channel plumbing |

**`seat: "-1"` / `seatNumber: -1` is the dealer.** `hiddenCardDealt: true` marks the
hole card, which appears later when revealed.

`currentShoe.code` is what a counter needs for shoe boundaries — reset on change.

## 6. Can one feed serve multiple tables?

**One socket carries exactly one table** — the `tableId` is in the URL and the server
confirms a single channel (`table-<id>`). There is no multi-table subscribe command in
the client bundle.

**But one process can hold many sockets**, and that is enough. Verified: 6 tables
streaming full card data concurrently from one Node process, no video anywhere.

**The real ceiling is the account, not the socket.** Measured with a ladder test
(a one-shot ladder probe, since removed, that added one table every 4s and held):

```
# 6 + bas2sgk7ph2ybj23    live=5  rejected=0
# 7 + bas2sgk7ph2ybj24    live=6  rejected=1     <- 7th refused
```

The 7th and every later connection gets:

```json
{"duplicatePlayerSession":…}  {"closeConnection":…}  {"logout":…}
```

**The limit is 6, and it is per account, not per session.** Minting a second
`JSESSIONID` by launching the game again does not help: run concurrently, session A
held 4 and session B held 2 — six total, not twelve. Reproduced three times.

### What that means for the goal

Monitoring **all 176** Blackjack tables live is not possible through this API on one
account. You can continuously watch **6**. Rotating tables to cover more defeats the
purpose, because a running count is only valid while you observe a shoe unbroken —
rejoining a table mid-shoe gives a count you cannot trust.

The workable design is: 6 tracked tables, chosen deliberately, with the shoe reset
handled from `currentShoe.code` and any gap in observation marking that table's count
invalid rather than guessing.

## 6a. Covering more than six tables

Three routes were checked before settling on sampling.

**No hidden parameter.** The client's socket URL builder (`setSessionParams`) only ever
sets `JSESSIONID`, `tableId` and `type=json`, with `version`/`pageRefresh` as optional
extras. There is no spectator or observer mode to ask for.

**No results REST API.** `statisticHistory` and `recentResults` appear in the bundle
only inside a cache-invalidation predicate, not as endpoints. `/api/topStats` takes
`baseUrl, JWTTOKEN, tableId, timeWindow` — a bonus leaderboard needing a separate JWT,
not table results. The Blackjack client has no history endpoint at all.

**Sampling works, because the snapshot is complete on connect.** The server sends
`table`, `currentShoe`, `dealer`, `game`, phase and every occupied seat's hand
immediately. A table therefore does not need to be *held* to be read:

```
connect -> snapshot -> disconnect      median 234 ms per table (6 in parallel)
```

Measured (with a since-removed sweep probe):

| Run | Result |
|---|---|
| 30 tables, 6 sockets, from clean | **30/30, 0 refused, 5.4 s** |
| 119 tables continuously | **44/119, 66 refused** |
| 40 tables after 90 s idle | **39/40, 1 refused** |

So connections are budgeted over time, not merely capped at 6 concurrent: roughly
**35–40 connects from clean, replenishing over ~90 s**. Sampling all 119 open tables
therefore takes chunks separated by idle periods — order of minutes per full pass,
not the 32 s a naive projection suggests.

`currentShoe.cc` was `"0"` on every table sampled, so it does **not** give shoe depth;
there is no shortcut to knowing how far into a shoe a table is without watching it.

### What sampling does and does not give you

It gives a **results and state feed** for every table: dealer, shoe id, round id,
phase, and the hands showing at the moment of the sample.

It does **not** give a countable card stream. A running count is only valid across an
unbroken shoe, and a table glimpsed once every few minutes has an unknown number of
unseen cards. Sampling is for *choosing* which tables to watch; the 6 held sockets are
what you can actually count.

## 6b. Is there a lobby feed with results? No.

Worth ruling out explicitly, because it would sidestep the connection cap entirely.
Everything below was requested with a live session, not inferred.

| Source | Carries | Results? |
|---|---|---|
| `games…/api/lobby/tables` | id, title, dealer name, limits, categories, variant, `open` | **no** |
| operator SignalR `LiveCasinoFeedUpdate` | `GameId`, `OnlinePlayers`, `AvailableSeats`, `DealerName`, `LastWinningNumbers` | roulette only |
| `promo…/api/fetchRoundHistory` | — | **401**, needs a promotions JWT |
| `promo…/api/v2/fetchRoundHistoryByWS` | — | **401** |
| `promo…/api/lobby/tables` | — | **401** |
| `games…/api/fetchRoundHistory` | — | does not exist |

The `fetchRoundHistory*` endpoints live in the **promotions** bundle
(`promotions/fetchRoundHistory`) on `promo.pragmaticplaylive.net`, reject a
`JSESSIONID`, and are scoped to the player's own promotional rounds — not table
results.

**Cards and outcomes exist only on the per-table game socket.** There is no
lobby-level results feed to read instead.

### The cap is not about "entering" a table

A game socket is already a spectator connection: the monitor never sends `<sitdown>`,
`<bet>` or any other command, and `seatNumber: -1` is the dealer, not us. We are not
in a seat and never were. `duplicatePlayerSession` counts **socket connections per
account**, not seats, so there is no spectator-versus-player distinction to exploit —
the limit applies to exactly the connection that carries the cards.

### What this does allow

The lobby REST call is not socket-capped and can be polled freely. So every table's
**metadata** — dealer, open/closed, limits, variant — can be shown live for all 176
without consuming any connection. Only the card data is limited to six at a time.

## 6c. The video socket

Separate service, separate budget from the game socket.

```
wss://ws1.pragmaticplaylive.net/<PHYSICAL_TABLE_NAME>?JSESSIONID=<SESSION>
```

Required header, same as the game socket: `Origin: https://client.pragmaticplaylive.net`.

**The path is the physical table name, not the `tableId`.** `sobj027blackjack` is the
lobby id; its video lives at `/SO-BJ02.7`. The physical name arrives in the game
socket's first `table` message:

```json
{"table":{"newTable":"false","openTime":"1773050400000","seq":1,"value":"SO-BJ02.7"}}
```

Observed pairs: `sobj027blackjack`→`SO-BJ02.7`, `32pd67uvn4p4m1pi`→`BJ11.7`,
`bas2sgk7ph2ybj06`→`A85BJ8`, `bas2sgk7ph2ybj05`→`SO-BJ010.5`,
`bas2sgk7ph2ybj22`→`A85BJ9`, `bas2sgk7ph2ybj23`→`A85BJ10`,
`8d38bnlijtxhmrge`→`BJ-A42.4`. One `ws1` host served all of them.

Client sends, on open:

```
iq0            initial quality
quality0       quality level (0 = lowest)
{"cmd":"ping","counter":1,"clientTime":1788678426702}      every ~2 s
```

Server sends binary **fMP4 fragments** (`ftyp`/`moov` init, then `moof`+`mdat`), so
it only renders through MediaSource Extensions — pasting the URL in a browser gives
nothing. Text control frames (`{"cmd":"conn"}`, `pong`) are interleaved.

### It is not capped at 6

Measured with a since-removed video-cap probe on the same session that refuses a 7th
game socket: **8 of 8 concurrent video streams delivered media.** The test ceiling
was 8, so the finding is "above 6", not "unlimited".

Cost at the lowest quality setting: **~0.3 MB/s (~2.4 Mbps) per stream** — 84 MB for
a 25-second, 8-stream test. Across 176 tables that is **~53 MB/s, ~420 Mbps sustained**,
plus real-time decode and OCR of 176 feeds, to recover cards that the game socket
delivers as exact scan codes in a few KB. Video also only shows a card once it is on
camera and legible, where the socket gives split hands, per-seat scores and the hole
card's existence as structured data.

Useful for a live thumbnail of the tables being watched. Not a practical results feed.

## 6d. Can one socket carry many tables? No.

The most important route, because it would give every table on one connection with no
cap. The client never sends a subscribe (subscription is bound to the URL `tableId`),
but the server might accept one anyway - so this was tested on the wire, not inferred.

Opened one socket to table A, waited for its channel, then on the **same socket** sent
join attempts for table B's channel (`ping`, `<subscribe>`, `<command><subscribe>`,
JSON `cmd:subscribe`, `<join>`). The server's replies:

```
{"subscribe":{"channel":"table-B","status":"success","value":"Please remove subscribe command"}}
{"command":{"channel":"table-B","status":"failure","value":"You are not subscribed to this channel."}}
```

`status:"success"` looked promising, so it was isolated and watched for 45 s: **no
snapshot, no cards, no game data for B ever arrived.** A real subscription delivers
B's `table`/`dealer`/`currentShoe`/`game` immediately. The "success" is only a parse
ack; the paired `command` failure ("You are not subscribed") is the true state.

**One socket carries exactly one table.** No multiplexing.

## 6e. Every route tested — summary

| Route | How checked | All BJ tables at once? |
|---|---|---|
| Game socket, 1 per table | wire | capped 6 / account |
| Extra `JSESSIONID`s | wire | cap is per-account, not per-session |
| One socket, many channels | wire | **no** — server refuses (6d) |
| Sample connect/read/disconnect | wire | metadata for all, but connection-budgeted |
| `lobby/tables` REST | wire | catalogue only, no results; `tableId` ignored |
| `promo…/fetchRoundHistory(ByWS)` | wire | 401 (promotions JWT, own rounds) |
| `games…/fetchRoundHistory` | wire | does not exist |
| `api/ui/stats` | wire | "need no of games"; belongs to other games |
| `FETCH_SCORE` /api/v2/score | bundle | needs promo Bearer JWT, not table results |
| Operator SignalR feed | capture | `OnlinePlayers`/`AvailableSeats`/`DealerName`; results roulette-only |
| Video socket `ws1` | wire | not capped at 6, but ~420 Mbps for 176 + OCR |
| `multiTables` / multi-table host | wire+bundle | baccarat `007` only; no blackjack |
| Spectator URL param | bundle | none exists in the socket URL builder |
| DGA lobby socket `dga-lc/ws` | wire | **YES for metadata** — all tables, one unauthenticated socket, no cards (§6k) |
| broadcaster / tmservice / DGA REST | wire | operator-gated; no player access (§6i) |

**Conclusion:** blackjack cards and outcomes exist only on the per-table game socket,
which is capped at 6 concurrent per account. No feed — REST, socket-multiplex, operator
push, or video — delivers all 176 at once. The all-tables layer that *is* available is
metadata (via free lobby polling); card data is limited to six live at a time.

The one route not exhaustively tested is a **different operator** fronting the same
Pragmatic backend possibly exposing its own history API — out of scope here, and it
would still be that operator's account limits, not a way around this one.

## 6i. The platform service map — open leads above the player client

Earlier sections only ever touched three hosts: `games.`, `promo.`, `ws1.`. But the
launch handshake hands the client a full backend directory the player app itself barely
uses. It is captured verbatim in `capture/bodies/25972.76.json`
(`GET /api/env/getAll`):

```json
{"gameWS":"wss://games.pragmaticplaylive.net/game",
 "dga":"https://dga-lc.pragmaticplaylive.net","dgaWS":"wss://dga-lc.pragmaticplaylive.net/ws",
 "broadcasterWS":"wss://broadcaster.pragmaticplaylive.net",
 "tableMonitoringService":"https://tmservice.pragmaticplaylive.net",
 "gameStats":"https://gamestats.pragmaticplaylive.net","report":"https://report.pragmaticplaylive.net",
 "simmAddress":"https://simm.pragmaticplaylive.net","statsCollector":"https://stats.pragmaticplaylive.net",
 "search":"https://gamesearch.pragmaticplaylive.net","chatWS":"wss://chat.pragmaticplaylive.net/chat", …}
```

These are the *platform* (operator/back-office) services that sit **above** a single
game socket — precisely the layer that could carry many tables on one connection.

**Tested with a live player `JSESSIONID`** (`npm run probe:platform`, 2026-09-08).
Every host is real and live; none authenticates the player token for table data:

| Service | Player-token result | Verdict |
|---|---|---|
| `dga-lc…/api/tables` (Direct Game Access) | **401 Unauthorized** | operator B2B API; player session grants nothing |
| `dga-lc…/ws` (dgaWS) | handshake opens; **wrong protocol here** — the real client uses `{type:…, casinoId:…}` with no token. See §6k. | **this IS the all-tables lobby socket** (occupancy/metadata, no cards) — §6k |
| `broadcaster…` (broadcasterWS) | **400 Bad Request** on every path/param | rejects the upgrade; and it is **per-table** — handed out as `params.broadcaster_ws` in each table's `tableConfig`, not an aggregate |
| `tmservice…` (**table monitoring**) | **403 Forbidden** (nginx, before auth) | origin/IP allowlisted to operators |
| `chat…/chat` (chatWS) | opens, replies `errorCode 301 "Invalid Json Request"` | per-table chat, not cards |
| `games…/game` (generic, no tableId) | **404** | the same per-table game socket; needs a `tableId` |
| `report` / `gamesearch` | 200 | not card feeds (a status page; catalogue search) |
| `gamestats` / `stats` / `simm` | 404 / 404 / 403 | live, operator-auth-gated; no player access |

**Conclusion.** The `dga-lc/ws` row above was cracked afterwards (§6k): it is the lobby's
own all-tables socket, unauthenticated, and my earlier "operator-key-only" reading was
from probing it with the wrong message shape. The DGA *REST* endpoint (`/api/tables`)
does still 401, and `broadcaster`/`tmservice` remain operator-gated — but the DGA *socket*
is reachable and carries every table's occupancy/metadata (no cards). For **card** data
the 6-socket game channel is still the only source. So: an all-tables **metadata** feed
exists and is free (§6k); an all-tables **card** feed does not.

Run again any time a session is live: `npm run probe:platform -- '<JSESSIONID>'`.

## 6j. Full client-bundle search — spectator & multi-table, traced to ground

The capture only records JS that *loaded* during that session, so a feature never
triggered (a multi-table view, the unified lobby) leaves no code on disk. To rule that
out, the complete client bundle was pulled straight from the public CDN
(`client.pragmaticplaylive.net/apps/blackjack/3.2.83/main.js`, 3.8 MB, monolithic — no
separate lazy chunks) and searched whole, the equivalent of DevTools → Sources →
Ctrl+Shift+F. Two hits the capture-only grep had missed, both chased down:

- **`Spectator = "SPEC"`** is a real user type: `isSpectatorUser()` returns
  `config.playerConfig.userType === "SPEC"`. But it is **server-assigned** and only gates
  UI (chat, whether other members' bets show). It does not change the socket, and there
  is no client path to *request* it. (This refines §6b: a spectator role exists, but it
  is a display mode on the same single-table socket, not a seat-free bypass.)
- **`multiTable` / `multitablesupport`**: `multitablesupport` is read as
  `isLauncherEnabled` — the operator's game-*container* UI. The `multiTable` value passed
  into the React connect hook is **not** appended to the socket URL, and the
  `host:"multiTable"` iframe routing is gated on `"007"===s` (baccarat). No blackjack
  multi-table container exists.

The decisive artefact is the socket URL builder itself. Every `searchParams.set` on the
game socket, across the whole bundle:

```
JSESSIONID   tableId   type=json   reconnect=true   launchSource(opt)   version(opt)
```

There is **no** `multiTable`, `channel`, `spectator`, or any multi-table query key. This
confirms §6a's `setSessionParams` finding against the full bundle, not just the loaded
subset: the client cannot ask one socket for more than one table, and `dga`,
`broadcaster` and `tmservice` appear in **no** client code — only in server-supplied
config. The "developers were lazy and left a back door in the client" hypothesis is
tested and negative: the all-tables capability is genuinely not in the player client.

## 6k. The DGA lobby socket — all tables on ONE unauthenticated connection

This is the socket the live-casino lobby iframe uses, and it is exactly the all-tables
feed §6b and §6e said did not exist as a socket. Those sections were **wrong on that
point** — corrected here. (They remain correct that no *card* feed covers all tables.)

```
wss://dga-lc.pragmaticplaylive.net/ws        Origin: https://client.pragmaticplaylive.net
```

**No `JSESSIONID`.** The lobby connects with `credentials:"omit"` and no token in the URL;
auth is by `casinoId` sent in the messages, not a session. So this feed costs **zero** of
the 6 game-socket budget and needs no login at all. Protocol recovered from the lobby
bundle `client.pragmaticplaylive.net/apps/lobby/5.14.0/main.js` (its DGA client class) and
verified on the wire:

```
client → {type:"statistics"}
         {type:"available", casinoId:"ppcdk00000005350"}
         {type:"subscribe", isDeltaEnabled:true, casinoId, key:"<operatorGameId>", currency:"EUR"}
         {type:"ping", pingTime:<ms>}
server → {globalStats:{playerCount:23998, crashPlayerCount:6997}}
         {tableKey:["1001","1101",…]}                 // every table key (operatorGameId), hundreds
         {seat1..seat7, totalSeatedPlayers, availableSeats, playerCount, dealer:{name},
          tableId, tableName, tableType, tableVariant, gameLoaderKey, onFireSeatCount,
          tableLimits, tableOpen, betbehind, multiseat, …}   // full snapshot on subscribe
         {tableId, …changed fields}                    // occupancy deltas thereafter
         {pongTime, pingTime}
```

The subscribe **`key` is the `operatorGameId`** (`1132` = sobj027blackjack, `625` =
sobj266blackjack), *not* the `tableId` the game socket uses — the snapshot echoes the real
`tableId`/`tableName` so the two can be joined.

**What it carries — and what it does not.** The client's own `processMessage` handles
exactly four shapes: `globalStats`, `pongTime`, `tableId`, `tableKey`. There is **no card,
score, hand, or shoe message anywhere in the protocol** — structurally, not just unseen.
So the DGA lobby socket gives, for **every table at once on one connection**: seat
occupancy (which of the 7 seats are taken), player counts, dealer name, limits, variant,
open/closed, and the provider's `onFireSeatCount` (hot-streak marker). It **cannot** feed
a running count — no card values ever cross it.

**Why it still matters.** It replaces the connection-budgeted REST *sampling* of §6a
entirely: all-table metadata now comes live, free, on one uncapped socket, with per-seat
occupancy the REST catalogue never had. The right architecture is DGA as the always-on
situational layer over all 176 tables — pick the six worth counting from its live
occupancy/onFire/open signals — and the six game sockets (§4–5) as the only thing that
actually sees cards. Tool: `node tools/dga-lobby.mjs [casinoId] [currency] [keys]`.

## 6f. Is there a history API on the Pragmatic backend? Tested — no.

Directly chased, because a backend history API would sidestep the socket cap and would
behave the same behind any operator (the backend is shared; only account limits differ).

**No history message on the socket.** Every message kind seen across the full 12,274-frame
capture was catalogued: `playerSeat, bet, seat, cardinc, perfectpairs, card, bj21plus3,
instantBet, timer, score, pong, table, currentShoe, dealer, game, mainBetCount, betStats,
wins, subscribe, onFire, predecisionhide, dealNow, handresult, betsclosed, startDealing`.
No roadmap / results-history message exists. The socket sends current-round state only.
This is structural — blackjack outcomes are per-seat, so there is no shared roadmap the
way roulette and baccarat have.

**`/api/ui/stats` — parameter found, returns nothing.** It answered "Need no of games to
get stats", so its count parameter was brute-forced: **`noOfGames`** is the one that
satisfies it (all others still error). But with `noOfGames=20` it returns a bare
`{"errorCode":"0","description":"Ok"}` — 36 bytes, no data — identically for every table
and every `game` value. In the bundle it sits behind `miniPlayActive` alongside
`recentResults`/`statisticHistory`, i.e. it backs the *player's own* mini-play recent
hands, and is empty here because this account is a spectator with no bet history on those
tables. It is player-scoped, not a table-wide results feed.

**Every other history-shaped path is a real 404:**

```
/api/history  /api/game/history  /api/table/history  /api/results
/api/gameHistory  /api/ui/gameHistory  /api/statistics
   -> "Could not find resource for relative : /… "
```

(`/api/fetchRoundHistory` and `/api/v2/fetchRoundHistoryByWS` live only on
`promo.pragmaticplaylive.net`, need a promotions Bearer JWT, and return the player's own
promotional rounds — not table results. See §6b.)

**Conclusion:** the Pragmatic backend exposes no table-results history API. Blackjack
outcomes are available only as the live per-table socket stream, capped at 6 concurrent
per account. A different operator would front the same backend with the same absence of a
history feed.

## 6g. Token lifetime and video-socket auth

Two claims tested: that a Pragmatic `JSESSIONID` is durable on its own and only the
Stoiximan session needs refreshing, and that the video feed is a freely reachable
"hidden" URL.

**A minted `JSESSIONID` is durable for a window, then dies.** Reconnected the game
socket with tokens of several ages: one minted earlier the same session still streamed
full card data minutes later with no re-launch; tokens from much earlier (and the
oldest supplied one) were dead — the socket opens, redirects via `switch`, then goes
silent. So the app can reuse a token across many polls rather than re-launching each
time, but it does expire.

The token carries its own server-node route in the suffix (`…!365564907-…` vs a dead
`…!514001511-…`); a stale token points at a node that no longer holds its session.

Practical reading of "only Stoiximan needs refreshing": the **operator** session is
what you re-authenticate (via `npm run login`) in order to *mint a new* Pragmatic
token through the launch chain. An already-minted Pragmatic token then works on its
own until it lapses. Both expire; the operator one is simply the gate to minting more.

(A methodology note: an early version of the durability test reported false rejections
because a `switch` redirect closes the first socket with zero data messages, which the
test misread as a dead token. Guarding the redirect close fixed it.)

**The video socket requires a valid token — it is not open.** Tested `ws1` with no
token, an empty token, a garbage token, and a real-but-dead token: **all four streamed
zero media.** A fresh valid token on the same URL streamed immediately (5 fMP4 frames,
133 KB). So the video URL in §6c is the standard authenticated feed, not a hidden
unauthenticated one, and it needs a live `JSESSIONID` like everything else.

**Relevance to the cap:** none. Token durability and the separate video budget do not
add concurrent game-data tables. The 6-socket limit is per account on the game-data
channel and is independent of how fresh the token is.

## 6h. Can a token be minted without a browser? Tested — no.

Asked whether the refresh could drop Chrome entirely, since *using* a token needs no
browser at all (the feed opens `gs<N>` sockets directly with `ws`).

Running the sockets and minting a token are different problems. Minting goes through
the operator's own launch chain (§3), and that chain sits behind the operator's bot
protection. Two independent measurements say a non-browser client cannot reach it:

| Client | Result |
|---|---|
| `--headless=new` Chrome | **HTTP 403** |
| real Chrome window, parked off-screen | **HTTP 200**, page renders |
| plain Node `fetch`, Chrome UA + headers (since-removed fetch-mint probe) | **HTTP 403** |

The first two rows are a controlled A/B (a since-removed headless probe): same machine, same
IP, same minute, same throwaway profile, same public URL — the *only* variable is
headless. Headless is therefore detected as a client and refused; it is not a network,
geo or account problem. (The 403 body claims a regional restriction, but the headful
request from the same IP seconds later succeeds, so that message is the bot-block path
wearing a geo costume — worth knowing, since it misdirects debugging.)

The plain-`fetch` 403 comes back on the **public live-casino lobby too**, with no
cookies and no login involved — so the block is on the request itself, not on
authentication. Supplying the account's real session cookies would therefore not help:
the edge refuses the client before cookies are considered. Replaying the launch chain
with `fetch` (or with a stored cookie jar) is not viable.

**Conclusion.** A real browser is required to *mint*, and only to mint. Nothing else in
the app uses one:

- running tables — no browser, ever (direct `ws` sockets)
- reusing a stored token across restarts — no browser
- accepting a pasted token — no browser
- minting a **new** token — browser required, launched off-screen for ~20 s and closed

Since the watchdog re-validates each token every few minutes (which is itself traffic
on the session), a continuously running monitor should rarely need to mint at all.

## 7. Not confirmed

`games.pragmaticplaylive.net/api/ui/stats` exists and answers
`{"description":"Need no of games to get stats"}`, which suggests a history backfill.
The parameter name is **not** in the Blackjack bundle (no `noOfGames`, `numberOfGames`,
`gamesCount`), so it appears to belong to another game type. I did not guess at it.
Backfill may not be needed: the socket sends current table and shoe state on connect.

## 8. Tools in this repo

| File | Purpose |
|---|---|
| `server.mjs` + `public/` | local dashboard, `npm run dev` on :3001 |
| `src/feed.mjs` | multi-table read-only feed; redirect-following, card decode, shoe resets |
| `src/multifeed.mjs` | one feed per operator session, merged into one table list |
| `src/session.mjs` | mints a `JSESSIONID` automatically from the signed-in profile |
| `tools/login.mjs` | `npm run login` — sign in once; the profile persists |
| `tools/get-session.mjs` | `npm run session` — mint and print a session |
| `tools/list-tables.mjs` | fetch + print the live lobby catalogue; refreshes `data/lobby-tables.json` |
| `tools/capture.mjs` | launches Chrome under CDP, records all requests + WS frames to `capture/` |
| `tools/analyze.mjs` | summarises a capture: hosts, endpoints, socket frame shapes |
| `tools/inspect-req.mjs` | print the captured request/response for URLs matching a substring |
| `tools/monitor.mjs` | **read-only multi-table monitor** — cards, results, shoe changes, Hi-Lo count |
| `tools/ws-analyze.mjs` | dump any one socket's frames to JSON (parses fMP4 boxes and JSON/XML control) |
| `tools/ws-analyze-game.mjs` | dump a game socket's messages grouped by kind; follows `switch`; read-only ping |
| `tools/probe-platform.mjs` | **probe the platform services above the game socket** (§6i) for a multi-table feed |
| `tools/dga-lobby.mjs` | **all-tables lobby feed** on one unauthenticated socket — occupancy/dealer/onFire, no cards (§6k) |

```
node tools/capture.mjs                          # log in once; profile persists
node tools/monitor.mjs '<JSESSIONID>'           # 6 tables, live cards, no video
node tools/probe-platform.mjs '<JSESSIONID>'    # test broadcaster/tmservice/dga for all-table feed (§6i)
```

The monitor counts each physical card once even though tables report cards through
`card`, through `playerSeat`, or both, and `playerSeat` repeats the whole hand on
every update.

## 9. Worth knowing

This reads a logged-in account's own session. Many operators' terms restrict automated
access to an account even for data you are entitled to see, and the `duplicatePlayerSession`
cap means a wide monitor is visible server-side as an unusual pattern. Worth reading the
terms before running this continuously.
