import { loadConfig } from "./config.js";
import { createRuntime } from "./bootstrap.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const runtime = createRuntime(config);
const app = await buildApp(config, runtime);

await app.listen({host: config.host, port: config.port});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    runtime.close();
    process.exit(0);
  });
}
