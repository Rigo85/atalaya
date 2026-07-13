module.exports = {
  apps: [
    {
      name: 'atalaya',
      script: 'dist/main.js',
      cwd: __dirname,
      // bluetv corre en UTC: fijar TZ para que la hora del digest sea hora de Lima
      env: { NODE_ENV: 'production', TZ: 'America/Lima' },
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
