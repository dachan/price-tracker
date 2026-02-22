const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const sharedEnv = {
  ...process.env,
  NODE_ENV: "production",
};

module.exports = {
  apps: [
    {
      name: "price-tracker-web",
      cwd: path.join(__dirname, "apps/web"),
      script: path.join(__dirname, "node_modules/.bin/next"),
      args: "start -H 0.0.0.0 -p 4004",
      env: sharedEnv,
    },
    {
      name: "price-tracker-worker",
      cwd: __dirname,
      script: "npm",
      args: "run start:worker",
      env: sharedEnv,
    },
  ],
};
