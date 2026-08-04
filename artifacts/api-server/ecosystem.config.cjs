/**
 * PM2 ecosystem configuration — Deriv Edge API (AWS EC2)
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save
 *   pm2 startup systemd
 *
 * Environment is loaded from the local `.env` file (see deploy.sh), which
 * keeps secrets out of source control. `--env production` only switches the
 * NODE_ENV override if it is not already exported by the process.
 */
module.exports = {
  apps: [
    {
      name: "flex-api",
      script: "./dist/index.mjs",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      min_uptime: "5s",
      max_memory_restart: "512M",
      time: true,
      wait_ready: false,
      listen_timeout: 10000,
      kill_timeout: 15000,
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || "5000",
      },
    },
  ],
};