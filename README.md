# GTA VI launch-day Twitch forecast

[![make.fun](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/jekojek/gta6-twitch-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/jekojek/gta6-twitch-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecasts how many people watch **Grand Theft Auto VI** live on Twitch in each
hour of its release day, 19 November 2026 (UTC), as five quantiles (5%, 25%,
50%, 75%, 95%) per hour — from everything recorded up to the end of the day's
first hour, that hour's count included. Entry for the
[make.fun bounty](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
of the same name.

## How it works

`main.ts` (Node 22, standard library only, offline, deterministic) reads one
case file, `/input/<id>.in`, and writes `/output/<id>.out`. The model is fit
at run time from the case's own comparables — 38–42 past big game launches'
hourly Twitch curves — in three steps:

1. **Shape.** For each past launch, the log of its viewers in each release-day
   hour over its hour-1 print. Launches whose hour 1 falls *before* anyone can
   play (a single global unlock later in the day, visible as one hour jumping
   ≥ 4× off a pre-release level) are set aside: their hour-1 print is not a
   launch print. The rest — rolling-midnight launches, like GTA VI — form the
   shape pool.
2. **Scale.** A launch's curve depends strongly on how big its hour-1 print
   already is: across the pool, corr(ln p1, ln(v_h / v_1)) runs from ~0 at hour
   2 to about −0.89 by hour 20. The biggest launches peak in hour 1 and decay;
   small ones keep climbing as regions unlock. Each hour's value is therefore a
   Gaussian-kernel weighted mean over the pool in ln p1 (bandwidth 1.0), trimmed
   15% of weight from each tail, smoothed over neighbouring hours. The kernel
   saturates — a first hour larger than any past launch is forecast like the
   largest past launches, never extrapolated linearly past them.
3. **Spread.** For every pool launch the curve is refit without it
   (leave-one-out, at that launch's own p1) and the residual in each hour is
   recorded. σ_h is the standard deviation of the residuals of the 12 pool
   launches nearest the target in ln p1 — big launches get the tighter spread
   big launches earned — floored at 0.15, capped at 1.2, smoothed. Quantiles:
   q_τ(h) = p1 · exp(m_h + z_τ · σ_h).

If a case is unusable (no hour-1 print, no shape pool), the program falls back
to the house persistence baseline instead of failing, because an invalid case
is scored as the hour-1 print everywhere. See
[docs/how-it-works.md](docs/how-it-works.md) for the full write-up, the
leave-one-out validation, and the honest caveats.

## Validation (leave-one-out over the 38 comparables)

Each past launch is forecast from the other 37, exactly as the shipped program
does, and scored against its real release-day curve with the contest's pinball
loss on the log scale (lower is better):

| set | this model | house baseline (persistence) |
| --- | --- | --- |
| all 37 launches | **0.452** | 0.930 |
| rolling-midnight launches (32) | **0.363** | 0.564 |
| big launches, hour-1 print ≥ 100k (16) | **0.215** | 0.261 |
| simultaneous-unlock launches (5) | **1.027** | 3.271 |

The model beats persistence on 32 of 37 launches. For scale: on the four
practice cases the house baseline scores about 0.387.

## Run it

```sh
# on the practice cases from the kit (input/ holds p00.in .. p03.in)
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22 required. One case takes ~0.25 s on one CPU, far inside the 8 s cap.
Two runs on the same case write byte-identical output.

## Files

- `main.ts` — the forecaster (the only code the grader runs)
- `docs/how-it-works.md` — model, calibration, and caveats
- `LICENSE` — MIT

Data: viewer counts are SullyGnome.com's hourly Twitch category averages,
quoted with attribution; see the kit's `input/NOTICE.txt`.
