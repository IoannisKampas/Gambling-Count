# Blackjack Wall — Design Spec

Implementation spec for the redesigned live table-monitoring UI. Dark, low-glare, instrument-like: a surface someone stares at for hours while tracking counts across dozens of tables.

## 1. Design principles

1. **True count is the primary object.** Everything else on a card is context for it. It gets the largest type on screen and the only saturated color.
2. **Green is positive, red is negative, and nothing else may use them.** Blue is chrome, amber is round state. A glance at color alone must answer "is this shoe worth playing".
3. **Rank by opportunity, not alphabetically.** Default sort everywhere is true count descending. A counter should never scan for the hot shoe.
4. **Fixed footprints.** A table card is the same height whether a hand is dealt or the shoe is shuffling. Ragged card heights destroy scannability in a grid.
5. **Numbers never clip.** Count columns are fixed-width with reserved space for sign + two digits + decimal.
6. **Decisions over data.** Where a number implies an action (bet sizing, sit-out), show the action next to the number.
7. **Closed/idle tables approach zero visual weight** — dimmed text, no accent color, no borders.

## 2. Color palette

Navy-felt palette. Blue is the environment; **green and red mean the count and nothing else**.

### Surfaces
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#16181D` | Page background (with radial wash, §2.1) |
| `--surface` | `#1E212A` | Cards, list container |
| `--surface-sunk` | `#1A1D24` | Sub-headers, bet-advice strip, list toolbar |
| `--surface-raised` | `#23272F` | Inputs, chips, tags, buttons |
| `--border` | `#30353F` | Card / container borders |
| `--border-hover` | `#424854` | Card hover border |
| `--divider` | `#282D35` | Dividers inside a card |
| `--row-hover` | `#24282F` | Table row hover |
| `--track` | `#2C313A` | Progress-bar tracks |

### Felt (hand area only)
| Token | Hex | Use |
|---|---|---|
| `--felt-top` | `#1E3350` | Seat area gradient top |
| `--felt-bottom` | `#182A44` | Seat area gradient bottom |

Deep navy felt, only inside the seat area. Hole card = 45° repeating stripe `#2A4470` / `#22385C` at 3px.

### Text
| Token | Hex | Use |
|---|---|---|
| `--ink` | `#EEF0F5` | Primary values, table names (`#F6F8FB`) |
| `--ink-2` | `#D5D9E2` | Seat totals |
| `--ink-3` | `#C3C8D3` | Running count, dealer name |
| `--ink-muted` | `#9FA6B3` | Metadata (limits, dealer in list) |
| `--ink-dim` | `#979FAC` | Labels, tags |
| `--ink-faint` | `#9BA2AF` | Seat labels (on felt), RUN / TRUE micro-labels |
| `--ink-fainter` | `#949CA8` | Timestamps, list column headers, empty state |
| `--ink-disabled` | `#5B616C` | Closed-table values (`—`) |

### Count scale — the only green and red in the UI
| Token | Hex | Meaning |
|---|---|---|
| `--count-hot` | `#4FD98A` | TC ≥ threshold + 1 — play, scale up |
| `--count-warm` | `#7FCF9B` | TC ≥ threshold − 0.5 |
| `--count-plus` | `#9FD6B5` | TC ≥ 0.5 — marginally positive |
| `--count-neutral` | `#9FA6B3` | −1 < TC < 0.5 — no signal |
| `--count-minus` | `#E8706E` | TC ≤ −1 — negative shoe |

Positive counts are green and get greener with strength; negative counts are red. Nothing else in the interface may use these five values.

### Chrome / brand (blue)
| Token | Hex | Use |
|---|---|---|
| `--brand` | `#3C5A8A` | Session buttons, active filter borders, logo border |
| `--brand-surface` | `#223C5C` | Session button fill, logo fill |
| `--brand-ink` | `#A9C8F0` | Section labels, links, spinner, text on brand surfaces |
| `--pen` | `#4A6E9E` | Penetration bar fill + open status dot |
| `--btn-border` | `#373D47` | Ghost buttons (UNPIN / PIN) |
| `--dot-closed` | `#3A404A` | Closed status dot |
| `--bar-closed` | `#313742` | Closed-table penetration bar |

### Round state (amber — deliberately not on the count scale)
| Token | Hex | Use |
|---|---|---|
| dealing tag | `#1F3F33` bg / `#6FD3A5` fg | Hand in play |
| betting tag | `#34301F` bg / `#E0B15A` fg | Bets open |
| dealer row label | `#E0B15A` | `DEALER` seat label |
| advice strip (hot) | `#1E3A32` | Strip background lifts when TC ≥ 3 |

### Playing cards
Face `#F7F8FA`, black suits `#22262B`, red suits `#C4453C`.

### 2.1 Background wash
`radial-gradient(1200px 600px at 20% -10%, #1F2530 0%, #16181D 60%)` — subtle depth top-left so a full-bleed dark page does not read flat.

## 3. Typography

| Role | Font | Spec |
|---|---|---|
| Titles, table names, section labels | **Barlow Condensed** 600 | uppercase, `letter-spacing: .07–.28em` |
| Body, metadata, inputs | **Barlow** 400/500 | 11–13px |
| All numerics, tags, micro-labels | **JetBrains Mono** 500/700 | tabular alignment is the point |

Sizes: true count **34px/700 mono**; running count 15px/700 mono; seat totals 14px/700 mono; table name 17px condensed; micro-labels 8–9px mono at `.14em` tracking. Never below 8px, and only mono all-caps labels are allowed that small. Every ink token must clear 4.5:1 against every surface it is used on — including the felt (`#1E3350`), which is the lightest ground in the UI.

## 4. Layout

- Page padding `24px`; sticky top bar with `blur(12px)` and 92%-opacity background.
- **Live board**: `grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px`. Fluid — 1 to 5+ columns.
- **All tables**: single container, `grid-template-columns: 14px minmax(120px,1.4fr) minmax(90px,1fr) 64px 58px minmax(70px,90px) 56px` with `gap: 12px`, identical on header and rows.
- Radii: containers/cards `12px`, controls `6px`, tags `3–5px`, card faces `4px`.
- Section headers: condensed uppercase label + hairline rule fading to transparent + right-aligned mono meta.

## 5. Table card anatomy (top → bottom)

1. **Header** — name (condensed, ellipsized), casino tag, state tag (`DEALING` green-on-`#1F3F33` / `BETTING` amber-on-`#34301F`); right side: running count (small, `--ink-3`) then true count (34px, heat-colored) with `RUN` / `TRUE` micro-labels beneath. `min-width: 62px` on the TC column reserves space so `-10.5` never clips.
2. **Bet advice strip** (toggleable) — `BET` label · recommendation (`3× UNIT`, or `MIN / SIT OUT` when TC < 0.5) · 4px count-colored bar mapping TC from −2…+6. Background lifts to `#1E3A32` when TC ≥ 3.
3. **Seat area** — `min-height: 174px`, felt gradient. Rows: 52px label (`DEALER` in amber `#E0B15A`, seats in `--ink-faint`), card pills, right-aligned total. Total colors: 21 → `--count-hot`, bust → `--count-minus`, else `--ink-2`. Dealer shows `sum/–` while the hole card is down. If no hand: centered spinner ring + `SHUFFLE / NEXT ROUND` at the same height.
4. **Footer** — penetration bar (5px, `linear-gradient(90deg,#3C5A8A,#4A6E9E)`, width = cardsSeen / (decks×52)) + `Nd left`; dealer name, shoe id, last-update age, `UNPIN` (border turns `--count-minus` on hover).

## 6. All-tables list

Toolbar: search (name / dealer / casino), `LIVE ONLY` toggle, `HOT ≥ n` toggle, `SORT · TRUE COUNT | PENETRATION | NAME` cycle button. Active toggles use `--brand` border + `--brand-surface` fill + `--brand-ink` text; inactive use `--surface-raised` + `--border`.

Row: status dot (7px — `--count-hot` if hot, `--pen` if open, `--dot-closed` if closed) · name + casino · dealer · limits · running · true (heat) · penetration mini-bar · `PIN`. Closed rows: name `--ink-faint`, counts `—`, bar `--bar-closed`, no action.

## 7. Data rules

```
trueCount = runningCount / max(0.5, decks - cardsSeen / 52)
heat(tc, hot):  tc >= hot+1 → --count-hot
                tc >= hot-0.5 → --count-warm
                tc >= 0.5 → --count-plus
                tc > -1 → --count-neutral
                else → --count-minus
betUnits = clamp(round(tc - 0.5), 1, 8)      // shown only when tc >= 0.5
penetration = cardsSeen / (decks * 52)
```
Running count formats with an explicit sign (`+7`, `-2`, `0`); true count to one decimal with sign. Totals use soft-ace logic (aces demote from 11 while sum > 21).

## 8. Motion

Restrained: card entry `translateY(6px)` + fade over 400ms; live/shuffle indicators use a 1.4–2s opacity pulse; hover transitions on borders only. No layout-shifting animation — a moving grid is unreadable when values update every few seconds.

## 9. Configurable

- `showBetAdvice` (bool, default true) — hides strip 2.
- `hotThreshold` (0.5–5, step 0.5, default 2) — drives the heat scale, the `HOT ≥ n` filter, and the header hot counter.
- `compactSeats` (bool, default false) — suppresses card pills, keeps labels and totals; roughly doubles board density.

## 10. Not yet designed

- Threshold alerting (sound / toast when a shoe crosses hot).
- Multi-user vs single-operator monitoring (affects whether pins are personal or shared).
- Count-history sparkline per table.
