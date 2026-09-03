import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { parse as parseYaml } from "yaml";
import { CampaignBriefJsonSchema, CampaignBriefSchema, formatZodError } from "../shared/schema.js";
import { runPipeline } from "./pipeline.js";
import { verifyProviders, type ProviderId } from "./providers/index.js";

export function createApp(projectRoot: string, providerEnvironment: NodeJS.ProcessEnv = process.env) {
  const app = express();
  const providerRuntime = verifyProviders(providerEnvironment);
  const outputRoot = path.join(projectRoot, "outputs");
  const uploadRoot = path.join(projectRoot, "workspace", "uploads");
  const upload = multer({
    storage: multer.diskStorage({
      destination: async (_request, _file, callback) => {
        await mkdir(uploadRoot, { recursive: true });
        callback(null, uploadRoot);
      },
      filename: (_request, file, callback) => callback(null, `${Date.now()}-${safeName(file.originalname)}`)
    }),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 }
  });

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use("/samples", express.static(path.join(projectRoot, "samples"), { fallthrough: false }));
  app.use("/workspace/uploads", express.static(uploadRoot, { fallthrough: false, maxAge: "1h" }));
  app.use("/outputs", express.static(outputRoot, { fallthrough: false, immutable: true, maxAge: "1h" }));

  app.get("/api/health", (_request, response) => response.json({ ok: true }));
  app.get("/api/schema", (_request, response) => response.json(CampaignBriefJsonSchema));
  app.get("/api/sample", async (_request, response, next) => {
    try {
      const raw = await readFile(path.join(projectRoot, "samples", "campaign.yaml"), "utf8");
      response.json({ brief: parseBrief(raw), providers: (await providerRuntime).status });
    } catch (error) { next(error); }
  });
  app.get("/api/samples", async (_request, response, next) => {
    try {
      const files = [
        "samples/briefs/european-launch.yaml",
        "samples/campaign.yaml",
        "samples/briefs/summer-california.yaml",
        "samples/briefs/active-canada.yaml"
      ];
      const briefs = await Promise.all(files.map(async (file) => parseBrief(await readFile(path.join(projectRoot, file), "utf8"))));
      response.json({ briefs, providers: (await providerRuntime).status, workspace: await workspaceMetrics(outputRoot) });
    } catch (error) { next(error); }
  });
  app.post("/api/brief/parse", (request, response) => {
    const raw = typeof request.body?.raw === "string" ? request.body.raw : "";
    response.json({ brief: parseBrief(raw) });
  });
  app.post("/api/assets", upload.single("asset"), async (request, response) => {
    if (!request.file) return response.status(400).json({ error: "Choose a PNG, JPEG, or WebP asset under 15 MB" });
    try {
      const metadata = await sharp(request.file.path).metadata();
      if (!metadata.width || !metadata.height || !["png", "jpeg", "webp"].includes(metadata.format ?? "")) {
        throw new Error("Unsupported image data");
      }
      return response.status(201).json({
        path: path.relative(projectRoot, request.file.path).split(path.sep).join("/"),
        name: request.file.originalname,
        bytes: request.file.size,
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        hasAlpha: metadata.hasAlpha ?? false
      });
    } catch {
      await unlink(request.file.path).catch(() => undefined);
      return response.status(400).json({ error: "The uploaded file is not a valid PNG, JPEG, or WebP image" });
    }
  });
  // Trust boundary: re-validate here even though the client already did. Credentials never leave this process.
  app.post("/api/runs", async (request, response, next) => {
    try {
      const brief = CampaignBriefSchema.parse(request.body?.brief);
      const runtime = await providerRuntime;
      const requestedProvider = request.body?.imageProvider;
      if (requestedProvider !== undefined && requestedProvider !== "sample"
        && (typeof requestedProvider !== "string" || !isProviderId(requestedProvider))) {
        return response.status(422).json({ error: "Choose a verified image provider or sample mode" });
      }
      const providerId = requestedProvider === "sample"
        ? null
        : typeof requestedProvider === "string" && isProviderId(requestedProvider)
        ? requestedProvider
        : runtime.status.selected;
      if (requestedProvider !== undefined && requestedProvider !== "sample" && !providerId) {
        return response.status(422).json({ error: "Choose a verified image provider or sample mode" });
      }
      const provider = requestedProvider === "sample" || !providerId ? null : runtime.providers[providerId];
      if (providerId && !provider) {
        return response.status(422).json({ error: "The selected image provider is not verified" });
      }
      const productsNeedingGeneration = brief.products.filter((product) => !product.approvedHeroPath && !product.cachedGeneratedHeroPath);
      if (!provider && productsNeedingGeneration.length) {
        return response.status(422).json({
          error: `${productsNeedingGeneration.map((product) => product.name).join(", ")} requires a verified image provider or cached sample`
        });
      }
      const report = await runPipeline(brief, { projectRoot, outputRoot, provider });
      response.status(201).json({
        report,
        workspace: await workspaceMetrics(outputRoot),
        downloadUrl: `/api/runs/${encodeURIComponent(brief.id)}/${encodeURIComponent(report.runId)}/download`
      });
    } catch (error) { next(error); }
  });
  app.get("/api/runs/:campaignId/:runId/download", async (request, response, next) => {
    try {
      const campaignId = safeName(request.params.campaignId);
      const runId = safeName(request.params.runId);
      const runDir = path.join(outputRoot, campaignId, runId);
      const reportPath = path.join(runDir, "report.json");
      await readFile(reportPath);
      response.attachment(`${campaignId}-${runId}.zip`);
      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", next);
      archive.pipe(response);
      archive.directory(runDir, false);
      await archive.finalize();
    } catch (error) { next(error); }
  });

  const dist = path.join(projectRoot, "dist");
  app.use(express.static(dist));
  app.get("/{*path}", (_request, response, next) => {
    const index = path.join(dist, "index.html");
    createReadStream(index).on("error", next).pipe(response.type("html"));
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    // Preflight failures ("stopped before generation") are 422: well-formed request, unacceptable content.
    const status = error instanceof multer.MulterError ? 400
      : message.includes("stopped before generation") || message.includes("brief") || message.includes("products") ? 422
      : 500;
    response.status(status).json({ error: message });
  });
  return app;
}

function isProviderId(value: string): value is ProviderId {
  return value === "firefly" || value === "openai" || value === "gemini";
}

function parseBrief(raw: string) {
  if (!raw.trim()) throw new Error("Campaign brief is empty");
  const parsed = raw.trimStart().startsWith("{") ? JSON.parse(raw) : parseYaml(raw);
  const result = CampaignBriefSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid campaign brief:\n${formatZodError(result.error)}`);
  return result.data;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

async function workspaceMetrics(outputRoot: string): Promise<{ campaigns: number; creatives: number; estimatedTimeSavedMinutes: number }> {
  try {
    const campaigns = await readdir(outputRoot, { withFileTypes: true });
    const reportPaths = (await Promise.all(campaigns.filter((entry) => entry.isDirectory()).map(async (campaign) => {
      const campaignRoot = path.join(outputRoot, campaign.name);
      const runs = await readdir(campaignRoot, { withFileTypes: true });
      return runs.filter((entry) => entry.isDirectory()).map((run) => path.join(campaignRoot, run.name, "report.json"));
    }))).flat();
    const reports = await Promise.all(reportPaths.map(async (reportPath) => {
      try {
        return JSON.parse(await readFile(reportPath, "utf8")) as { metrics?: { creatives?: number; timeSavedMinutes?: number } };
      } catch {
        return null;
      }
    }));
    return reports.reduce((summary, report) => {
      if (!report?.metrics) return summary;
      summary.campaigns += 1;
      summary.creatives += report.metrics.creatives ?? 0;
      summary.estimatedTimeSavedMinutes += report.metrics.timeSavedMinutes ?? 0;
      return summary;
    }, { campaigns: 0, creatives: 0, estimatedTimeSavedMinutes: 0 });
  } catch {
    return { campaigns: 0, creatives: 0, estimatedTimeSavedMinutes: 0 };
  }
}
