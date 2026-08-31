import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.PORT ?? 3001);
const app = createApp(projectRoot);

app.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Campaign Forge API listening on http://localhost:${port}\n`);
});
