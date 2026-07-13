module.exports = {
  apps: [
    {
      name: 'atalaya',
      script: 'dist/main.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
