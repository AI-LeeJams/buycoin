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
 * 로그 위치: ~/.pm2/logs/ 또는 아래 error_file/out_file
 */

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
      },

      // 로그 설정
      error_file: "./logs/trader-error.log",
      out_file: "./logs/trader-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,

      // 시그널 처리 (graceful shutdown)
      // 실시간 윈도우(기본 300초)가 끝날 때까지 대기해야 하므로
      // kill_timeout은 windowSec + 여유시간으로 설정합니다.
      kill_timeout: 330000,        // SIGTERM 후 330초(5.5분) 대기, 이후 SIGKILL
      listen_timeout: 10000,
      shutdown_with_message: false,

      // 비정상 재시작 제한
      exp_backoff_restart_delay: 1000,  // 연속 크래시 시 지수 백오프
    },

    // ─── 옵티마이저 (주기적 실행) ───
    {
      name: "buycoin-optimizer",
      script: "./src/app/optimize.js",
      interpreter: "node",
      interpreter_args: "--max-old-space-size=1024",
      cwd: __dirname,

      // cron으로 1시간마다 실행
      cron_restart: "0 * * * *",  // 매 정시에 실행
      autorestart: false,          // cron job이므로 완료 후 재시작 불필요
      watch: false,

      env: {
        NODE_ENV: "production",
        TZ: "Asia/Seoul",
      },

      // 로그 설정
      error_file: "./logs/optimizer-error.log",
      out_file: "./logs/optimizer-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,

      // 옵티마이저가 15분 이상 걸리면 강제 종료
      kill_timeout: 10000,
      max_memory_restart: "1024M",
    },
  ],
};
