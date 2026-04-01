# AGENTS.md

This repository is a live Bithumb trading system. Treat all changes as production-sensitive.

## Purpose

- This service is not a paper-trading toy. It places real orders.
- Primary goal is not "more trades" but better live expectancy under real fees, slippage, and liquidity constraints.
- If a proposed change improves backtests but weakens live safety or increases execution friction, reject it or gate it behind config.

## Source Of Truth

- Runtime defaults and config parsing live in [src/config/defaults.js](/Users/leejam/buycoin/src/config/defaults.js).
- Live execution flow lives in [src/app/run.js](/Users/leejam/buycoin/src/app/run.js) and [src/core/trading-system.js](/Users/leejam/buycoin/src/core/trading-system.js).
- Optimizer logic lives in [src/app/optimize.js](/Users/leejam/buycoin/src/app/optimize.js) and [src/engine/strategy-optimizer.js](/Users/leejam/buycoin/src/engine/strategy-optimizer.js).
- Strategy snapshot contract lives in [src/app/strategy-settings.js](/Users/leejam/buycoin/src/app/strategy-settings.js).
- When docs disagree with code, prefer code. README/usage docs can lag behind live defaults.

## High-Risk Invariants

- Keep live/backtest assumptions aligned. Live uses market orders, so optimizer realism must include nonzero slippage and fee-aware acceptance.
- Do not reintroduce multi-strategy live orchestration. `npm start` is intentionally a single-strategy, single-symbol runner.
- Do not loosen risk controls casually. Current design intentionally favors:
  - 1 live symbol by default
  - single-position-per-symbol
  - mark-to-market daily loss entry block
  - exit-only mode when monitor detects open-loss stress
- Avoid hard profit caps unless explicitly intended. Fixed take-profit can be disabled; trailing logic is preferred for upside retention.
- Be careful with any change that increases `cashUsagePct`, `maxSymbolsPerWindow`, or `maxOrderAttemptsPerWindow`. Those are leverage-like knobs for this system.

## Runtime Behavior To Preserve

- `npm start` is the unattended live entrypoint.
- Live runtime should default to `mean_reversion` via `TRADING_PROFILE`, not via optimizer snapshots.
- `.trader/strategy-settings.json` is a light operator-control file, not a full live strategy contract.
- Held legacy symbols may run in exit-only mode even if they are not current entry targets.
- Runtime entry blocks raised by risk logic must preserve SELL/protective-exit behavior even while new BUY orders are blocked.

## Files To Inspect Before Making Changes

- [src/config/defaults.js](/Users/leejam/buycoin/src/config/defaults.js)
- [src/app/run.js](/Users/leejam/buycoin/src/app/run.js)
- [src/core/trading-system.js](/Users/leejam/buycoin/src/core/trading-system.js)
- [src/app/optimize.js](/Users/leejam/buycoin/src/app/optimize.js)
- [src/engine/strategy-optimizer.js](/Users/leejam/buycoin/src/engine/strategy-optimizer.js)
- [src/app/strategy-settings.js](/Users/leejam/buycoin/src/app/strategy-settings.js)

## Change Guidelines

- Prefer additive, config-driven risk changes over silent behavior changes.
- If you change optimizer thresholds or defaults, update tests that assert defaults and selection behavior.
- If you change live execution gating, add tests for:
  - order blocking
  - entry-block behavior
  - exit-only behavior
  - position sizing
- If you change protective exits, test both `runStrategyOnce` and realtime execution.
- If you change KPI monitor logic, verify behavior with fewer than 3 closed trades. That is a known blind spot area.
- If you add new metrics, thread them through summary/reporting in a way that is useful operationally, not just structurally complete.

## Things That Frequently Go Wrong

- Backtest winners with tiny edges look good only because slippage is too low.
- Aggressive symbol expansion increases regime mistakes faster than it diversifies them.
- Using available cash percentages without strong caps can quietly oversize small accounts.
- Closed-trade-only monitoring reacts too late when losses are still open.
- Docs and saved `.trader` artifacts can reflect older behavior; confirm against current code before relying on them.
- `npm run optimize` is research-only. Do not assume optimizer output mutates live runtime anymore.

## Validation Checklist

- Run `npm test`
- Run `npm run lint`
- If you touched live execution, inspect affected tests in:
  - [test/execution-runner.test.js](/Users/leejam/buycoin/test/execution-runner.test.js)
  - [test/trading-system.test.js](/Users/leejam/buycoin/test/trading-system.test.js)
  - [test/strategy-optimizer.test.js](/Users/leejam/buycoin/test/strategy-optimizer.test.js)
- If you changed config defaults, update [test/config-defaults.test.js](/Users/leejam/buycoin/test/config-defaults.test.js)

## Operational Notes

- PM2 process name is typically `buycoin`.
- Restarting PM2 is a deployment action, not a code change. Do not assume new code is live until the service is restarted.
- If env vars changed, use `pm2 restart buycoin --update-env`.
- Prefer operating with a small surface: `TRADING_PROFILE`, `EXECUTION_SYMBOL`, `EXECUTION_ORDER_AMOUNT_KRW`, `pauseEntries`.
- `.trader/state.json`, `.trader/strategy-settings.json`, and `.trader/execution-kpi-summary.json` are useful for debugging, but do not treat them as stable schemas unless the code explicitly does.

## When Unsure

- Choose the safer behavior.
- Keep new entry logic stricter, not looser.
- Preserve loss containment first, then improve aggressiveness only when expectancy survives realistic execution costs.
