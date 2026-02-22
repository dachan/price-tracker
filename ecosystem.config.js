module.exports = {
  apps: [
    {
      name: "price-tracker-web",
      cwd: __dirname,
      script: "npm",
      args: "run start -w @price-tracker/web -- -H 0.0.0.0 -p 4004",
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
