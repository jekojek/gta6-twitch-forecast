# How it works

## The problem

Grand Theft Auto VI releases 19 November 2026, rolling midnight local time
(New Zealand first at 2026-11-18T11:00Z, central Europe 23:00Z, the UK 00:00Z,
US East 05:00Z, US West 08:00Z). One hour into the UTC release day we know a
single number — hour 1's print, the mean concurrent Twitch viewers in the
"Grand Theft Auto VI" category over 00:00–01:00Z — plus the pre-release
history and the hourly curves of 38–42 past big launches. From that we must
forecast hours 2–24 as five quantiles each, scored by mean pinball loss on the
log scale. A prize needs a loss strictly below the best house entry: the
persistence baseline (every hour stays at hour 1's print, spread widening as
0.15·sqrt(h−1) in log space) and a house AI model forecast.

## The model

Everything is fit at run time from the case file. There are no stored tables
and no constants tuned to a particular launch.

### 1. Shape pool: rolling-midnight launches only

For a past launch with release-day hourly viewers v_0..v_23 (hour 1 = v_0),
define the log-ratio curve r_h = ln(v_h / v_0), h = 1..23. Two kinds of launch
hide in the comparables:

- **Rolling midnight** (most of them, and all four practice launches): the game
  is already playable somewhere at 00:00Z, so hour 1 is a real launch print
  and r_h is a meaningful curve — typically a dip in the small hours, then a
  rise as the US unlocks and Europe's evening arrives.
- **Single global unlock** (Black Myth: Wukong 02:00Z, Silksong 14:00Z,
  Battlefield 6 ~14:00Z, Baldur's Gate 3, ARC Raiders, HELLDIVERS 2): hour 1
  is *before* anyone can play, so v_0 is a handful of countdown-watchers and
  r_h explodes (up to 2000×). Their p1-anchored curve means something else.

We detect the second kind from the data alone: a single hour jumping ≥ 4×
into a level ≥ 5× the launch's pre-release median (7 days before release day)
within the first 16 hours. Those launches leave the shape pool. (Two more —
Battlefield 6, Kingdom Come: Deliverance II — rise too gradually for the
single-jump test and stay in the pool; the kernel weighting below gives them
near-zero weight for a big target anyway, and the leave-one-out numbers
already include them.)

The target game's own pre-release history (the GTA VI category's curve since
its 2026-08-27 premiere) is also excluded — it is not a launch — by name and
because it has no hour-1 print on its own day_start.

### 2. The curve depends on the size of hour 1

This is the single most important fact in the data. Across the rolling pool:

| hour | corr(ln p1, ln(v_h / v_1)) | slope |
| --- | --- | --- |
| 3 | 0.04 | 0.01 |
| 9 | −0.53 | −0.22 |
| 15 | −0.71 | −0.47 |
| 20 | −0.89 | −0.84 |

The bigger hour 1 already is, the flatter the rest of the day. Binned medians
make it concrete (ratio v_h / v_1 at hour 20): p1 < 10k → ~206×, 10–50k →
~4.8×, 50–150k → ~1.8×, 150–400k → ~1.2×, ≥ 400k → ~0.9×. The three launches
above 400k (ELDEN RING, Cyberpunk 2077, Diablo IV) peak in hour 1 and decay
to 0.55–0.96× by hour 24.

So each hour's curve value m_h is a **Gaussian-kernel weighted mean** over the
pool in ln p1 (bandwidth 1.0), **trimmed 15% of weight from each tail**, then
smoothed over neighbouring hours (3-point mean). The kernel is what makes the
model safe for GTA VI: hour 1 will very likely exceed every past launch's
(875k is the largest in the pool), and a kernel saturates — the forecast for a
1M or 2M first hour looks like the largest past launches (dip to ~0.55×
mid-morning, rise to ~1.0–1.2× in the evening, decay to ~0.8–1.1×), instead of
extrapolating a linear ln p1 slope into absurdity (a fitted slope of −0.84
would put hour 20 at 0.07× of hour 1 for a 1.5M print). A linear
per-hour slope on ln p1 was tested and rejected for exactly this reason; a
k-nearest-neighbour median was also tested and was worse.

The target's own pre-release level (the ratio of hour 1 to its pre-release
median) was tested as a second conditioning variable and did not help once ln
p1 was in. Hour-1 channel counts were tested too (partial correlations
|ρ| ≤ 0.22 after controlling for ln p1) and were left out.

### 3. Spread from leave-one-out residuals

A fixed spread (like the baseline's 0.15) is wrong here: small launches are
far less predictable than big ones. For every pool launch i, the curve is
refit without i, at i's own p1, and the residual e_{i,h} = r_{i,h} − m^(−i)_h
is recorded. Then σ_h is the standard deviation of the residuals of the **12
pool launches nearest the target in ln p1** — so a big target gets the tighter
spread big launches earned (σ ≈ 0.40–0.53 late in the day) and a small target
the wider one (σ up to ~0.9). σ is floored at 0.15, capped at 1.2, and smoothed
over neighbouring hours. Quantiles are q_τ(h) = p1 · exp(m_h + z_τ · σ_h),
rounded to 2 decimals, forced non-decreasing.

Note the spread is honest about what the model does *not* know: it is the
spread of past launches' deviations from the curve the model would have
forecast for them, not a guessed number.

## Validation

Leave-one-out over the 37 shape comparables in a practice case (each launch
forecast from the other 36 plus the target's own hour-1 print, scored against
its real release-day curve, pinball loss on the log scale; the shipped
`main.ts` itself was run once per pseudo-case to produce these numbers):

| set | n | this model | house baseline | wins |
| --- | --- | --- | --- | --- |
| all launches | 37 | **0.452** | 0.930 | 32/37 |
| rolling-midnight | 32 | **0.363** | 0.564 | 27/32 |
| big (p1 ≥ 100k) | 16 | **0.215** | 0.261 | 11/16 |
| small (p1 < 100k) | 21 | **0.633** | 1.439 | 21/21 |
| simultaneous-unlock | 5 | **1.027** | 3.271 | 5/5 |

90% coverage on the LOO: 0.82 overall, 0.92 on big launches (an honest 90%
band should cover ~0.90). Typical median miss: 44% on big launches, 104% on
rolling launches overall — the day's shape genuinely varies a lot between
launches, and the spread above prices that in.

The five LOO losses are all big, flat launches where the model predicts a
little too much mid-day rise (Monster Hunter Wilds, Starfield, Marvel Rivals,
Diablo IV, and Borderlands 4, which is a tie at 0.253). The model's edge on
big launches comes from the other eleven, including the largest ones
(ELDEN RING 0.114 vs 0.211, Hogwarts Legacy 0.139 vs 0.288, The Last of Us
Part II 0.124 vs 0.247).

## Caveats, stated plainly

- **The final is one launch, not 37.** LOO says the model beats persistence
  on average and on most launches, but on any single big flat launch
  persistence can win (it did on 5 of 16 big LOO cases, by small margins).
  The prize is decided by one day.
- **GTA VI's hour 1 will probably exceed the data.** The largest hour-1 print
  in the pool is 875k (ELDEN RING). If GTA VI prints 1–2M, the forecast leans
  on the kernel's saturation and on three to six giant launches; that is a
  judgement call, not something the data can prove.
- **The practice score is not the final score.** The four practice launches
  are console rolling-midnight launches like GTA VI, but their answers are
  SullyGnome hourly averages, while the final is scored on the house
  recorder's minute reads — close, not the same measure.
- **Unlock waves are assumed, not observed.** The model never sees *when* GTA
  VI unlocks in each region; it assumes the regional wave pattern of past
  rolling launches (NZ → Asia → Europe → UK → US East → US West) repeats.
  A delayed unlock or a platform outage would break the shape in ways no
  spread can cover.
- **No early-access contamination is assumed.** GTA VI has no early access;
  had it, hour 1 would already be post-peak and the curve would be wrong.
- **Determinism and cost.** The program is deterministic (two runs write
  byte-identical output) and takes ~0.25 s per case on one CPU, far inside the
  8 s cap. If any part of a case is unusable it degrades to the persistence
  baseline rather than failing, because an invalid case is scored as the
  hour-1 print everywhere and takes the entry out of the prizes.

## Reproduce the validation

The prototype and harness used to develop the model live outside this repo
(they were the working notes, not the entry). To re-check the shipped program
on the practice cases:

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`input/` is the kit's input directory (`p00.in` … `p03.in`). Each output is
23 rows, hours 2–24, five non-decreasing quantiles, under 65,536 bytes.
