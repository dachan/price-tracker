module.exports = {
  apps: [
    {
      name: "price-tracker-web",
      cwd: __dirname,
      script: "npm",
      args: "run start:web",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "price-tracker-worker",
      cwd: __dirname,
      script: "npm",
      args: "run start:worker",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
