import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("HTTP API", () => {
  it("loads, runs, and packages the included sample without credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "campaign-forge-api-"));
    temporary.push(root);
    await mkdir(path.join(root, "samples"), { recursive: true });
    await cp(path.join(process.cwd(), "samples"), path.join(root, "samples"), { recursive: true });
    const app = createApp(root, {});

    const sample = await request(app).get("/api/sample").expect(200);
    expect(sample.body.brief.products).toHaveLength(2);
    const samples = await request(app).get("/api/samples").expect(200);
    expect(samples.body.briefs).toHaveLength(4);
    expect(samples.body.briefs[0].id).toBe("northline-europe-launch");
    expect(samples.body.briefs.find((brief: { id: string }) => brief.id === "northline-europe-launch").markets).toHaveLength(8);
    expect(samples.body.workspace.campaigns).toBe(0);
    const run = await request(app).post("/api/runs").send({ brief: sample.body.brief }).expect(201);
    expect(run.body.report.metrics.creatives).toBe(12);
    expect(run.body.workspace.campaigns).toBe(1);
    expect(run.body.report.warnings[0]).toContain("no live image generation occurred");
    await request(app).post("/api/runs").send({ brief: sample.body.brief, imageProvider: "gemini" }).expect(422);
    await request(app).get(run.body.downloadUrl).expect(200).expect("content-type", /zip/);
  }, 30_000);

  it("parses YAML and JSON briefs and rejects invalid input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "campaign-forge-parse-"));
    temporary.push(root);
    await mkdir(path.join(root, "samples"), { recursive: true });
    await cp(path.join(process.cwd(), "samples"), path.join(root, "samples"), { recursive: true });
    const app = createApp(root, {});
    const sample = await request(app).get("/api/sample").expect(200);
    const json = await request(app).post("/api/brief/parse").send({ raw: JSON.stringify(sample.body.brief) }).expect(200);
    expect(json.body.brief.products).toHaveLength(2);
    const schema = await request(app).get("/api/schema").expect(200);
    expect(schema.body.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.body.additionalProperties).toBe(false);
    await request(app).post("/api/brief/parse").send({ raw: JSON.stringify({ ...sample.body.brief, markets: [{ ...sample.body.brief.markets[0], locale: "not_a_locale" }] }) }).expect(422);
    await request(app).post("/api/brief/parse").send({ raw: "products: []" }).expect(422);
  });

  it("runs sample mode even when a verified live provider is selected by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "campaign-forge-sample-choice-"));
    temporary.push(root);
    await mkdir(path.join(root, "samples"), { recursive: true });
    await cp(path.join(process.cwd(), "samples"), path.join(root, "samples"), { recursive: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));
    const app = createApp(root, { GEMINI_API_KEY: "verified-test-key", IMAGE_PROVIDER: "gemini" });
    const sample = await request(app).get("/api/sample").expect(200);

    expect(sample.body.providers.selected).toBe("gemini");
    const run = await request(app).post("/api/runs").send({ brief: sample.body.brief, imageProvider: "sample" }).expect(201);
    expect(run.body.report.metrics.generatedSample).toBe(1);
    expect(run.body.report.metrics.generatedLive).toBe(0);
  }, 30_000);

  it("accepts supported image uploads and rejects other file types", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "campaign-forge-upload-"));
    temporary.push(root);
    const app = createApp(root, {});
    const image = await request(app)
      .post("/api/assets")
      .attach("asset", path.join(process.cwd(), "samples/assets/berry-charge-packshot.webp"))
      .expect(201);
    expect(image.body.path).toMatch(/^workspace\/uploads\//);
    await request(app).post("/api/assets").attach("asset", Buffer.from("not an image"), "notes.txt").expect(400);
  });
});
