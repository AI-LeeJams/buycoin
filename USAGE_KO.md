# buycoin-trader 사용 가이드 (KO)

## 아키텍처

정통 실행 파이프라인:

1. 시세 데이터 수집
2. 룰 기반 시그널 생성(mean reversion, 기본)
3. 리스크 검증
4. 즉시 주문 실행

추론/외부 제어 경로는 제거되었습니다.
실시간 실행은 단일 mean reversion 전략과 리스크 정책만 사용합니다.

## 설치

```bash
cd ./buycoin
npm install
```

`.env.example`를 기준으로 `.env`를 설정하세요.
기본 운영은 최소값만 `.env`에 두고, 매매 튜닝은 코드 기본값과 optimizer에 맡기는 구성을 권장합니다.

## 실행

- 실행형 서비스: `npm start`
- 기본 unattended 운용은 1개 live 심볼 기준입니다.
- 실행 중 유동성/품질 필터를 통과한 종목 목록이 `.trader/market-universe.json`에 저장됩니다.

## 전략 설정 연동(자동매매 설정 입력점)

- 기본 출력 파일: `.trader/strategy-settings.json`
- `npm run optimize`는 시장 데이터 기반 연구용 리포트(`.trader/optimizer-report.json`)를 생성합니다.
- `npm start`는 optimizer 결과를 live에 자동 적용하지 않습니다.
- live에서 읽는 값은 `controls.pauseEntries`와 단일 `execution.symbol`/`execution.orderAmountKrw` 오버라이드 정도로 제한됩니다.
- 요청 종목은 `.trader/market-universe.json`과 교집합으로 실행됩니다(저유동/이상 종목 자동 제외).
- 필터 강도는 `.env`의 `MARKET_UNIVERSE_*` 값으로 조정합니다.
- `MARKET_UNIVERSE_INCLUDE_SYMBOLS=NONE`이면 수동 강제 포함 없이 유동성 필터 기준으로만 탐색합니다.
- 권장 운용: `TRADING_PROFILE` 선택 후 `npm start` 단독으로 운영하고, 필요할 때만 심볼과 주문금액을 소수 키로 오버라이드합니다.
- 권장 필수 체크 입력: `.trader/state.json`, `.trader/market-universe.json`, `.trader/http-audit.jsonl`(활성 시), 런타임 로그, `.trader/optimizer-report.json`(있을 때).

예시:

```json
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": {
    "symbol": "USDT_KRW",
    "orderAmountKrw": 20000
  },
  "controls": {
    "pauseEntries": false
  },
  "meta": {
    "source": "operator"
  }
}
```

전략 설정 포맷 규칙:

- `strategy-settings.json`은 원자적 쓰기(`tmp` 파일 작성 후 `rename`)로 갱신하는 것이 안전합니다.
- `updatedAt`(`ISO` 또는 epoch ms)와 `version`(`1`)을 반드시 포함합니다.
- stale 스냅샷은 live에 반영되지 않습니다(`STRATEGY_SETTINGS_MAX_AGE_SEC`).
- `controls.pauseEntries=true`는 신규 BUY만 막고, 보호청산/SELL은 계속 허용합니다.

## 실행 명령

```bash
npm start
```

CLI 모드는 제거되었습니다. 설정/제어는 `.env`, `TRADING_PROFILE`, `strategy-settings.json` 기반으로 수행합니다.

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
- Entry Block
- risk policy는 전역 정지 대신 `entry block`을 활성화해 신규 진입만 차단하며, 기존 포지션 관리와 청산은 계속 수행합니다.

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

- 일간 entry block은 당일 첫 평가자산을 baseline으로 사용
- `TRADER_INITIAL_CAPITAL_KRW`는 누적 성과 참고값으로만 유지합니다

## 참고

- 실거래는 빗썸 키 + 허용 IP 설정이 필요합니다.
- 빗썸 초당 제한(공개 150, 비공개 140)은 내장 제한기로 반영됩니다.
- WebSocket 연결 제한(기본 5/s)은 `BITHUMB_WS_CONNECT_MAX_PER_SEC`로 적용됩니다.
