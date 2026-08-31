import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CampaignBriefSchema, type CampaignBrief } from "../src/shared/schema.js";
import { renderOverlay, runPipeline } from "../src/server/pipeline.js";
import type { ImageProvider } from "../src/server/providers/index.js";

const projectRoot = path.resolve(process.cwd());
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function sampleBrief(): Promise<CampaignBrief> {
  const raw = await readFile(path.join(projectRoot, "samples", "campaign.yaml"), "utf8");
  return CampaignBriefSchema.parse(parseYaml(raw));
}

describe("creative pipeline", () => {
  it("adapts landscape headline wrapping to the brief and centers CTA text geometrically", async () => {
    const brief = await sampleBrief();
    const market = { ...brief.markets[0], message: "Bright energy. Ready anywhere.", callToAction: "Discover now" };
    const overlay = renderOverlay({ brief, market, ratio: "16x9" }, 1920, 1080);

    expect(overlay.svg).toContain(">BRIGHT ENERGY.</text>");
    expect(overlay.svg).toContain(">READY ANYWHERE.</text>");
    expect(overlay.svg).toContain('text-anchor="middle"');
    expect(overlay.copyFits).toBe(true);

    const continuousMessage = renderOverlay({
      brief,
      market: { ...market, message: "One compact promise for every market" },
      ratio: "16x9"
    }, 1920, 1080);
    expect(continuousMessage.svg).toContain(">ONE COMPACT PROMISE</text>");
    expect(continuousMessage.svg).toContain(">FOR EVERY MARKET</text>");
    expect(continuousMessage.copyFits).toBe(true);
  });

  it("produces every product × locale × required aspect ratio with organized outputs", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "campaign-forge-"));
    temporary.push(outputRoot);
    const report = await runPipeline(await sampleBrief(), { projectRoot, outputRoot, provider: null });

    expect(report.metrics.products).toBe(2);
    expect(report.metrics.campaigns).toBe(1);
    expect(report.metrics.creatives).toBe(12);
    expect(report.metrics.reused).toBe(1);
    expect(report.metrics.generatedSample).toBe(1);
    expect(report.metrics.manualMinutesPerCreative).toBe(5);
    expect(report.metrics.creativesPerMinute).toBeGreaterThan(0);
    expect(report.verification.threeRatios).toBe(true);
    expect(report.verification.messageRendered).toBe(true);
    expect(report.verification.organizedOutputs).toBe(true);
    expect(report.compliance.every((check) => check.passed)).toBe(true);
    expect(report.compliance.map((check) => check.id)).toEqual(expect.arrayContaining(["contrast", "copy-fit", "framing", "safe-zone"]));
    expect(report.compliance.find((check) => check.id === "framing")?.evidence).toContain("without pipeline cropping");

    const citrus = report.products.find((product) => product.productId === "citrus-lift")!;
    expect(new Set(citrus.creatives.map((creative) => creative.ratio))).toEqual(new Set(["1x1", "9x16", "16x9"]));
    expect(citrus.creatives.find((creative) => creative.ratio === "9x16")?.height).toBe(1920);
    await expect(readFile(path.join(outputRoot, citrus.creatives[0].outputPath.slice(1)))).resolves.toBeInstanceOf(Buffer);
  }, 30_000);

  it("stops prohibited copy before calling a paid image provider", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "campaign-forge-legal-"));
    temporary.push(outputRoot);
    const brief = await sampleBrief();
    brief.message = "A miracle energy cure";
    let calls = 0;
    const provider: ImageProvider = {
      name: "test-provider",
      model: "test-model",
      async generate() {
        calls += 1;
        throw new Error("Provider must not be called");
      }
    };

    await expect(runPipeline(brief, { projectRoot, outputRoot, provider })).rejects.toThrow("stopped before generation");
    expect(calls).toBe(0);
  });

  it("stops copy that cannot fit before calling a paid image provider", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "campaign-forge-copy-"));
    temporary.push(outputRoot);
    const brief = await sampleBrief();
    brief.markets[0].message = "X".repeat(80);
    let calls = 0;
    const provider: ImageProvider = {
      name: "test-provider",
      model: "test-model",
      async generate() {
        calls += 1;
        throw new Error("Provider must not be called");
      }
    };

    await expect(runPipeline(brief, { projectRoot, outputRoot, provider })).rejects.toThrow("does not fit");
    expect(calls).toBe(0);
  });

  it("stops inaccessible brand tokens before calling a paid image provider", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "campaign-forge-contrast-"));
    temporary.push(outputRoot);
    const brief = await sampleBrief();
    brief.brand.primaryColor = "#EEEEEE";
    let calls = 0;
    const provider: ImageProvider = {
      name: "test-provider",
      model: "test-model",
      async generate() {
        calls += 1;
        throw new Error("Provider must not be called");
      }
    };

    await expect(runPipeline(brief, { projectRoot, outputRoot, provider })).rejects.toThrow("contrast threshold");
    expect(calls).toBe(0);
  });

  it("preserves a supplied transparent packshot on a live-generated background", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "campaign-forge-live-"));
    temporary.push(outputRoot);
    const brief = await sampleBrief();
    const provider: ImageProvider = {
      name: "test-provider",
      model: "test-model",
      async generate() {
        return {
          bytes: await readFile(path.join(projectRoot, "samples/assets/citrus-lift-approved-hero.webp")),
          mimeType: "image/png",
          provider: "test-provider",
          model: "test-model",
          prompt: "test background",
          requestId: "request-1"
        };
      }
    };

    const report = await runPipeline(brief, { projectRoot, outputRoot, provider });
    const berry = report.products.find((product) => product.productId === "berry-charge")!;

    expect(berry.source).toBe("generated-live");
    expect(berry.provider).toBe("test-provider");
    expect(report.events.some((event) => event.label === "Approved packshot composited")).toBe(true);
    await expect(readFile(path.join(outputRoot, berry.heroPath))).resolves.toBeInstanceOf(Buffer);
  }, 30_000);
});
