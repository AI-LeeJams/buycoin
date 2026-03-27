# buycoin-trader 사용 가이드 (KO)

## 아키텍처

정통 실행 파이프라인:

1. 시세 데이터 수집
2. 룰 기반 시그널 생성(리스크-관리 모멘텀, 기본)
3. 리스크 검증
4. 즉시 주문 실행

추론/외부 제어 경로는 제거되었습니다.
이제 전략 탐색 결과를 `strategy-settings.json`에 반영하고, 실시간 실행은 규칙 기반 시그널과 리스크 정책만 사용합니다.

## 설치

```bash
cd ./buycoin
npm install
```

`.env.example`를 기준으로 `.env`를 설정하세요.
기본 운영은 최소값만 `.env`에 두고, 매매 튜닝은 코드 기본값과 optimizer에 맡기는 구성을 권장합니다.

## 실행

- 실행형 서비스: `npm start`
- 기본 unattended 운용은 2개 live 심볼(`OPTIMIZER_MAX_LIVE_SYMBOLS=2`) 기준입니다.
- 실행 중 유동성/품질 필터를 통과한 종목 목록이 `.trader/market-universe.json`에 저장됩니다.

## 전략 설정 연동(자동매매 설정 입력점)

- 기본 출력 파일: `.trader/strategy-settings.json`
- `npm run optimize`가 시장 데이터와 현재 설정을 기반으로 전략 후보를 평가합니다.
- `npm start`는 시작 시 자동 최적화를 1회 수행하고, `OPTIMIZER_REOPT_INTERVAL_SEC` 기준으로 주기 재최적화를 수행할 수 있습니다.
- 실행 루프는 전략 설정 스냅샷 갱신 주기 기준으로 동작합니다.
- 전략 설정 변경은 `run.js`에서 다음 refresh 시점에만 반영됩니다(체결 루프 1틱마다 즉시 반영되지 않음).
- `optimize`는 현재 `market-universe` 스냅샷과 `OPTIMIZER_SYMBOLS`를 우선 사용해 탐색 대상을 구성합니다.
- 신규 코인 회피는 별도 수동 blacklist보다 `OPTIMIZER_MIN_HISTORY_CANDLES` 기준으로 처리하는 것이 기본입니다.
- 동시 다중 종목 실행은 `execution.symbols` 배열(또는 콤마 문자열)로 지정합니다.
- 요청 종목은 `.trader/market-universe.json`과 교집합으로 실행됩니다(저유동/이상 종목 자동 제외).
- 필터 강도는 `.env`의 `MARKET_UNIVERSE_*` 값으로 조정합니다.
- `MARKET_UNIVERSE_INCLUDE_SYMBOLS=NONE`이면 수동 강제 포함 없이 유동성 필터 기준으로만 탐색합니다.
- 권장 운용: `npm start` 단독으로도 동작하지만, 전략 유니버스가 충분히 넓은지 `MARKET_UNIVERSE_*`, `OPTIMIZER_SYMBOLS`를 함께 조정하는 것이 좋습니다.
- 권장 필수 체크 입력: `.trader/state.json`, `.trader/market-universe.json`, `.trader/http-audit.jsonl`(활성 시), 런타임 로그, `.trader/optimizer-report.json`(있을 때).

예시:

```json
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": {
    "symbol": "USDT_KRW",
    "symbols": ["BTC_KRW", "ETH_KRW", "USDT_KRW"],
    "orderAmountKrw": 20000
  },
  "strategy": {
    "name": "risk_managed_momentum",
    "defaultSymbol": "BTC_KRW",
    "candleInterval": "15m",
    "candleCount": 160,
    "momentumLookback": 36,
    "volatilityLookback": 96,
    "momentumEntryBps": 16,
    "momentumExitBps": 10,
    "targetVolatilityPct": 0.5,
    "riskManagedMinMultiplier": 0.4,
    "riskManagedMaxMultiplier": 1.8,
    "autoSellEnabled": true,
    "baseOrderAmountKrw": 20000
  },
  "controls": {
    "killSwitch": false
  },
  "meta": {
    "source": "optimizer",
    "runId": "1707955200000-12345"
  }
}
```

전략 설정 포맷 규칙:

- `strategy-settings.json`은 원자적 쓰기(`tmp` 파일 작성 후 `rename`)로 갱신하는 것이 안전합니다.
- `updatedAt`(`ISO` 또는 epoch ms)와 `version`(`1`)을 반드시 포함합니다.
- unattended 운용 기본값은 `meta.source=optimizer` 스냅샷만 live에 반영하는 것입니다.
- stale 스냅샷은 live에 반영되지 않습니다(`STRATEGY_SETTINGS_MAX_AGE_SEC`).
- `controls.killSwitch=false`는 runtime 리스크 정책이 올린 kill-switch를 자동 해제하지 않습니다.

## 실행 명령

```bash
npm start
```

CLI 모드는 제거되었습니다. 설정/제어는 `.env`와 `strategy-settings.json` 기반으로 수행합니다.

## 실행 규칙

- BUY 시그널: 즉시 시장가 매수 실행
- SELL 시그널: `STRATEGY_AUTO_SELL_ENABLED=true`면 즉시 시장가 매도 실행
- `STRATEGY_SELL_ALL_ON_EXIT=true`면 SELL은 고정 KRW 금액이 아니라 보유 가능한 수량 기준 전량 매도로 계산
- HOLD 시그널: 주문하지 않음
- 실시간 티커 모드는 빗썸 Public WebSocket(`wss://ws-api.bithumb.com/websocket/v1`)을 사용
- WebSocket 채널 지원:
  - public: `ticker`, `trade`, `orderbook`
  - private: `myOrder`, `myAsset`

## 리스크 제어

- 최소/최대 주문금액
- 최대 동시 오픈주문 수
- 최대 총 노출
- 일 손실 한도
- Kill Switch
- risk policy가 활성화한 kill-switch는 운영자가 별도로 해제하기 전까지 유지되는 보수 모드입니다.

## HTTP 감사로그

- 활성화: `TRADER_HTTP_AUDIT_ENABLED`
- 파일 경로: `TRADER_HTTP_AUDIT_FILE` (기본 `.trader/http-audit.jsonl`)
- 자동 로테이션: `TRADER_HTTP_AUDIT_MAX_BYTES`, `TRADER_HTTP_AUDIT_PRUNE_RATIO`, `TRADER_HTTP_AUDIT_CHECK_EVERY`

상태 파일 과대화 방지 보존 상한:

- `TRADER_STATE_KEEP_LATEST_ONLY` (`true`면 최신 스냅샷 + 미체결 주문 중심으로만 유지)
- `TRADER_RETENTION_CLOSED_ORDERS`
- `TRADER_RETENTION_ORDERS`
- `TRADER_RETENTION_ORDER_EVENTS`
- `TRADER_RETENTION_STRATEGY_RUNS`
- `TRADER_RETENTION_BALANCE_SNAPSHOTS`
- `TRADER_RETENTION_FILLS`

일 손실 기준값:

- `TRADER_INITIAL_CAPITAL_KRW` 설정 시 해당 값을 baseline으로 사용
- 미설정 시 당일 첫 평가자산을 baseline으로 사용

## 참고

- 실거래는 빗썸 키 + 허용 IP 설정이 필요합니다.
- 빗썸 초당 제한(공개 150, 비공개 140)은 내장 제한기로 반영됩니다.
- WebSocket 연결 제한(기본 5/s)은 `BITHUMB_WS_CONNECT_MAX_PER_SEC`로 적용됩니다.
