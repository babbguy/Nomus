// PM2 ecosystem config for running the engine without Docker
// Usage: pm2 start ecosystem.config.cjs

module.exports = {
  apps: [
    {
      name: 'nomus-engine',
      script: 'engine/dist/index.js',
      cwd: __dirname,
      instances: 1, // SQLite = single writer
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        NOMUS_ENV: 'production',
        NOMUS_PORT: 3100,
        NOMUS_LOG_FORMAT: 'json',
        NOMUS_LOG_LEVEL: 'info',
        NOMUS_DB_PATH: './data/nomus.db',

        // Secrets are not set here. Put them in .env (see engine/.env.example)
        // or export them in the environment PM2 is started from.
      },
      max_memory_restart: '512M',
      error_file: './logs/engine-error.log',
      out_file: './logs/engine-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 5000,
      max_restarts: 10,
      watch: false,
    },
  ],
};
