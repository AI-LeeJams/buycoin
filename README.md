# buycoin-trader

실거래 전용 Bithumb 자동매매 시스템입니다.  
현재 운영 방식은 **Execution-First**이며, 룰 기반 전략 탐색과 리스크 제어로 수익률을 극대화하는 쪽에 초점을 둡니다.

---

## 1) 현재 아키텍처

실행 경로(고정):

`MarketData -> SignalEngine -> RiskEngine -> ExecutionEngine`

전략 운영:
- `npm run optimize`가 시장 데이터와 설정을 기반으로 전략 후보를 평가
- 결과 스냅샷은 `.trader/strategy-settings.json`에 반영
- 런타임(`npm start`)은 시작 시 자동 최적화를 1회 수행하고, 이후 주기적으로 재최적화/재적용

핵심 원칙:
- 틱 단위 추론이나 임의 판단으로 주문하지 않음
- 주문 실행은 규칙 기반 시그널과 리스크 조건으로 결정
- 전략 탐색은 백테스트/워크포워드/실거래 제약을 함께 반영
- 위험 제어가 수익 최적화보다 우선

---

## 2) 현재 운영 모드

- 런타임: **live-only** (`npm start`)
- 실행 프로세스: PM2 상시 실행 권장
- 설정 반영: 파일 기반 (`optimize` → `.trader/strategy-settings.json`)
- 자동 재최적화: `npm start`가 `OPTIMIZER_APPLY_ON_START`, `OPTIMIZER_REOPT_*` 기준으로 직접 수행
- 시장 유니버스: `.trader/market-universe.json` 기반 필터 적용

현재 기본 운용 프로파일(품질 우선):
- live symbols: 기본 2심볼(`OPTIMIZER_MAX_LIVE_SYMBOLS=2`) 보수 운용
- 탐색 유니버스: `MARKET_UNIVERSE_MAX_SYMBOLS`를 넓게 두고, 신규 코인은 `OPTIMIZER_MIN_HISTORY_CANDLES`로 차단
- `maxSymbolsPerWindow`: 기본 2
- `maxOrderAttemptsPerWindow`: 1~2
- `orderAmountKrw`: 동적(현금 기준) 또는 20,000 고정

---

## 3) 현재 리스크/안정화 정책

### A. 보호청산/재진입
- 보호청산 후 동일 심볼 BUY 재진입 쿨다운 적용 (`postExitBuyCooldownSec`, 기본 900초)

### B. Dust 처리
- `holdingNotional < 5,000 KRW`(dust)는 보호청산/신호 대상에서 제외

### C. 비실행성 거절 승격 제외
다음 거절은 `riskReject streak`/auto entry-block 승격에서 제외:
- `MIN_ORDER_NOTIONAL_KRW`
- `INSUFFICIENT_CASH`
- `SELL_EXCEEDS_HOLDING`
- `NO_SELLABLE_HOLDING`
- `ENTRY_BLOCKED`(에코)

### D. SELL 최소금액 미만 스킵
- SELL 주문금액이 최소 체결금액 미만이면 주문 시도 자체를 스킵

### E. BUY 현금 사전 게이트
- BUY 주문 전 가용 KRW를 선검사하여 현금 부족 주문 시도 차단

---

## 4) KPI/보고

현재 보고는 `npm run kpi-report` 기준으로 생성합니다.

보고 항목:
1. attempted / successful / rejected / fills
2. 성공률·거절률
3. reject reason Top3(rule)
4. 기준손익(`operator-baseline.json` 기준 baseline/equity/pnl)
5. 포지션 변화
6. 최근 전략 스냅샷 요약(`strategy-settings.json`)

기준손익 파일:
- `.trader/operator-baseline.json`

---

## 5) 주요 파일

- `.trader/strategy-settings.json` : optimize 병합 결과(런타임 반영 대상)
- `.trader/state.json` : 런타임 상태/주문/이벤트
- `.trader/market-universe.json` : 거래 가능 심볼 스냅샷
- `.trader/execution-kpi-summary.json` : KPI 요약
- `.trader/operator-baseline.json` : 기준손익 baseline

---

## 6) 실행 방법

### 설치
```bash
npm install
```

### 런타임 실행
```bash
npm start
```

### 최적화/정책 병합
```bash
npm run optimize
```

### KPI 보고 생성
```bash
npm run kpi-report
```

### PM2 운영 예시
```bash
pm2 start npm --name buycoin -- start
pm2 restart buycoin
pm2 logs buycoin
pm2 status
```

---

## 7) 환경 요구사항

- Node.js 20+
- Bithumb API Key/Secret
- `.env`는 최소 운영값만 두는 것을 권장 (`BITHUMB_ACCESS_KEY`, `BITHUMB_SECRET_KEY`, `TZ`, `TRADER_INITIAL_CAPITAL_KRW`, `TRADING_PROFILE`)
- live 매매 기본값은 코드 프리셋(`safe`, `balanced`, `aggressive`)이 담당
- 필요 시 `EXECUTION_SYMBOL`, `EXECUTION_ORDER_AMOUNT_KRW`만 추가 오버라이드

---

## 8) 운영 주의사항

- `npm start`는 단일 mean reversion 실행기입니다. 시작 시 optimizer를 live에 적용하지 않습니다.
- `npm run optimize`는 연구용 리포트만 생성하며 live 설정을 바꾸지 않습니다.
- `strategy-settings.json`은 이제 운영 제어 파일입니다. `pauseEntries`와 단일 심볼/주문금액 오버라이드만 live에 반영됩니다.
- 리스크 정책은 전역 정지 대신 `entry block`을 올려 신규 진입만 차단하고, 보호청산/SELL은 계속 허용함
- overlay는 기본 비활성화되어 과거 `.trader/overlay.json`이 주문 크기를 왜곡하지 않음
- 이상 징후(성공률 급락/거절률 급등/전략-로그 불일치) 시 즉시 핫픽스 후 재검증

---

## 9) 테스트

```bash
npm run lint
npm test
```
