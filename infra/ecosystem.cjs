// PM2 ecosystem config — Nomus Engine only
// Usage: pm2 start /opt/nomus/infra/ecosystem.cjs
// SCOPE: Nomus engine ONLY.

module.exports = {
  apps: [
    {
      name: 'nomus-engine',
      script: '/opt/nomus/engine/dist/index.js',
      cwd: '/opt/nomus',
      instances: 1, // SQLite = single writer — do NOT cluster
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        NOMUS_ENV: 'production',
        NOMUS_PORT: 3100,
        NOMUS_LOG_FORMAT: 'json',
        NOMUS_LOG_LEVEL: 'info',
      },
      env_file: '/opt/nomus/.env',
      max_memory_restart: '512M',
      error_file: '/opt/nomus/logs/engine-error.log',
      out_file: '/opt/nomus/logs/engine-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      watch: false,
      kill_timeout: 5000,
    },
  ],
};
