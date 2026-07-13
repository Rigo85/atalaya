module.exports = {
  apps: [
    {
      name: 'atalaya',
      script: 'dist/main.js',
      cwd: __dirname,
      // El host de producción corre en UTC; el digest usa hora de Lima.
      env: { NODE_ENV: 'production', TZ: 'America/Lima' },
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
    },
  ],
};
