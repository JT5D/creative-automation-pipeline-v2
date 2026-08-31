import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { CampaignBriefSchema } from "../shared/schema.js";
import { runPipeline } from "./pipeline.js";
import { verifyProvider } from "./providers/index.js";

const projectRoot = process.cwd();
const input = process.argv[2] ?? "samples/campaign.yaml";
const raw = await readFile(path.resolve(projectRoot, input), "utf8");
const brief = CampaignBriefSchema.parse(input.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw));
const { provider } = await verifyProvider();
const report = await runPipeline(brief, {
  projectRoot,
  outputRoot: path.join(projectRoot, "outputs"),
  provider
});

process.stdout.write(`${JSON.stringify({
  runId: report.runId,
  campaigns: report.metrics.campaigns,
  products: report.metrics.products,
  creatives: report.metrics.creatives,
  reused: report.metrics.reused,
  generatedLive: report.metrics.generatedLive,
  generatedSample: report.metrics.generatedSample,
  estimatedTimeSavedMinutes: report.metrics.timeSavedMinutes,
  creativesPerMinute: report.metrics.creativesPerMinute,
  warnings: report.warnings
}, null, 2)}\n`);
