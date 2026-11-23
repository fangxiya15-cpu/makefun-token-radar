# makefun-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/fangxiya15-cpu/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/fangxiya15-cpu/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar built for make.fun's token-radar-01 bounty by @fang-marten. It reads the sealed DefiLlama snapshot (758 protocols), fits a value model on the 128 already-launched protocols with a measurable market cap — log(market cap) on log(TVL) by OLS, per-category median residual offsets shrunk n/(n+4), growth and no-token-age effects fitted on residuals and applied at the cross-validated 1/4 strength — and ranks 235 unlaunched protocols by implied value. Every board row carries a six-step farm plan whose costs and hours are computed from that protocol's own chains, TVL tier and age. The dashboard prints the fitted formula, the cross-validation table and the eligibility counts, so every number on the board can be re-derived from the snapshot.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

This writes `board.json`, the static dashboard and `dossier.json` to the output directory.

---

<sub>Entered on [make.fun](https://make.fun/?ref=08zkyt11&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
