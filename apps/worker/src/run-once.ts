import "dotenv/config";

import { PriceTrackerService } from "@price-tracker/extraction";

const service = new PriceTrackerService();

void (async () => {
  await service.runDailyChecks();
  process.exit(0);
})();
