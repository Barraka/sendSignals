module.exports = {
  apps: [
    {
      name: "signal-watcher",
      script: "watcher.js",
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
