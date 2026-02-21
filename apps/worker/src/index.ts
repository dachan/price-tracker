import "dotenv/config";

import cron from "node-cron";

import { PriceTrackerService } from "@price-tracker/extraction";

const schedule = process.env.CHECK_SCHEDULE_CRON ?? "0 9 * * *";
const service = new PriceTrackerService();

async function executeDailyRun() {
  const startedAt = new Date();
  console.log(`[worker] Daily check run started at ${startedAt.toISOString()}`);

  try {
    await service.runDailyChecks();
    console.log(`[worker] Daily check run finished at ${new Date().toISOString()}`);
  } catch (error) {
    console.error("[worker] Daily check run failed", error);
  }
}

cron.schedule(schedule, () => {
  void executeDailyRun();
});

console.log(`[worker] Scheduler active with cron: ${schedule}`);

if (process.env.WORKER_RUN_ON_BOOT === "true") {
  void executeDailyRun();
}
