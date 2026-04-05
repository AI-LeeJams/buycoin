/**
 * PM2 Ecosystem Configuration
 *
 * 사용법:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs buycoin-trader
 *   pm2 monit
 *
 * 전체 재시작:
 *   pm2 restart ecosystem.config.cjs
 *
 * 옵티마이저만 수동 실행:
 *   pm2 start ecosystem.config.cjs --only buycoin-optimizer
 *
 * 로그 위치: <프로젝트>/logs/
 */

const path = require("path");
const fs = require("fs");
const logsDir = path.join(__dirname, "logs");

// PM2는 로그 디렉토리가 없으면 자동 생성하지 않으므로 보장합니다.
try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}

module.exports = {
  apps: [
    // ─── 메인 트레이딩 봇 ───
    {
      name: "buycoin-trader",
      script: "./src/app/run.js",
      interpreter: "node",
      interpreter_args: "--max-old-space-size=512",
      cwd: __dirname,

      // 자동 재시작 설정
      autorestart: true,
      watch: false,
      max_restarts: 50,           // 최대 재시작 횟수 (restart_limit 내)
      min_uptime: "10s",          // 이 시간 내 죽으면 비정상 종료로 간주
      restart_delay: 5000,        // 재시작 전 5초 대기 (API 폭주 방지)
      max_memory_restart: "512M", // 메모리 512MB 초과시 자동 재시작

      // 환경변수 (.env 파일은 run.js에서 자체 로딩)
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Seoul",
        TRADING_PROFILE: "safe",
        EXECUTION_SYMBOL: "BTC_KRW",
        OPTIMIZER_LIVE_SAFETY_GATE_ENABLED: "0",
        OPTIMIZER_LIVE_SAFETY_GATE_MAX_AGE_SEC: "7200",
      },

      // 로그 설정 (절대 경로 — PM2 데몬이 cwd를 무시할 수 있음)
      error_file: path.join(logsDir, "trader-error.log"),
      out_file: path.join(logsDir, "trader-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,

      // 시그널 처리 (graceful shutdown)
      // 실시간 윈도우(기본 300초)가 끝날 때까지 대기해야 하므로
      // 기본 windowSec(300초) + 여유시간을 반영해 graceful shutdown을 보장합니다.
      kill_timeout: 330000,        // SIGTERM 후 330초 대기, 이후 SIGKILL
      listen_timeout: 10000,
      shutdown_with_message: false,

      // 비정상 재시작 제한
      exp_backoff_restart_delay: 1000,  // 연속 크래시 시 지수 백오프
    },

    // ─── 옵티마이저 (주기적 실행) ───
    //
    // PM2의 cron_restart는 "실행 중인" 프로세스를 재시작하는 기능이므로
    // autorestart: true로 해야 프로세스가 종료 → 즉시 재시작 → 대기(sleep)
    // → cron 시간에 재시작 사이클이 동작합니다.
    //
    // optimize.js는 작업 완료 후 process.exit(0)으로 종료하므로,
    // autorestart: true + restart_delay로 실행 간격을 조절합니다.
    // 파일 잠금(lock) 메커니즘이 중복 실행을 방지합니다.
    {
      name: "buycoin-optimizer",
      script: "./src/app/optimize.js",
      interpreter: "node",
      interpreter_args: "--max-old-space-size=1024",
      cwd: __dirname,

      cron_restart: "0 * * * *",  // 매 정시에 강제 재시작 (최신 데이터로 최적화)
      autorestart: true,           // 종료 후에도 PM2가 프로세스를 유지
      restart_delay: 3600000,      // 일반 재시작은 1시간 후 (cron이 우선)
      max_restarts: 100,
      min_uptime: "5s",
      watch: false,

      env: {
        NODE_ENV: "production",
        TZ: "Asia/Seoul",
        TRADING_PROFILE: "safe",
        EXECUTION_SYMBOL: "BTC_KRW",
        OPTIMIZER_SYMBOLS: "BTC_KRW,ETH_KRW",
        OPTIMIZER_USE_MARKET_UNIVERSE_SYMBOLS: "0",
        OPTIMIZER_LIVE_SAFETY_GATE_ENABLED: "true",
        OPTIMIZER_LIVE_SAFETY_GATE_MAX_AGE_SEC: "7200",
      },

      // 로그 설정
      error_file: path.join(logsDir, "optimizer-error.log"),
      out_file: path.join(logsDir, "optimizer-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,

      kill_timeout: 10000,
      max_memory_restart: "1024M",
    },
  ],
};
