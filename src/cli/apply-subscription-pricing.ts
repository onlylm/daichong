import {loadConfig} from "../config.js";
import {SqliteRepository} from "../infra/sqlite-repository.js";
import {applySubscriptionPricing} from "../operations/subscription-pricing.js";

const config = loadConfig();
if (config.storageDriver !== "sqlite") throw new Error("subscription_pricing_requires_sqlite");
const repository = new SqliteRepository(config.sqlitePath);
try { console.log(JSON.stringify(applySubscriptionPricing(repository))); }
finally { repository.close(); }
