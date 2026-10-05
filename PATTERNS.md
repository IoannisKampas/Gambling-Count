# The ten patterns, in full

Everything needed to implement these patterns against your own roulette scraper, in any language.
Nothing here is specific to this app: a pattern is a pure function of the sequence of numbers, so
if your scraper can produce the spins in order, you can reproduce every count this app shows.

Read §1–§4 to understand the patterns, §5 to implement them, §7 to prove your implementation is
right, and §8 for the part that actually breaks in practice — feeding it spins correctly.

---

## 1. What is being counted

All ten patterns watch for one shape in the sequence of spins:

> a **run** of numbers from the same group, **interrupted** by the other group, and then **one
> spin that decides** what the interruption meant.

Every time the decider goes one way, a counter goes one deeper: `0 → −1 → −2 → −3 …`. Every time
it goes the other way, the counter is wiped back to `0`. The counter is therefore *how many
deciders in a row have gone your way*, and the interesting thing to watch for is a count that has
got deep without being wiped.

They differ in only three respects: **what it takes to arm**, **how long the interruption must
get before it is decided**, and **which way that decider has to go.** Everything else — the two
group lists, the bookkeeping afterwards — is identical in all ten.

| | run needed to arm | which group may arm | armed once the interruption reaches | decided once it reaches | the decider that counts |
|---|---|---|---|---|---|
| **All in 1** | 3 or more | either | 1 | 2 | the original group returns |
| **Monada** | **1 or more** | **group A only** | 1 | 2 | the interrupting group carries on |
| **Diada** | **1 or more** | **group A only** | **2** | **3** | the interrupting group carries on |
| **Triada** | **1 or more** | **group A only** | **3** | **4** | the interrupting group carries on |
| **Ena/Duo** | **1 or more** | **group A only** | 1 | **3** | the interrupting group carries on |
| **All in 2** | 3 or more | either | 1 | 2 | the interrupting group carries on |
| **Monada 2** | **1 or more** | **group B only** | 1 | 2 | the interrupting group carries on |
| **Diada 2** | **1 or more** | **group B only** | **2** | **3** | the interrupting group carries on |
| **Triada 2** | **1 or more** | **group B only** | **3** | **4** | the interrupting group carries on |
| **Ena/Duo 2** | **1 or more** | **group B only** | 1 | **3** | the interrupting group carries on |

### 1.1 Five readings, each with an opposite

The ten are five readings and their opposites, which is how the app lays them out — a row each:

| | **All in 1** | **Monada** | **Diada** | **Triada** | **Ena/Duo** |
|---|---|---|---|---|---|
| **its opposite** | All in 2 | Monada 2 | Diada 2 | Triada 2 | Ena/Duo 2 |

The `2` suffix means *the opposite of*, and it means the same thing in every column but the first:

- **All in 2 inverts the decider.** Both All in readings arm on a run of three or more from
  *either* group; they disagree about which way the deciding spin has to go.
- **Every other `2` exchanges the groups.** Monada arms on a group-A run, Monada 2 on a group-B
  run, and nothing else about them differs. Monada scores on `ABB`; Monada 2 scores on `BAA`, the
  shape Monada explicitly ignores — so a reading and its opposite can never score on the same
  spin, and on a live table they disagree almost all the time.

The names say the arming depth. *Monada* arms once the interruption reaches **one** spin, *diada*
at **two**, *triada* at **three**. *Ena/Duo* names its two arms, at **one and two** — it is armed
across the depths Monada and Diada cover between them. **All in** is the pair that arms from
either group's run, and the only pair that is not one-way.

Everything but the All in pair is one-way, and those eight fire far more often: `ABB` scores under
Monada and arms Diada, Triada and Ena/Duo, while neither All in reading even arms on it.

The app carries that structure in colour, using the same two it uses for the groups themselves:
**Monada, Diada, Triada and Ena/Duo are blue**, because they arm on a group-A run; **their four
opposites are orange**, arming on a group-B run. The All in pair take neither, arming on either.
Nothing is carried by colour alone — the `2` suffix already separates each pair.

### 1.2 How arming depth and deciding depth relate

The last two columns of the table above are the ones to read together. For every reading but the
two Ena/Duo ones they are one apart — arm, and the very next spin decides — which makes the
one-way readings simply the same shape at different depths: Monada wants `ABB`, Diada `ABBB`,
Triada `ABBBB`.

The Ena/Duo pair set them **two** apart, and that is what gives each of them two arms: armed from
the first interrupting spin, so a return wipes the count from there, but only the second arm can
deepen it. Being armed early and deciding late, they are armed more often than anything else here
and keep their counts least well.

Among the three single-arm opposites the depths are mutually exclusive: each wants the trailing
run after a B to be a different length, so **at most one of Monada 2, Diada 2 and Triada 2 can be
armed at any moment.** Ena/Duo 2 sits deliberately outside that — armed at one *and* two, it is
armed exactly when Monada 2 or Diada 2 is, and so is armed alongside one of them nearly half the
time. It is never armed alongside Triada 2. The same three statements hold of Monada, Diada,
Triada and Ena/Duo on the other group.

### 1.3 How often each fires

The deeper a reading's arming, the rarer it is: Triada needs four spins of the same group in the
right place where Monada needs two.

The group-B readings are rarer than their group-A twins, because the groups are not the same size
and a group-B reading's *interrupting* group is group A, the 18-number one. Arming needs that
group *n* times and scoring *n+1*, so each extra factor of 18⁄19 compounds. An opposite arming at
depth **n** fires **(18⁄19)ⁿ⁻¹** as often as its twin and scores **(18⁄19)ⁿ** as often:

| | arms vs its twin | scores vs its twin |
|---|---|---|
| **Monada 2** vs Monada | **exactly as often** — (18⁄19)⁰ | ≈5% less often |
| **Diada 2** vs Diada | ≈5% less often | ≈10% less often |
| **Triada 2** vs Triada | ≈10% less often | ≈15% less often |
| **Ena/Duo 2** vs Ena/Duo | ≈2% less often | ≈10% less often |

Monada 2 is the one case where the arming rates are identical, since one A and one B in either
order have the same probability. From Diada 2 down they are not, and an opposite that appeared to
fire as often as its twin would be the sign of a dropped `armsFrom`.

Ena/Duo 2 is the exception to the formula, and has to be: with two arms its arming rate is a sum
over both depths, which nearly cancels the group-size difference — hence ≈2% rather than ≈5%. Its
*scoring* rate is Diada 2's exactly, since the two score on the same spins.

In absolute terms Triada 2 is the rarest reading in this document: it needs a B followed by four
As, which is 19·18⁴⁄37⁵ ≈ 2.8% of spins against Triada's ≈3.3%, so on a table producing a spin a
minute it scores roughly once every half hour. At the other end, Ena/Duo 2 is armed on ≈37% of
spins — more than anything but Ena/Duo itself — and keeps its counts the least well of the four
group-B readings.

---

## 2. The groups

Every number 0–36 belongs to group **A** or group **B**. The split is fixed and arbitrary; it is
not red/black, odd/even, or any standard bet.

| group | numbers | how many |
|---|---|---|
| **A** | 0, 1, 2, 3, 6, 7, 8, 10, 13, 14, 17, 20, 23, 25, 26, 27, 28, 29 | 18 |
| **B** | 4, 5, 9, 11, 12, 15, 16, 18, 19, 21, 22, 24, 30, 31, 32, 33, 34, 35, 36 | 19 |

Note the two things people get wrong:

- **Zero is in group A.** It is not neutral, not skipped, not a reset. It is an ordinary group-A
  spin and takes part in runs like any other.
- **The groups are not the same size** (18 vs 19), so the two are not equally likely. This is a
  single-zero (European, 37-pocket) wheel. On a double-zero wheel you would have to decide where
  `00` goes before any of this means anything; this app does not support one.

A number outside 0–36, or a non-integer, is not a spin. Reject it loudly — do not coerce it, and
do not let it silently fall into a group.

### 2.1 The colours

Group membership is the one thing every count turns on, so it is carried by colour everywhere it
appears — the spin strips, the run letters on each card, the mark in the header, the depth bars in
the stats, and the reading tabs themselves. Use these if you want your own screens to read the
same way:

| group | colour | hex | where it is used |
|---|---|---|---|
| **A** | blue | `#3987e5` | group-A spins, group-A run letters, shallow depth bars, the tabs for readings that arm on a group-A run |
| **B** | orange | `#d95926` | group-B spins, group-B run letters, at-or-past-threshold depth bars, the tabs for readings that arm on a group-B run |

Both are set once as CSS custom properties (`--group-a`, `--group-b` in `src/renderer/index.css`)
and referenced everywhere else, so the two groups cannot end up drawn in different colours in
different places.

Why these two: they are the first two slots of a validated categorical palette, chosen to stay
distinguishable for the most common forms of colour blindness and to hold up on a dark background
that is going to be left open for hours. **Deliberately not red and black** — on anything to do
with a roulette wheel, red/black already means something else, and using it here would suggest the
groups are the wheel's colours when they are not. Nothing in the pattern depends on the colours;
they are a reading aid, and the letters `A`/`B` are always shown as well so nothing is carried by
colour alone. The same applies to the tabs: a reading's colour says which group's run arms it, but
the `2` suffix already separates each reading from its opposite, so the names stay unambiguous
without it. The All in pair arm from either group and so take neither colour.

The supporting colours, for completeness: page `#0d0d0d`, panels `#1a1a19`, gridlines `#2c2c2a`,
primary text `#ffffff`, secondary `#c3c2b7`, muted `#898781`; status green `#0ca30c`, amber
`#fab219`, red `#d03b3b`. A count is coloured by depth rather than by group — plain white down to
−1, amber from −2, red from −4 — so depth and group never compete for the same colour.

---

## 3. The rules — All in 1

State you need: a **count**, a **phase** (`BUILDING` or `INTERRUPTED`), the **group of the current
run** and **how long that run is**, and, while interrupted, the **origin group** — the group whose
run was broken.

### 3.1 Building a run

While `BUILDING`, each spin either extends the current run (same group) or starts a new one
(different group).

A run **qualifies** once it reaches **length 3**. Longer is fine — a run of six qualifies exactly
as a run of three does; there is no extra credit for length.

### 3.2 Arming

When a qualifying run (length ≥ 3) is broken by one spin of the other group, the pattern **arms**:
the phase becomes `INTERRUPTED`, and the group that had the run is remembered as the **origin
group**.

If the run was shorter than 3 when it was broken, nothing happens at all — the new group simply
starts a run of one. This is the **deadzone**: chopping back and forth (A B A B) never arms
anything and, importantly, never resets a count either. A count survives any amount of chop; it is
only ever wiped by a decider going the wrong way.

### 3.3 The decider

The **very next spin after arming** resolves it, always, with no third option:

| that spin | All in 1 | All in 2 |
|---|---|---|
| **returns** to the origin group (AAA·B·**A**) | count −1 | **reset to 0** |
| **repeats** the interrupter (AAA·B·**B**) | **reset to 0** | count −1 |

The count only ever deepens by one or is wiped to zero. There is no partial credit, and a wiped
count carries nothing forward.

### 3.4 Bookkeeping after the decider — the subtle part

After the decider the phase returns to `BUILDING`, and the deciding spin **becomes the start of
the next run**. How long that run is depends on what landed, *not* on which pattern you are
running:

- The spin **returned** to the origin group: it stands alone, so the new run is **length 1**.
- The spin **repeated** the interrupter: that group has now been seen twice in a row, so the new
  run is **length 2**.

This carry is not a detail. It is what lets counts chain: `AAABBBAA` reaches −2 under All in 2
precisely because the scoring `B` is already the second `B` of the new run, so a single further
`B` qualifies it. Get this wrong and every chained count comes out one shallower than it should.

The origin group is cleared at the same moment. There is exactly one decider per arming.

---

## 4. The other nine patterns

### 4.1 All in 2

Identical to All in 1 in every respect — the same groups, the same run of three or more, the same
single deciding spin, the same run bookkeeping — except that the two outcomes of the decider are
swapped:

```
AAA          a qualifying run of group A
AAAB         armed: B interrupted it, origin group is A
AAABB   →    the interrupter repeated    →  count −1     (All in 1 would reset here)
AAABA   →    the original group returned →  reset to 0   (All in 1 would count −1 here)
```

Worked further:

```
AAABB        −1
AAABBBAA     −2     the scoring B is already run-length 2, so BBB qualifies and AA decides it
AAABBBAAABB  −3
AAABBBAAABA   0     armed on the A-run, the origin group returned, so it is wiped
```

Because the two patterns read the same spins in opposite directions, they will regularly disagree
about the same table at the same moment. That is expected, not a bug. Neither is a correction of
the other; they are readings of the same spins, tracked side by side.

### 4.2 Monada

The third reading **only works one way**. Where the first two are symmetrical — an A-run and a
B-run behave identically — this one arms on a run of **group A only**, and one A is enough:

```
A            a run of group A, of any length
AB           armed: a single B broke it
ABB    →     the interrupter repeated    →  count −1
ABA    →     the original group returned →  reset to 0
```

Worked further:

```
ABB          −1
ABBABB       −2      the next A starts the shape over
ABBABBABB    −3
ABBABBABA     0      armed again, and the A came back, so it is wiped
AABB         −1      a longer A-run still arms on the first B
BBBAA         0      a B-run never arms anything, however long it gets
ABBB         −1      one score per arming; a third B adds nothing by itself
```

Three consequences worth stating plainly:

- **A run of group B is inert.** It never arms, and an A interrupting it does nothing. The mirror
  image of the scoring shape, `BAA`, scores nothing at all. This is what "one way" means.
- **It arms constantly.** Any A followed by any B arms it, so on a live table it is armed a large
  fraction of the time, and its count moves far more often than the other two.
- **It sees shapes the others cannot.** `ABB` is invisible to the All in pair, because a run of
  one never arms them.

### 4.3 Diada

One-way like Monada, armed by the same group-A run, but it waits a spin longer: the
interruption has to reach **two** spins before anything is armed.

```
A            a run of group A, of any length
AB           the interruption has started — nothing is armed yet
ABB          armed: the second B is what arms it
ABBB   →     the interrupter carried on   →  count −1
ABBA   →     the original group returned  →  reset to 0
```

Worked further:

```
ABBB         −1
ABBBABBB     −2      the next A starts the shape over
ABBBABBBABBB −3
ABBBABBBABBA  0      armed again, and the A came back, so it is wiped
AABBB        −1      a longer A-run still arms
ABBBB        −1      one score per arming; a fourth B adds nothing by itself
ABA           0      the interruption stopped at one B: nothing happened at all
BBBAA         0      a B-run never arms anything
```

The third line from the bottom is the one that separates this from every other pattern here: **an
interruption that stops at one B decides nothing.** It is not a count and it is not a reset — the
shape never completed, so a count already standing is left exactly where it was. Under Monada
that same `ABA` is a reset.

Monada and Diada are worth comparing directly, because they look alike and behave differently:

| shape | Monada | Diada |
|---|---|---|
| `AB` | armed | building the interruption |
| `ABB` | **−1** (scored) | **armed** |
| `ABBA` | −1 (the A did nothing) | **0** (the A wiped it) |
| `ABBB` | −1 (the third B did nothing) | **−1** (the third B scored) |
| `ABBABB` | −2 | 0 |

### 4.4 Ena/Duo

Monada and Diada combined: **it arms twice, and only the second arm can score.**

```
A            a run of group A, of any length
AB           armed, once — an A now would wipe the count, but a B cannot score yet
ABA    →     the original group returned  →  reset to 0      (at the first arm)
ABB          armed again — still nothing counted
ABBB   →     the interrupter carried on   →  count −1        (at the second arm)
ABBA   →     the original group returned  →  reset to 0      (at the second arm)
```

Worked further:

```
ABBB             −1
ABBBABBB         −2
ABBBB            −1      one score per pair of arms; the fourth B adds nothing
ABBBBAAAAABBB    −2      two complete blocks, with a long A-run between them
ABBBABA           0      the first arm of the second block wiped the −1
AABBB            −1      a longer A-run still arms
BBBAAA            0      a B-run never arms anything
```

Where it takes each half from:

- **From Diada, the scoring.** Wherever Diada counts, this counts, on the same spin. Its
  count can therefore never be deeper than Diada's — same gains, more losses.
- **From Monada, the reset.** A return at the first arm wipes the count, exactly as it does
  under Monada. It is the one thing Diada ignores, and it is where the two diverge:

| shape | Diada | Ena/Duo |
|---|---|---|
| `AB` | building the interruption | **armed** |
| `ABA` | nothing at all | **reset to 0** |
| `ABB` | armed | armed (again) |
| `ABBB` | −1 | −1 |
| `ABBA` | 0 | 0 |
| `ABBBABA` | **−1** (the near miss was ignored) | **0** (the near miss wiped it) |

And against Monada, which scores a spin earlier:

| shape | Monada | Ena/Duo |
|---|---|---|
| `ABB` | **−1** (scored) | 0 (armed again) |
| `ABBABB` | −2 | 0 |
| `ABA` | 0 (reset) | 0 (reset) |

### 4.5 Triada

Diada, one spin deeper again. The interruption must reach **three** before anything is armed,
and the fourth spin decides.

```
A             a run of group A, of any length
AB, ABB       the interruption is building — nothing is armed yet
ABBB          armed: the third B is what arms it
ABBBB   →     the interrupter carried on   →  count −1
ABBBA   →     the original group returned  →  reset to 0
```

Worked further:

```
ABBBB              −1
ABBBBABBBB         −2
ABBBBBBBABBBBB     −2      two blocks; the extra Bs in each add nothing
ABBBBB             −1      one score per arming
ABA  /  ABBA        0      the interruption gave up before arming: nothing happened
AABBBB             −1      a longer A-run still arms
BBBBAAA             0      a B-run never arms anything
```

Like Diada, an interruption that gives up before it arms decides nothing — `ABA` and `ABBA`
leave a standing count exactly where it was. Only `ABBBA`, a return once it is armed, resets.

The four one-way patterns lined up on the same interrupting run:

| trailing run after an A | Monada | Diada | Ena/Duo | Triada |
|---|---|---|---|---|
| `AB` | **armed** | building | **armed** | building |
| `ABB` | **−1** | **armed** | armed again | building |
| `ABBB` | — | **−1** | **−1** | **armed** |
| `ABBBB` | — | — | — | **−1** |
| `ABBBA` | — | 0 (already scored) | 0 (already scored) | **reset to 0** |

None of the group-B readings is in that table, on purpose: they are not measured on a trailing
run after an A at all. Their own ladder is in §4.8, and the two-armed one in §4.9.

### 4.6 Monada 2

The seventh reading is **Monada with the two groups exchanged**, and nothing else. Only a run
of **group B** arms it, one B is enough, and the interrupting A carrying on is what scores:

```
B            a run of group B, of any length
BA           armed: a single A broke it
BAA    →     the interrupter repeated    →  count −1
BAB    →     the original group returned →  reset to 0
```

Worked further:

```
BAA          −1
BAABAA       −2      the next B starts the shape over
BAABAABAA    −3
BAABAABAB     0      armed again, and the B came back, so it is wiped
BBAA         −1      a longer B-run still arms on the first A
AAABB         0      an A-run never arms it, however long it gets
BAAA         −1      one score per arming; a third A adds nothing by itself
```

Everything said about Monada in §4.2 holds here with the letters swapped: a run of group A is
inert, it arms constantly, and it sees shapes the All in pair cannot. The two consequences
specific to it being the mirror:

- **It and Monada can never score on the same spin.** Monada's decider is a B following an
  A that broke an A-run; Monada 2's is an A following a B that broke a B-run. The two shapes are
  mutually exclusive, so the counts are independent in the strongest sense — they are not two
  measurements of one thing.
- **The two are not a hedge.** It is tempting to read a deep Monada 2 as confirmation of a deep
  Monada, or as insurance against it. It is neither: `BAABAABAA` is −3 on Monada 2 and 0 on
  Monada, and no single spin can deepen both.

Between them, Monada and Monada 2 arm on *every* spin that breaks a run, and on no other:
whichever group the broken run belonged to, one of the two arms, and exactly one, since a spin
cannot break a run of both groups at once.

### 4.7 Diada 2

**Diada with the two groups exchanged**, which makes it Monada 2 one spin deeper: the same
group-B run, but the interruption has to reach **two** As before anything is armed.

```
B            a run of group B, of any length
BA           the interruption has started — nothing is armed yet
BAA          armed: the second A is what arms it
BAAA   →     the interrupter carried on   →  count −1
BAAB   →     the original group returned  →  reset to 0
```

Worked further:

```
BAAA          −1
BAAABAAA      −2      the next B starts the shape over
BAAAA         −1      one score per arming; a fourth A adds nothing by itself
BBAAA         −1      a longer B-run still arms
BAB            0      the interruption gave up before arming: nothing happened
BAAABAB       −1      and a near miss leaves a standing count alone
AAABBB         0      an A-run never arms it, however long it gets
```

The `BAB` row in §4.8's ladder is where this reading and Monada 2 part company, on only three
spins: a reset there, nothing at all here.

So the shallower mirror is quicker to score *and* quicker to be wiped. Which of the two ends up
deeper on a given table is genuinely not decidable in advance — **neither dominates the other**.
It is tempting to assume the earlier-arming reading always leads, the way Ena/Duo can never be
deeper than Diada, but that relationship holds only between readings that score on the *same*
spins. These two do not: Monada 2 gets ahead by scoring a spin sooner, then falls behind when a
`BAB` wipes it that Diada 2 ignored entirely. Both orderings occur, and often. The same holds
between either of them and Triada 2.

### 4.8 Triada 2

**Triada with the two groups exchanged**, and the third rung of the mirror ladder: the same
group-B run, but the interruption has to reach **three** As before anything is armed.

```
B            a run of group B, of any length
BA, BAA      the interruption is building — nothing is armed yet
BAAA         armed: the third A is what arms it
BAAAA  →     the interrupter carried on   →  count −1
BAAAB  →     the original group returned  →  reset to 0
```

Worked further:

```
BAAAA              −1
BAAAABAAAA         −2      the next B starts the shape over
BAAAABAAAABAAAA    −3
BAAAAA             −1      one score per arming; a fifth A adds nothing by itself
BAAAAAAAA          −1      and neither does a much longer run of them
BBAAAA             −1      a longer B-run still arms
BAB  /  BAAB        0      the interruption gave up before arming: nothing happened
BAAAABAB           −1      and a near miss leaves a standing count alone
AAAABBB             0      an A-run never arms it, however long it gets
```

Two near misses rather than one is what separates it from the shallower mirrors: **both** `BAB`
and `BAAB` leave a standing count exactly where it was. Only `BAAAB`, a return once it is armed,
resets. Monada 2 is wiped by the first of those and Diada 2 by the second, so on a table that
chops the single-arm mirrors diverge quickly.

All four group-B readings lined up on the same interrupting run, as §4.5 lines up their twins on
group A:

| trailing run after a B | Monada 2 | Diada 2 | Triada 2 | Ena/Duo 2 |
|---|---|---|---|---|
| `BA` | **armed** | building | building | **armed** |
| `BAA` | **−1** | **armed** | building | **armed again** |
| `BAAA` | — | **−1** | **armed** | **−1** |
| `BAAAA` | — | — | **−1** | — |
| `BAB` | **reset to 0** | — (nothing) | — (nothing) | **reset to 0** |
| `BAAB` | — (scored) | **reset to 0** | — (nothing) | **reset to 0** |
| `BAAAB` | — (scored) | — (scored) | **reset to 0** | — (scored) |

Read the bottom three rows across the first three columns: each single-arm mirror is wiped by a
return at exactly its own depth and is indifferent to a return at any other. That is the whole of
what separates them. The fourth column is the one that does not fit the pattern — it is wiped by a
return at *either* of the first two depths, which is what §4.9 is about.

### 4.9 Ena/Duo 2

**Ena/Duo with the two groups exchanged**, and the one mirror that is not a single-arm reading.
It arms **twice**, and only the second arm can score:

```
B            a run of group B, of any length
BA           armed — the first arm. A B now wipes the count.
BAA          armed again — the second arm. Still nothing scored.
BAAA   →     the interrupter carried on                 →  count −1
BAB    →     the original group returned, at the first arm   →  reset to 0
BAAB   →     the original group returned, at the second arm  →  reset to 0
```

Worked further:

```
BAAA               −1
BAAABAAA           −2      the next B starts the shape over
BAAAA              −1      one score per pair of arms
BBAAA              −1      a longer B-run still arms
BAAAABBBBBAAA      −2      the mirror of Ena/Duo's own worked example
BAAABAB             0      a standing count wiped from the first arm
BAAABAAB            0      and from the second
AAABBB              0      an A-run never arms it, however long it gets
```

Its relationship to the other mirrors is exactly Ena/Duo's relationship to Monada and Diada, and
it is worth stating as two facts rather than a feeling:

- **It scores on exactly the spins Diada 2 scores on.** Both need `BAAA`. So its count can
  **never be deeper than Diada 2's** — it can only be wiped more often. This is the one
  domination relationship that does hold anywhere in the mirror family; between the single-arm
  mirrors, none does.
- **It is armed exactly when Monada 2 or Diada 2 is armed**, because those two cover the first
  and second interrupting spin between them. That is why the mutual exclusivity of the three
  single-arm mirrors does not extend to this one.

The shape that separates it from Diada 2 is `BAAABAB`: both score the first `BAAA`, then the
`BAB` wipes this reading and leaves Diada 2 at −1. Being armed early and deciding late, it is
armed more often than any other mirror and keeps its counts least well.

---

## 5. Reference implementation

The state machine, complete. This is the whole of the pattern logic — there is nothing else.

```
# What each pattern needs in order to arm, and which way its decider goes.
# armsFrom = null means either group's run may arm, which is what makes the All in pair
# symmetrical. It is also the only thing separating each group-B reading from its group-A twin:
# the four '...2' rows are the four above them with the other group, nothing else changed.
# armAfter and decideAfter are both lengths of the interrupting run: when it counts as armed,
# and when the interrupter carrying on resolves it. One apart means arm-then-decide; two apart
# is what gives the two Ena/Duo rows their second arm.
RULES = {
  'allIn1':  { minRunToArm: 3, armsFrom: null, armAfter: 1, decideAfter: 2, deepensOnReturn: true  },
  'allIn2':  { minRunToArm: 3, armsFrom: null, armAfter: 1, decideAfter: 2, deepensOnReturn: false },
  'monada':  { minRunToArm: 1, armsFrom: 'A', armAfter: 1, decideAfter: 2, deepensOnReturn: false },
  'diada':   { minRunToArm: 1, armsFrom: 'A', armAfter: 2, decideAfter: 3, deepensOnReturn: false },
  'enaDuo':  { minRunToArm: 1, armsFrom: 'A', armAfter: 1, decideAfter: 3, deepensOnReturn: false },
  'triada':  { minRunToArm: 1, armsFrom: 'A', armAfter: 3, decideAfter: 4, deepensOnReturn: false },
  'monada2': { minRunToArm: 1, armsFrom: 'B', armAfter: 1, decideAfter: 2, deepensOnReturn: false },
  'diada2':  { minRunToArm: 1, armsFrom: 'B', armAfter: 2, decideAfter: 3, deepensOnReturn: false },
  'triada2': { minRunToArm: 1, armsFrom: 'B', armAfter: 3, decideAfter: 4, deepensOnReturn: false },
  'enaDuo2': { minRunToArm: 1, armsFrom: 'B', armAfter: 1, decideAfter: 3, deepensOnReturn: false },
}

state:
  count       = 0
  phase       = BUILDING
  runGroup    = null
  runLength   = 0
  originGroup = null

applySpin(state, n, variant):
  g = groupOf(n)                         # throws if n is not an integer 0..36
  rules = RULES[variant]
  event = NONE

  if phase == INTERRUPTED:
      returned = (g == originGroup)

      if not returned and runLength + 1 < rules.decideAfter:
          # Armed, but the interruption is not yet long enough to be decided. It simply
          # lengthens, and stays armed. Only Ena/Duo ever reaches this.
          runLength = runLength + 1
          event = ARMED

      else:
          deepens = returned if rules.deepensOnReturn else not returned

          if deepens:  count = count - 1 ; event = COUNT
          else:        count = 0         ; event = RESET

          phase       = BUILDING
          runGroup    = g
          runLength   = 1 if returned else 2      # never depends on the variant
          originGroup = null

  else:                                   # BUILDING
      if runGroup is null:
          runGroup = g ; runLength = 1

      else if g == runGroup:
          runLength = runLength + 1
          # An interruption already under way, now long enough to arm. Only a pattern with
          # armAfter > 1 ever reaches this; for the others the interrupting spin arms below.
          if originGroup is not null and runLength >= rules.armAfter:
              phase = INTERRUPTED ; event = ARMED

      else if runLength >= rules.minRunToArm
              and (rules.armsFrom is null or runGroup == rules.armsFrom):
          # A qualifying run has been broken. The interruption starts here; whether that is
          # already enough to arm depends on the pattern.
          originGroup = runGroup
          runGroup = g ; runLength = 1
          if runLength >= rules.armAfter:
              phase = INTERRUPTED ; event = ARMED

      else:
          # Deadzone — and an interruption that gave up before it armed is deadzone too.
          originGroup = null
          runGroup = g ; runLength = 1

  return state, event
```

Ten patterns, one reducer, differing only by that table. Writing them as ten functions is the
mistake to avoid: they share every line that is easy to get wrong. Note especially that the
mirror readings are rows too — reaching for a swap-the-groups wrapper, or a copy of the reducer
with `A` and `B` transposed, buys nothing and gives you a second implementation to keep in step.

Note `originGroup` is set the moment a qualifying run is broken, not only once something is armed.
For patterns whose `armAfter` is 1 those are the same instant; for Diada it is what remembers,
across the half-built interruption, which group the decider has to be measured against.

Four events come out of it, and all four are worth surfacing in any UI:

| event | meaning |
|---|---|
| `ARMED` | a qualifying run was just broken; the next spin decides |
| `COUNT` | the decider went your way; the count is one deeper |
| `RESET` | the decider went the other way; the count is back to 0 |
| `NONE` | an ordinary spin — building, extending, or chopping in the deadzone |

Two figures are worth deriving as you go, because they cannot be recovered afterwards: the
**deepest count reached**, and **how many resets** there have been.

Implementation notes that matter more than they look:

- **Feed spins one at a time, oldest first.** Most scrapers hand you a window *newest first*.
  Reverse it before replaying, or every count you produce will be nonsense.
- **Keep the function pure.** Given a state and a number it returns a new state; it does no I/O,
  no fetching, no logging. That is what lets you replay a stored history through it, test it
  offline, and run it in a worker. Every pattern is the same function with a different variant,
  so there is one implementation to get right rather than seven that drift.
- **Never reimplement it a second time** for a backtest, a simulator or a preview panel, and do
  not write a separate function per pattern. Call the same function with a different variant. Two
  copies of this logic disagreeing is the likeliest way to end up showing a count that isn't real.
  Adding this app's fourth and fifth patterns was a row of that table and a branch of the reducer
  each — Ena/Duo needed no new rule, only a second length on the one it already had — and the
  sixth and all four mirrors were one row each and nothing else. The mirrors in particular are a
  one-field change from the patterns they mirror, and if any of them needs more than that in your
  implementation, the reducer is not as group-agnostic as it looks.

---

## 6. Worked traces

Read these top to bottom; they are what the state machine actually does.

### All in 1 — the base case, `3 6 7 18 0`

| spin | group | event | count | phase | run | origin |
|---|---|---|---|---|---|---|
| 3 | A | — | 0 | BUILDING | A×1 | — |
| 6 | A | — | 0 | BUILDING | A×2 | — |
| 7 | A | — | 0 | BUILDING | A×3 | — |
| 18 | B | ARMED | 0 | INTERRUPTED | B×1 | A |
| 0 | A | COUNT | **−1** | BUILDING | A×1 | — |

Note the last row: `0` is a group-A number, so it is the return that scores.

### All in 1 — chop does not reset, `3 6 7 18 0 4 1 4 1 3 6 7 18 0`

| spin | group | event | count | run |
|---|---|---|---|---|
| 3 6 7 | A A A | — | 0 | A×3 |
| 18 | B | ARMED | 0 | B×1 |
| 0 | A | COUNT | −1 | A×1 |
| 4 | B | — | −1 | B×1 |
| 1 | A | — | −1 | A×1 |
| 4 | B | — | −1 | B×1 |
| 1 | A | — | −1 | A×1 |
| 3 6 7 | A A A | — | −1 | A×4 |
| 18 | B | ARMED | −1 | B×1 |
| 0 | A | COUNT | **−2** | A×1 |

The four alternating spins in the middle are the deadzone. No run ever reached 3, so nothing
armed, and the −1 was never in danger.

### All in 2 — the carry, `AAABBBAA`

| spin | group | event | count | run |
|---|---|---|---|---|
| A A A | A | — | 0 | A×3 |
| B | B | ARMED | 0 | B×1 |
| B | B | **COUNT** | −1 | **B×2** ← the scoring spin carries |
| B | B | — | −1 | B×3 |
| A | A | ARMED | −1 | A×1 |
| A | A | **COUNT** | **−2** | A×2 |

Without the carry on row 3, `BBB` would not have qualified in time and this would end at −1.

### Monada — one A is enough, `A B B A B B`

| spin | group | event | count | phase | run | origin |
|---|---|---|---|---|---|---|
| A | A | — | 0 | BUILDING | A×1 | — |
| B | B | ARMED | 0 | INTERRUPTED | B×1 | A |
| B | B | **COUNT** | −1 | BUILDING | B×2 | — |
| A | A | — | −1 | BUILDING | A×1 | — |
| B | B | ARMED | −1 | INTERRUPTED | B×1 | A |
| B | B | **COUNT** | **−2** | BUILDING | B×2 | — |

Row 4 is the part to notice: the A does not arm anything by arriving, and it does not reset
anything either — the count was resolved two rows earlier. It simply starts the next A-run, which
the following B arms.

### Diada — arming takes two, `A B B A B B B`

| spin | group | event | count | phase | run | origin |
|---|---|---|---|---|---|---|
| A | A | — | 0 | BUILDING | A×1 | — |
| B | B | — | 0 | BUILDING | B×1 | **A** ← the interruption has begun |
| B | B | ARMED | 0 | INTERRUPTED | B×2 | A |
| A | A | RESET | 0 | BUILDING | A×1 | — |
| B | B | — | 0 | BUILDING | B×1 | A |
| B | B | ARMED | 0 | INTERRUPTED | B×2 | A |
| B | B | **COUNT** | **−1** | BUILDING | B×2 | — |

Row 2 is where this pattern differs from every other: the origin group is already remembered while
the phase is still `BUILDING`, because the interruption is under way but not yet long enough to
arm. Row 4 wipes a count of zero, which is why the app files it as a reset at depth 0.

### Ena/Duo — two arms, `A B B B B A A A A A B B B`

The example in full. Only the events that matter are shown; the long A-run in the middle is a run
and nothing more.

| spin | group | event | count | phase | run | origin |
|---|---|---|---|---|---|---|
| A | A | — | 0 | BUILDING | A×1 | — |
| B | B | **ARMED** | 0 | INTERRUPTED | B×1 | A |
| B | B | **ARMED** | 0 | INTERRUPTED | B×2 | A ← armed again, not scored |
| B | B | **COUNT** | **−1** | BUILDING | B×2 | — |
| B | B | — | −1 | BUILDING | B×3 | — |
| A A A A A | A | — | −1 | BUILDING | A×5 | — |
| B | B | ARMED | −1 | INTERRUPTED | B×1 | A |
| B | B | ARMED | −1 | INTERRUPTED | B×2 | A |
| B | B | **COUNT** | **−2** | BUILDING | B×2 | — |

Row 3 is the whole of Ena/Duo: a second B where any other one-way pattern would either have
scored already (Monada) or only now be arming (Diada). Row 5 shows the fourth B doing
nothing — the block was resolved on the spin before, and a B-run cannot arm anything.

### Triada — arming takes three, `A B B B B B B B A B B B B B`

The example in full, condensed where nothing happens.

| spin | group | event | count | phase | run | origin |
|---|---|---|---|---|---|---|
| A | A | — | 0 | BUILDING | A×1 | — |
| B | B | — | 0 | BUILDING | B×1 | A |
| B | B | — | 0 | BUILDING | B×2 | A |
| B | B | **ARMED** | 0 | INTERRUPTED | B×3 | A |
| B | B | **COUNT** | **−1** | BUILDING | B×2 | — |
| B B B | B | — | −1 | BUILDING | B×5 | — |
| A | A | — | −1 | BUILDING | A×1 | — |
| B B | B | — | −1 | BUILDING | B×2 | A |
| B | B | **ARMED** | −1 | INTERRUPTED | B×3 | A |
| B | B | **COUNT** | **−2** | BUILDING | B×2 | — |
| B | B | — | −2 | BUILDING | B×3 | — |

The three Bs after the first count do nothing at all: the block was resolved on the spin before,
and a B-run cannot arm anything. The pattern is waiting for the next A, which arrives and starts
the second block.

### Monada 2 — the mirror, `B A A B A A`

The same trace as Monada's above with every letter swapped, which is the point of it.

| spin | group | event | count | phase | run | origin |
|---|---|---|---|---|---|---|
| B | B | — | 0 | BUILDING | B×1 | — |
| A | A | ARMED | 0 | INTERRUPTED | A×1 | B |
| A | A | **COUNT** | −1 | BUILDING | A×2 | — |
| B | B | — | −1 | BUILDING | B×1 | — |
| A | A | ARMED | −1 | INTERRUPTED | A×1 | B |
| A | A | **COUNT** | **−2** | BUILDING | A×2 | — |

Worth running the same six spins through Monada side by side: it ends at **0**, having armed
nothing and counted nothing, because no A-run was ever broken by a B. Two readings, the same six
spins, −2 and 0.

### Diada 2 — arming takes two, `B A A A A A B A A A B`

Eleven spins, two blocks, and three spins that look like they should do something and do not.

| spin | group | event | count | phase | run | origin |
|---|---|---|---|---|---|---|
| B | B | — | 0 | BUILDING | B×1 | — |
| A | A | — | 0 | BUILDING | A×1 | **B** ← the interruption has begun |
| A | A | **ARMED** | 0 | INTERRUPTED | A×2 | B |
| A | A | **COUNT** | **−1** | BUILDING | A×2 | — |
| A A | A | — | −1 | BUILDING | A×4 | — |
| B | B | — | −1 | BUILDING | B×1 | — ← deadzone, not a reset |
| A | A | — | −1 | BUILDING | A×1 | B |
| A | A | **ARMED** | −1 | INTERRUPTED | A×2 | B |
| A | A | **COUNT** | **−2** | BUILDING | A×2 | — |
| B | B | — | **−2** | BUILDING | B×1 | — ← deadzone again |

Three rows worth pausing on. Row 2 is where this reading differs from Monada 2: the origin group
is already remembered while the phase is still `BUILDING`, because the interruption is under way
but not yet long enough to arm. Row 5 — the extra As after the count — does nothing at all: the
block was resolved on the spin before, and an A-run cannot arm this reading. And rows 6 and 10,
the two lone Bs, are deadzone rather than resets: by the time each arrives there is no armed block
left to wipe, so the count stands. The final count is **−2**.

### Triada 2 — arming takes three, `B A A A A B A A A A`

Two blocks, and the reading at its plainest: nothing happens at all until the third A of each
interruption.

| spin | group | event | count | phase | run | origin |
|---|---|---|---|---|---|---|
| B | B | — | 0 | BUILDING | B×1 | — |
| A | A | — | 0 | BUILDING | A×1 | **B** ← the interruption has begun |
| A | A | — | 0 | BUILDING | A×2 | B ← still nothing armed |
| A | A | **ARMED** | 0 | INTERRUPTED | A×3 | B |
| A | A | **COUNT** | **−1** | BUILDING | A×2 | — |
| B | B | — | −1 | BUILDING | B×1 | — |
| A | A | — | −1 | BUILDING | A×1 | B |
| A | A | — | −1 | BUILDING | A×2 | B |
| A | A | **ARMED** | −1 | INTERRUPTED | A×3 | B |
| A | A | **COUNT** | **−2** | BUILDING | A×2 | — |

Rows 2 and 3 are the part that trips people up: the origin group is already remembered while the
phase is still `BUILDING`, for two spins rather than Diada 2's one. Substitute a `B` for row 3's A
and this reading records **nothing** where Monada 2 records a reset; substitute one for row 4's A
and again nothing, where Diada 2 records a reset. Only a `B` in place of row 5's A wipes this
count.

### Ena/Duo 2 — two arms, `B A A A A B B B B B A A A`

The mirror of Ena/Duo's own worked example. Only the events that matter are shown; the long
B-run in the middle is a run and nothing more.

| spin | group | event | count | phase | run | origin |
|---|---|---|---|---|---|---|
| B | B | — | 0 | BUILDING | B×1 | — |
| A | A | **ARMED** | 0 | INTERRUPTED | A×1 | B |
| A | A | **ARMED** | 0 | INTERRUPTED | A×2 | B ← armed again, not scored |
| A | A | **COUNT** | **−1** | BUILDING | A×2 | — |
| A | A | — | −1 | BUILDING | A×3 | — |
| B B B B B | B | — | −1 | BUILDING | B×5 | — |
| A | A | ARMED | −1 | INTERRUPTED | A×1 | B |
| A | A | ARMED | −1 | INTERRUPTED | A×2 | B |
| A | A | **COUNT** | **−2** | BUILDING | A×2 | — |

Row 3 is the whole of this reading: a second A where Monada 2 would have scored already and
Diada 2 would only now be arming. Row 5 shows the fourth A doing nothing — the block was resolved
on the spin before, and an A-run cannot arm it.

---

## 7. Test vectors — the contract

Implement against these. They are the vectors this app's own test suite runs, and they are what
"correct" means here. Each is a complete sequence fed to a fresh state; the expected value is the
final count.

### All in 1

| # | sequence | final count | what it pins down |
|---|---|---|---|
| 1 | `3 6 7 18 0` | −1 | base case; the count fires on the return spin |
| 2 | `3 6 7 18 0 3 6 18 0` | −2 | the return spin seeds the next run |
| 3 | `0 0 0 4 0 4 4 4 0 4` | −2 | blocks may run in either direction (and fire **no** resets) |
| 4 | `3 6 7 18 0 1 2 3 18 4` | 0 | two consecutive opposites after a qualifying run wipe it |
| 5 | `3 6 7 18 0 4 1 4 1 3 6 7 18 0` | −2 | chop after a return is deadzone, not a reset |
| 6 | `1 2 4 5 5 4` | 0 | a run of 2 never arms, so no reset can fire |
| 7 | `3 6 7 8 10 18 0` | −1 | runs longer than 3 still qualify, and only once |
| 8 | `3 6 18 0 3 6 18 0` | −1 | the pivot seeds a fresh run that completes to 3 |

Vector 4 should fire exactly one `COUNT` and then exactly one `RESET`, in that order. Vector 3
should fire no `RESET` at all — a useful check, because an implementation that resets on any
interruption still passes several of the others.

### All in 2

Written as letters, because each is about the shape rather than the pockets. Substitute any
group-A number for `A` and any group-B number for `B`.

| shape | All in 2 | All in 1 | what it pins down |
|---|---|---|---|
| `AAABB` | **−1** | 0 | the interrupter repeating is what scores now |
| `AAABA` | **0** | −1 | the origin group returning is what wipes it |
| `AABB` | 0 | 0 | a run of 2 never arms, in either pattern |
| `AAAAAABB` | −1 | 0 | a longer run still arms on the first spin of the other group |
| `AAABBBAA` | −2 | — | the scoring spin carries into the next run |
| `AAABBBAAABB` | −3 | — | it keeps chaining |
| `AAABBBAAABA` | 0 | — | and a reset returns to zero from any depth |

After `AAABB`, All in 2's state must read run group **B**, run length **2**, count −1. After
`AAABA`, run group **A**, run length **1**, count 0. If those differ, your carry is wrong even
where the counts happen to match.

### Monada

| shape | Monada | All in 1 / 2 | what it pins down |
|---|---|---|---|
| `ABB` | **−1** | 0 / 0 | one A is enough to arm; the repeat scores |
| `ABA` | **0** | 0 / 0 | the A coming back is what wipes it |
| `ABBABB` | −2 | — | the next A starts the shape over |
| `ABBABBABB` | −3 | — | it keeps chaining |
| `ABBABBABA` | 0 | — | a reset returns to zero from any depth |
| `AABB` | −1 | — | a longer A-run still arms |
| `AAAAAABB` | −1 | 0 / −1 | and a much longer one arms exactly once |
| `ABBB` | −1 | — | one score per arming; the third B adds nothing alone |
| `ABABB` | −1 | — | it rearms from the very A that reset it |
| `BBB` / `BBBB` | 0 | — | no A yet, so nothing to arm |
| `BBABB` | −1 | — | it picks the shape up mid-stream |
| `BBBAA` | **0** | 0 / **−1** | a B-run never arms it — this is the one-way part |
| `BAA` | 0 | — | the mirror image of the scoring shape scores nothing |

After `ABB`, Monada's state must read run group **B**, run length **2**, count −1; after `ABA`,
run group **A**, run length **1**, count 0 — the same carry as the other two. Its event sequence
for `ABB` is exactly `NONE, ARMED, COUNT`, and for `ABA` exactly `NONE, ARMED, RESET`.

### Diada

| shape | Diada | Monada | what it pins down |
|---|---|---|---|
| `ABBB` | **−1** | −1 | the third B is the decider, and it carried on |
| `ABBA` | **0** | −1 | the A after two Bs is what wipes it |
| `ABB` | 0, **armed** | −1 | the second B arms; nothing has been decided yet |
| `AB` | 0, not armed | armed | one interrupting spin is not enough |
| `ABA` | **0, nothing happened** | 0 (a reset) | an interruption that stops at one B decides nothing |
| `ABBBABA` | −1 | — | and a near miss leaves a standing count alone |
| `ABABBB` | −1 | — | the interruption can be rebuilt after a near miss |
| `AABBB` / `AAABBB` | −1 | — | a longer A-run still arms |
| `ABBBB` / `ABBBBB` | −1 | — | one score per arming |
| `ABBABBB` | −1 | — | it rearms from the very A that reset it |
| `ABBBABBB` | −2 | — | it keeps chaining |
| `ABBBABBBABBA` | 0 | — | a reset returns to zero from any depth |
| `BBBABBB` | −1 | — | it picks the shape up mid-stream |
| `BBBAAA` / `BAAA` | **0** | 0 | a B-run never arms it — the one-way part |
| `ABBABB` | **0** | −2 | the clearest case of the two diverging |

Its event sequences are exactly `NONE, NONE, ARMED, COUNT` for `ABBB` and `NONE, NONE, ARMED,
RESET` for `ABBA`; `ABA` fires **no event at all**. After `ABBB` the state reads run group **B**,
run length **2**; after `ABBA`, run group **A**, run length **1** — the same carry as everywhere
else.

### Ena/Duo

| shape | Ena/Duo | Diada | Monada | what it pins down |
|---|---|---|---|---|
| `ABA` | **0, a reset** | 0, nothing | 0, a reset | the first arm can wipe the count |
| `ABB` | **0, armed** | armed | −1 | the second B arms rather than scoring |
| `ABBB` | **−1** | −1 | −1 | only the second arm can deepen it |
| `ABBA` | 0 | 0 | −1 | a return at the second arm wipes it too |
| `AB` | armed | not armed | armed | it is armed from the first interrupting spin |
| `ABBBB` / `ABBBBB` | −1 | −1 | — | one score per pair of arms |
| `ABBBBAAAAABBB` | **−2** | −2 | — | the example, in full |
| `ABBBABA` | **0** | **−1** | — | the shape that separates it from Diada |
| `ABABBB` / `ABBABBB` | −1 | −1 | — | it rearms from the very A that reset it |
| `AABBB` / `AAABBB` | −1 | −1 | — | a longer A-run still arms |
| `ABBBABBB` | −2 | −2 | — | it keeps chaining |
| `ABBBABBBABBA` | 0 | 0 | — | a reset returns to zero from any depth |
| `ABBBABBBABA` | 0 | −2 | — | and so does one at the first arm |
| `BBBABBB` | −1 | −1 | — | it picks the shape up mid-stream |
| `BBBAAA` / `BAAA` | 0 | 0 | 0 | a B-run never arms it |
| `ABBABB` | **0** | 0 | −2 | armed twice over, having scored nothing |

Its event sequences are `NONE, ARMED, ARMED, COUNT` for `ABBB`, `NONE, ARMED, ARMED, RESET` for
`ABBA`, and `NONE, ARMED, RESET` for `ABA`. Two useful cross-checks that need no vectors at all:
Ena/Duo scores on exactly the spins Diada does, so **its count can never be deeper than
Diada's**; and it is armed exactly when Monada or Diada is armed, since those two cover
the first and second interrupting spin between them.

### Triada

| shape | Triada | Diada | what it pins down |
|---|---|---|---|
| `ABBBB` | **−1** | −1 | the fourth B is the decider, and it carried on |
| `ABBBA` | **0** | −1 | the A after three Bs is what wipes it |
| `ABBB` | 0, **armed** | −1 | the third B arms; nothing is decided yet |
| `AB` / `ABB` | 0, not armed | armed at `ABB` | two interrupting spins are not enough |
| `ABA` / `ABBA` | **0, nothing happened** | 0 | an interruption that gives up decides nothing |
| `ABBBBABA` / `ABBBBABBA` | −1 | — | and a near miss leaves a standing count alone |
| `ABBABBBB` | −1 | — | the interruption can be rebuilt after a near miss |
| `AABBBB` / `AAABBBB` | −1 | — | a longer A-run still arms |
| `ABBBBB` / `ABBBBBBBB` | −1 | — | one score per arming |
| `ABBBABBBB` | −1 | — | it rearms from the very A that reset it |
| `ABBBBABBBB` | −2 | — | it keeps chaining |
| `ABBBBBBBABBBBB` | **−2** | — | the example, in full |
| `ABBBBABBBBABBBA` | 0 | — | a reset returns to zero from any depth |
| `BBBBABBBB` | −1 | — | it picks the shape up mid-stream |
| `BBBBAAA` / `BAAAA` | **0** | 0 | a B-run never arms it |

Its event sequences are exactly `NONE, NONE, NONE, ARMED, COUNT` for `ABBBB` and `NONE, NONE,
NONE, ARMED, RESET` for `ABBBA`; `ABBA` fires no event at all. The four group-A one-way patterns
arm at four different interruption lengths — 1, 2, 1–2 and 3 — so Triada can never be armed at
the same moment as any of them. The group-B readings are outside that argument entirely: they are
measured on a B-run, so any of them can be armed alongside any group-A reading. Among themselves,
the three single-arm ones are mutually exclusive; Ena/Duo 2 is not, being armed whenever Monada 2
or Diada 2 is.

### Monada 2

Every shape here is Monada's §7 table with the letters swapped, and the `Monada` column is
the same shape read by Monada — which is the real contract, since the two readings must be
exact opposites and not merely both one-way.

| shape | Monada 2 | Monada | what it pins down |
|---|---|---|---|
| `BAA` | **−1** | 0 | one B is enough to arm; the repeat scores |
| `BAB` | **0** | 0 | the B coming back is what wipes it |
| `BAABAA` | −2 | 0 | the next B starts the shape over |
| `BAABAABAA` | −3 | 0 | it keeps chaining |
| `BAABAABAB` | 0 | 0 | a reset returns to zero from any depth |
| `BBAA` | −1 | 0 | a longer B-run still arms |
| `BBBBBBAA` | −1 | 0 | and a much longer one arms exactly once |
| `BAAA` | −1 | 0 | one score per arming; the third A adds nothing alone |
| `BABAA` | −1 | 0 | it rearms from the very B that reset it |
| `AAA` / `AAAA` | 0 | 0 | no B yet, so nothing to arm |
| `AABAA` | −1 | 0 | it picks the shape up mid-stream |
| `AAABB` | **0** | **−1** | an A-run never arms it — this is the one-way part |
| `ABB` | **0** | **−1** | Monada's scoring shape scores nothing here |
| `BA` | **armed** | not armed | and it arms where Monada cannot |

After `BAA`, Monada 2's state must read run group **A**, run length **2**, count −1; after `BAB`,
run group **B**, run length **1**, count 0 — the same carry as every other reading. Its event
sequence for `BAA` is exactly `NONE, ARMED, COUNT`, and for `BAB` exactly `NONE, ARMED, RESET`.

The cross-check worth more than any single row: for **every** shape, Monada 2's count must equal
Monada's count on the same shape with `A` and `B` exchanged. A loop over a few thousand random
sequences asserting that is the whole specification of this reading, and it catches a hardcoded
group anywhere in the reducer that the shapes above would let through.

### Diada 2

Diada's §7 table with the letters swapped. The comparison column here is **Monada 2** rather
than Diada, because that is the pair that actually gets confused on a live table — Diada's
column would read 0 for every row but the last two, which pins down nothing.

| shape | Diada 2 | Monada 2 | what it pins down |
|---|---|---|---|
| `BAAA` | **−1** | −1 | the third A is the decider, and it carried on |
| `BAAB` | **0** | −1 | the B after two As is what wipes it |
| `BAA` | 0, **armed** | −1 | the second A arms; nothing has been decided yet |
| `BA` | 0, not armed | armed | one interrupting spin is not enough |
| `BAB` | **0, nothing happened** | 0 (a reset) | an interruption that stops at one A decides nothing |
| `BAAABAB` | −1 | 0 | and a near miss leaves a standing count alone |
| `BABAAA` | −1 | −1 | the interruption can be rebuilt after a near miss |
| `BBAAA` / `BBBAAA` | −1 | −1 | a longer B-run still arms |
| `BAAAA` / `BAAAAA` | −1 | −1 | one score per arming |
| `BAABAAA` | −1 | **−2** | it rearms from the very B that reset it |
| `BAAABAAA` | −2 | −2 | it keeps chaining |
| `BAAABAAABAAB` | 0 | −3 | a reset returns to zero from any depth |
| `AAABAAA` | −1 | −1 | it picks the shape up mid-stream |
| `AAABBB` / `ABBB` | **0** | 0 | an A-run never arms it — the one-way part |
| `BAABAA` | **0** | **−2** | the clearest case of it and Monada 2 diverging |
| `BAAAAABAAAB` | **−2** | −2 | the worked example from §6, in full |

Its event sequences are exactly `NONE, NONE, ARMED, COUNT` for `BAAA` and `NONE, NONE, ARMED,
RESET` for `BAAB`; `BAB` fires **no event at all**. After `BAAA` the state reads run group **A**,
run length **2**; after `BAAB`, run group **B**, run length **1** — the same carry as everywhere
else.

Two cross-checks beyond the rows. The swap invariant, as for Monada 2: over a few thousand random
sequences, Diada 2's count must equal Diada's on the group-swapped sequence. And the one that
catches a wrong assumption rather than a wrong rule — over the same sequences, **neither Diada 2
nor Monada 2 may dominate the other**. Both orderings must actually occur. An implementation in
which Monada 2 is always at least as deep has very likely given Diada 2 Monada 2's `armAfter`,
which the shapes above would not all catch.

### Triada 2

Triada's §7 table with the letters swapped. The comparison column is **Diada 2**, the mirror
one rung shallower, for the same reason Diada 2's was Monada 2: Triada's column would read 0
for all but the last two rows.

| shape | Triada 2 | Diada 2 | what it pins down |
|---|---|---|---|
| `BAAAA` | **−1** | −1 | the fourth A is the decider, and it carried on |
| `BAAAB` | **0** | −1 | the B after three As is what wipes it |
| `BAAA` | 0, **armed** | −1 | the third A arms; nothing is decided yet |
| `BA` / `BAA` | 0, not armed | armed at `BAA` | two interrupting spins are not enough |
| `BAB` / `BAAB` | **0, nothing happened** | 0 / **a reset** | an interruption that gives up decides nothing |
| `BAAAABAB` / `BAAAABAAB` | −1 | −1 / 0 | and a near miss leaves a standing count alone |
| `BAABAAAA` | −1 | −1 | the interruption can be rebuilt after a near miss |
| `BBAAAA` / `BBBAAAA` | −1 | −1 | a longer B-run still arms |
| `BAAAAA` / `BAAAAAAAA` | −1 | −1 | one score per arming |
| `BAAABAAAA` | −1 | **−2** | it rearms from the very B that reset it |
| `BAAAABAAAA` | −2 | −2 | it keeps chaining |
| `BAAAABAAAABAAAA` | **−3** | −3 | and keeps chaining again |
| `BAAAABAAAABAAAB` | 0 | −3 | a reset returns to zero from any depth |
| `BAAAAAAABAAAAA` | **−2** | −2 | two blocks; the extra As in each add nothing |
| `AAAABAAAA` | −1 | −1 | it picks the shape up mid-stream |
| `AAAABBB` / `ABBBB` | **0** | 0 | an A-run never arms it — the one-way part |
| `BAABAA` | **0** | 0, **armed** | it is not even armed where Diada 2 is |

Its event sequences are exactly `NONE, NONE, NONE, ARMED, COUNT` for `BAAAA` and `NONE, NONE,
NONE, ARMED, RESET` for `BAAAB`; `BAB` and `BAAB` fire **no event at all**. After `BAAAA` the
state reads run group **A**, run length **2**; after `BAAAB`, run group **B**, run length **1**.

The row to dwell on is `BAAAABAB` against `BAAAABAAB`: Triada 2 is −1 for both, Diada 2 is −1 for
the first and 0 for the second. Two near misses that this reading ignores and the shallower one
does not is the whole of the difference between them.

Beyond the rows, the same two cross-checks as the other mirrors — the swap invariant against
Triada, and no domination in either direction against Monada 2 *or* Diada 2 — plus one the
three single-arm mirrors share: **at most one of them may be armed at any moment**, since each
wants the trailing run after a B to be a different length. Ena/Duo 2 is exempt from that last
check; see §4.9.

### Ena/Duo 2

Ena/Duo's §7 table with the letters swapped. Two comparison columns, because this reading is
defined by its relationship to both of the shallower mirrors.

| shape | Ena/Duo 2 | Diada 2 | Monada 2 | what it pins down |
|---|---|---|---|---|
| `BAB` | **0, a reset** | 0, nothing | 0, a reset | the first arm can wipe the count |
| `BAA` | **0, armed** | armed | −1 | the second A arms rather than scoring |
| `BAAA` | **−1** | −1 | −1 | only the second arm can deepen it |
| `BAAB` | **0, a reset** | 0, a reset | −1 | a return at the second arm wipes it too |
| `BA` | **armed** | not armed | armed | it is armed from the first interrupting spin |
| `BAAAA` / `BAAAAA` | −1 | −1 | −1 | one score per pair of arms |
| `BAAAABBBBBAAA` | **−2** | −2 | −2 | the worked example from §6, in full |
| `BAAABAB` | **0** | **−1** | 0 | the shape that separates it from Diada 2 |
| `BAAABAAB` | **0** | **0** | −2 | and a return at the second arm does the same |
| `BABAAA` / `BAABAAA` | −1 | −1 | — | it rearms from the very B that reset it |
| `BBAAA` / `BBBAAA` | −1 | −1 | — | a longer B-run still arms |
| `BAAABAAA` | −2 | −2 | −2 | it keeps chaining |
| `BAAABAAABAAB` | 0 | 0 | −3 | a reset returns to zero from any depth |
| `BAAABAAABAB` | **0** | **−2** | 0 | and so does one at the first arm |
| `AAABAAA` | −1 | −1 | −1 | it picks the shape up mid-stream |
| `AAABBB` / `ABBB` | **0** | 0 | 0 | an A-run never arms it |
| `BAABAA` | **0, armed** | 0, armed | **−2** | armed twice over, having scored nothing |

Its event sequences are `NONE, ARMED, ARMED, COUNT` for `BAAA`, `NONE, ARMED, ARMED, RESET` for
`BAAB`, and `NONE, ARMED, RESET` for `BAB`.

Two cross-checks that need no vectors at all, and they are the mirror of Ena/Duo's own:

- **It scores on exactly the spins Diada 2 scores on**, so its count can never be deeper than
  Diada 2's. Over a long stream, assert that at every spin.
- **It is armed exactly when Monada 2 or Diada 2 is armed**, since those two cover the first and
  second interrupting spin between them.

The second of those is also the reason the single-arm mirrors' mutual exclusivity stops here: do
not assert that no two mirrors are ever armed together, because this one is armed alongside
Monada 2 or Diada 2 nearly half the time. It is never armed alongside Triada 2.

---

## 8. Feeding it from your own scraper

This is where implementations actually go wrong. The pattern logic above is twenty lines and, once
it passes §7, it is done. Getting the right spins into it, in the right order, exactly once, is
the hard part.

### 8.1 One spin, exactly once

Sources normally expose a rolling window of the last *N* results, newest first, with no notion of
what you have already seen. Between two reads you must work out which entries are new:

1. **If the source gives each round a stable id, use the ids.** Find the newest known id in the
   fetched list; everything above it is new. This is the only reliable method.
2. **Otherwise, match by value overlap.** Find the offset at which the fetched window lines up
   with what you already know, and take the entries above it. Guard it: a short window, or one
   containing repeated numbers, can align at more than one offset.

### 8.2 When you cannot tell, do not guess

If the new window shares nothing with what you knew, or aligns ambiguously, you have no way to
know how many spins you missed. **Discard the count and flag the table as desynced.** Do not
assume the window is all new, and do not assume nothing changed.

This is the most important rule in this document. A missed spin does not produce a slightly wrong
count — it produces a *plausible* count that is silently wrong from then on, and nothing
downstream can detect it. Losing a count costs you a count. Reporting a false one costs you trust
in every count.

### 8.3 Starting up

If the source shows a window of recent results, you can replay it oldest-first through the state
machine to start from a true count rather than from zero. Two conditions:

- **Nothing you replay may notify anybody.** These spins already happened, possibly hours ago. If
  you alert on deep counts, a replay that lands past your threshold must start already latched, so
  the alert fires on the next *live* spin that deepens it rather than on history.
- **Do not count replayed spins as observed.** If you keep statistics — resets by depth, spins
  seen, deepest reached — seeded spins restore the count but should not inflate the figures. They
  were watched by somebody else, or by nobody.

### 8.4 Cadence and staleness

Poll no faster than the table produces spins; a live wheel is one spin per 30–90 seconds, and
polling every few seconds only multiplies your chance of reading a half-updated page. Conversely,
watch for a window that has not changed in far longer than a spin cycle — that is a dead feed, and
it looks exactly like a quiet table unless you check.

### 8.5 If you track more than one pattern

Advance every count **from the same loop, over the same spins, in the same order**. If a second
pattern is computed from a separately fetched history, the two will eventually disagree about the
same table for reasons that have nothing to do with the patterns.

Their statistics cannot be shared either: the spin that deepens one is the spin that resets
another, so "resets at depth 3" recorded for one pattern says nothing about the others. Spins
observed, and the period covered, are the only figures they have in common.

Only one pattern should raise alerts, and you should decide which. Here it is All in 1; the
others are shown and counted but never notify, because ten patterns alerting on the same table
at different moments is noise rather than information.

---

## 9. Things that look like edge cases and are not

| case | what happens | why |
|---|---|---|
| `0` is spun | ordinary group-A spin | zero is not neutral here |
| run of 2 broken | nothing; new run of 1 | only runs of 3+ arm |
| long chop, A B A B A B | nothing at all | the deadzone; a count is untouched by it |
| run of 6 then interrupted | arms exactly once | length beyond 3 buys nothing |
| two interruptions in a row | impossible | the spin after arming always resolves it |
| count deepens twice on one spin | impossible | one decider per arming, one step per decider |
| a reset from −7 | count goes to 0 | resets are absolute, never partial |
| a long B-run under Monada and Diada | nothing, ever | they arm from group-A runs only |
| a long A-run under any mirror | nothing, ever | they arm from group-B runs only |
| a single A under the All in pair | nothing | they need a run of three |
| `ABA` under Diada | nothing at all | the interruption stopped short; not a count, not a reset |
| `ABA` under Ena/Duo | a reset | it was armed from the first B, so the return wipes it |
| Monada and Diada armed together | impossible | one wants `AB`, the other `ABB` |
| Ena/Duo deeper than Diada | impossible | they score together; 5 only loses more often |
| Ena/Duo armed, 3 and 4 both not | impossible | 5 is armed across both their windows |
| Triada armed with any other | impossible | it arms at an interruption length no other uses |
| `ABBBB` under Monada, Diada and Triada | −1 for all three | a long enough interruption satisfies them all |
| a mirror and its twin scoring on one spin | impossible | their deciders are mutually exclusive shapes |
| a mirror armed alongside Triada | ordinary | they measure different groups' runs; nothing links them |
| Monada 2 deeper than Monada | ordinary | the two counts are independent, not a hedge |
| `BAA` under everything but Monada 2 | nothing, or armed | 1 and 2 need a run of three, 3–6 want an A-run, Diada 2 is merely armed |
| `BAB` under Diada 2 or Triada 2 | nothing at all | the interruption stopped short; not a count, not a reset |
| `BAB` under Monada 2 | a reset | it was armed from the first A, so the return wipes it |
| `BAAB` under Triada 2 | nothing at all | it needs three As before a return means anything |
| `BAAB` under Diada 2 or Ena/Duo 2 | a reset | both are armed by the second A, so the return wipes them |
| `BAB` under Ena/Duo 2 | a reset | it was armed from the first A, so the return wipes it |
| two single-arm mirrors armed together | impossible | each wants a different trailing-run length after a B |
| Ena/Duo 2 armed with Monada 2 or Diada 2 | **ordinary** | it is armed across both their depths — the exception |
| Ena/Duo 2 armed with Triada 2 | impossible | its arms are at one and two As, Triada 2's at three |
| Ena/Duo 2 deeper than Diada 2 | impossible | they score together; Ena/Duo 2 only loses more often |
| Diada 2 deeper than Monada 2 | ordinary | neither dominates; they do not score on the same spins |
| Triada 2 deeper than either | ordinary | same reason — it ignores the near misses that wipe them |

---

## 10. Checking your implementation

1. All eight All in 1 vectors in §7, plus the event-order assertions.
2. All seven All in 2 shapes, plus the run group and run length after `AAABB` and `AAABA`.
3. All thirteen Monada shapes, plus its two event sequences. `BBBAA` scoring −1 instead of 0 is
   the classic sign that the one-way rule has been dropped.
4. All fifteen Diada shapes. `ABA` is the one to watch: it must fire no event and leave a
   standing count alone. Recording it as a reset is the easiest mistake to make here, and it
   quietly destroys counts that should have survived.
5. All sixteen Ena/Duo shapes, and in particular `ABB`, which must arm rather than score, and
   `ABBBABA`, which must be 0 where Diada is −1.
6. All fifteen Triada shapes, and in particular `ABBB`, which must arm rather than score.
7. All fourteen Monada 2 shapes, and above all the swap invariant: for a few thousand random
   sequences, Monada 2's count must equal Monada's count on the same sequence with the two
   groups exchanged. `ABB` scoring −1 under Monada 2 is the sign that `armsFrom` is being
   ignored; `BAA` scoring 0 is the sign it was never applied.
8. All sixteen Diada 2 shapes, its own swap invariant against Diada, and `BAB`, which must
   fire no event and leave a standing count alone. Check too that neither it nor Monada 2
   dominates the other over a long stream — if Monada 2 is always at least as deep, Diada 2 has
   been given Monada 2's arming depth.
9. All seventeen Triada 2 shapes, its swap invariant against Triada, and **both** near misses:
   `BAB` and `BAAB` must each fire no event at all. `BAAB` recorded as a reset is the sign it has
   been given Diada 2's arming depth, and it is the one error the shallower shapes all survive.
10. All seventeen Ena/Duo 2 shapes, and in particular `BAA`, which must arm rather than score,
    and `BAAABAB`, which must be 0 where Diada 2 is −1. Its two no-vector checks matter more than
    any row: it must score on exactly the spins Diada 2 scores on, and be armed exactly when
    Monada 2 or Diada 2 is armed.
11. Every integer 0–36 is classified; A totals 18 and B totals 19.
12. Inputs outside 0–36, and non-integers, are rejected rather than classified.
13. A fresh state reports count 0, no run, and no origin group.
14. Feed a few thousand random spins through all ten patterns: no count may ever be positive,
    each pattern's deepest reached must equal the minimum count it ever observed, Ena/Duo's
    count must never be deeper than Diada's and Ena/Duo 2's never deeper than Diada 2's,
    Ena/Duo must be armed exactly when Monada or Diada is and Ena/Duo 2 exactly when
    Monada 2 or Diada 2 is, Triada must never be armed alongside Monada, Diada or Ena/Duo, at most
    one of the three **single-arm** mirrors may be armed at a time, and no mirror may ever score
    on the same spin as the pattern it mirrors. Do **not** assert that no two mirrors are ever
    armed together — Ena/Duo 2 breaks that, by design.
15. Replay the same sequence twice from a fresh state; the two results must be identical. The
    state machine has no clock, no randomness and no I/O, so anything else means hidden state.
16. Against live spins, each one-way pattern must be armed **exactly** at its own interruption
    length: Monada when the trailing run after an A is one B, Diada at two, Triada at
    three, Ena/Duo at either one or two — with origin group A in every case — and, with origin
    group **B**, Monada 2 when the trailing run after a B is one A, Diada 2 when it is two,
    Triada 2 when it is three, and Ena/Duo 2 at either one or two. Those checks catch a pattern
    wired to the wrong spins, which no unit test can see.

---

## 11. Where this lives in this repository

| file | what it holds |
|---|---|
| `src/shared/groups.ts` | the two group lists and `groupOf` |
| `src/shared/engine.ts` | the state machine — the only implementation of the pattern |
| `src/shared/engine.test.ts` | the All in 1 vectors from §7 |
| `src/shared/engine.variantB.test.ts` | the All in 2 shapes from §7 |
| `src/shared/engine.variantC.test.ts` | the Monada shapes from §7 |
| `src/shared/engine.variantD.test.ts` | the Diada shapes from §7 |
| `src/shared/engine.variantE.test.ts` | the Ena/Duo shapes from §7 |
| `src/shared/engine.variantF.test.ts` | the Triada shapes from §7 |
| `src/shared/engine.variantG.test.ts` | the Monada 2 shapes from §7, and the swap invariant |
| `src/shared/engine.variantH.test.ts` | the Diada 2 shapes from §7, and the swap invariant |
| `src/shared/engine.variantI.test.ts` | the Triada 2 shapes from §7, and the swap invariant |
| `src/shared/engine.variantJ.test.ts` | the Ena/Duo 2 shapes from §7, and the swap invariant |
| `src/shared/diff.ts` | new-spin detection: ids, overlap matching, and the ambiguity guard |
| `src/renderer/index.css` | the palette, including the two group colours from §2.1 |
| `docs/SPEC.md` | the full build spec; §2–§4 are the pattern, §7 is new-spin detection |
| `docs/AGENT-BRIEF.md` | the same rules in short form, self-contained, for handing to an implementer |

`docs/BETTING-STRATEGY.md` describes a staking scheme layered on top of these counts. It is a
separate concern: the patterns produce a count, and nothing in this document assumes anything is
staked on it.
