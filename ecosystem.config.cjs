module.exports = {
  apps: [
    {
      name:          "trading-bot-api",
      script:        "pnpm",
      args:          "start",
      cwd:           "./artifacts/api-server",
      watch:         false,
      autorestart:   true,
      max_restarts:  10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        PORT:     3001,
      },
    },
    {
      name:         "trading-bot-frontend",
      script:       "pnpm",
      args:         "serve",
      cwd:          "./artifacts/portfolio-strategist",
      watch:        false,
      autorestart:  true,
      max_restarts: 10,
      env: {
        PORT:      4173,
        BASE_PATH: "/",
      },
    },
  ],
};
