import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { CampaignBriefSchema, type CampaignBrief, type Market, type Product, type Ratio } from "../shared/schema.js";
import type { AssetSource, CampaignReport, ComplianceCheck, PipelineEvent, ProductResult } from "../shared/types.js";
import { scanLegal } from "./legal.js";
import type { ImageProvider } from "./providers/index.js";

const FORMAT: Record<Ratio, { width: number; height: number }> = {
  "1x1": { width: 1080, height: 1080 },
  "9x16": { width: 1080, height: 1920 },
  "16x9": { width: 1920, height: 1080 }
};

const HERO_ZONE: Record<Ratio, { left: number; top: number; width: number; height: number }> = {
  "1x1": { left: 0, top: 0, width: 1080, height: 1080 },
  "9x16": { left: 0, top: 840, width: 1080, height: 1080 },
  "16x9": { left: 800, top: 0, width: 1120, height: 1080 }
};

export type RunPipelineOptions = {
  projectRoot: string;
  outputRoot: string;
  provider?: ImageProvider | null;
  now?: () => Date;
};

export async function runPipeline(input: CampaignBrief, options: RunPipelineOptions): Promise<CampaignReport> {
  const brief = CampaignBriefSchema.parse(input);
  const now = options.now ?? (() => new Date());
  const started = now();
  const runId = `${started.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const campaignDir = path.join(options.outputRoot, safeSegment(brief.id), safeSegment(runId));
  const events: PipelineEvent[] = [];
  const warnings: string[] = [];
  const event = (stage: PipelineEvent["stage"], label: string, detail?: string, productId?: string) => {
    events.push({ at: now().toISOString(), stage, label, detail, productId });
  };

  event("brief", "Brief validated", `${brief.products.length} products · ${brief.ratios.length} formats`);
  const legal = scanLegal(brief);
  event("preflight", "Legal preflight complete", legal.passed ? "No prohibited language" : `${legal.matches.length} issue(s)`);
  if (!legal.passed) {
    const detail = legal.matches.map((match) => `“${match.term}” in ${match.field}`).join(", ");
    throw new Error(`Campaign stopped before generation: ${detail}`);
  }

  const contrast = evaluateTokenContrast(brief.brand.primaryColor, brief.brand.secondaryColor);
  event("preflight", "Contrast preflight complete", contrast.evidence);
  if (!contrast.passed) {
    throw new Error(`Campaign stopped before generation: brand colors fail the 4.5:1 text-token contrast threshold (${contrast.evidence})`);
  }

  const copyProblems = brief.ratios.flatMap((ratio) => brief.markets.flatMap((market) => {
    const format = FORMAT[ratio];
    return renderOverlay({ brief, market, ratio }, format.width, format.height).copyFits
      ? []
      : [`${market.locale} ${ratio.replace("x", ":")}`];
  }));
  event("preflight", "Copy-fit preflight complete", copyProblems.length ? `${copyProblems.length} issue(s)` : "All messages fit");
  if (copyProblems.length) {
    throw new Error(`Campaign stopped before generation: message, CTA, or disclaimer does not fit ${copyProblems.join(", ")}`);
  }

  await mkdir(campaignDir, { recursive: true });
  const results: ProductResult[] = [];

  for (const product of brief.products) {
    event("asset", "Resolving source asset", undefined, product.id);
    const hero = await resolveHero(brief, product, options, campaignDir, event, warnings);
    const creatives = [];
    for (const ratio of brief.ratios) {
      for (const market of brief.markets) {
        event("compose", `Composing ${ratio.replace("x", ":")} · ${market.locale}`, undefined, product.id);
        const creative = await composeCreative({ brief, product, market, ratio, heroPath: hero.heroPath, campaignDir, outputRoot: options.outputRoot });
        creatives.push(creative);
      }
    }
    results.push({
      productId: product.id,
      productName: product.name,
      source: hero.source,
      provider: hero.provider,
      model: hero.model,
      prompt: hero.prompt,
      heroPath: relativePortable(options.outputRoot, hero.heroPath),
      creatives
    });
  }

  event("compliance", "Outputs checked", "Brand lockup, palette, token contrast, legal copy, copy fit, product framing, safe zones, and dimensions");
  const completed = now();
  const creatives = results.flatMap((product) => product.creatives);
  const summaryChecks: ComplianceCheck[] = [
    { id: "brand", label: "Brand lockup", passed: creatives.every((item) => item.checks.find((check) => check.id === "brand")?.passed), evidence: `${creatives.length}/${creatives.length} creatives include the code-rendered brand name` },
    { id: "palette", label: "Brand palette", passed: creatives.every((item) => item.checks.find((check) => check.id === "palette")?.passed), evidence: `Templates use ${brief.brand.primaryColor} and ${brief.brand.secondaryColor}` },
    { id: "contrast", label: "Token contrast", passed: contrast.passed, evidence: contrast.evidence },
    { id: "legal", label: "Legal copy", passed: legal.passed, evidence: `${brief.brand.prohibitedWords.length} prohibited terms checked before provider spend` },
    { id: "copy-fit", label: "Copy fit", passed: creatives.every((item) => item.checks.find((check) => check.id === "copy-fit")?.passed), evidence: `${creatives.length}/${creatives.length} creatives passed message, CTA, and disclaimer fit checks` },
    { id: "framing", label: "Hero framing", passed: creatives.every((item) => item.checks.find((check) => check.id === "framing")?.passed), evidence: `${creatives.length}/${creatives.length} creatives contain the complete source hero without pipeline cropping` },
    { id: "safe-zone", label: "Story safe zone", passed: creatives.filter((item) => item.ratio === "9x16").every((item) => item.checks.find((check) => check.id === "safe-zone")?.passed), evidence: "9:16 brand and legal copy stay clear of common story UI zones" },
    { id: "dimensions", label: "Channel dimensions", passed: creatives.every((item) => item.checks.find((check) => check.id === "dimensions")?.passed), evidence: "1:1 1080×1080 · 9:16 1080×1920 · 16:9 1920×1080" }
  ];
  const elapsedMs = Math.max(1, completed.getTime() - started.getTime());
  const estimatedManualMinutes = creatives.length * brief.manualMinutesPerCreative;
  const generatedLive = results.filter((result) => result.source === "generated-live").length;
  const generatedSample = results.filter((result) => result.source === "generated-sample").length;
  event("complete", "Review ready", `${creatives.length} creatives saved`);

  const report: CampaignReport = {
    runId,
    campaign: { id: brief.id, name: brief.name, region: brief.region, audience: brief.audience, message: brief.message },
    status: "completed",
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    metrics: {
      campaigns: 1,
      products: results.length,
      creatives: creatives.length,
      reused: results.filter((result) => result.source === "approved").length,
      generatedLive,
      generatedSample,
      elapsedMs,
      manualMinutesPerCreative: brief.manualMinutesPerCreative,
      estimatedManualMinutes,
      timeSavedMinutes: Math.max(0, estimatedManualMinutes - Math.ceil(elapsedMs / 60_000)),
      creativesPerMinute: Number((creatives.length / (elapsedMs / 60_000)).toFixed(1))
    },
    products: results,
    compliance: summaryChecks,
    events,
    verification: {
      twoProducts: brief.products.length >= 2,
      threeRatios: new Set(creatives.map((creative) => creative.ratio)).size === 3,
      messageRendered: creatives.every((creative) => creative.checks.find((check) => check.id === "copy-fit")?.passed),
      organizedOutputs: results.every((product) => product.creatives.every((creative) => creative.outputPath.includes(`/${product.productId}/`))),
      imageGeneration: generatedLive > 0 ? "live" : generatedSample > 0 ? "sample" : "unavailable"
    },
    warnings
  };
  await writeFile(path.join(campaignDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function resolveHero(
  brief: CampaignBrief,
  product: Product,
  options: RunPipelineOptions,
  campaignDir: string,
  emit: (stage: PipelineEvent["stage"], label: string, detail?: string, productId?: string) => void,
  warnings: string[]
): Promise<{ heroPath: string; source: AssetSource; provider: string; model?: string; prompt?: string }> {
  const productDir = path.join(campaignDir, safeSegment(product.id));
  const sourceDir = path.join(productDir, "source");
  await mkdir(sourceDir, { recursive: true });

  if (product.approvedHeroPath) {
    const source = await resolveProjectFile(options.projectRoot, product.approvedHeroPath);
    const destination = path.join(sourceDir, `approved-hero${path.extname(source) || ".png"}`);
    await writeFile(destination, await readFile(source));
    emit("asset", "Approved hero reused", path.basename(product.approvedHeroPath), product.id);
    return { heroPath: destination, source: "approved", provider: "approved-asset" };
  }

  if (options.provider) {
    emit("generate", `Generating with ${options.provider.name}`, options.provider.model, product.id);
    const generated = await options.provider.generate({ brief, product });
    const extension = generated.mimeType === "image/jpeg" ? ".jpg" : ".png";
    const background = path.join(sourceDir, `generated-background${extension}`);
    const destination = path.join(sourceDir, "generated-hero.png");
    await writeFile(background, generated.bytes);
    if (product.referenceAssetPath) {
      const reference = await resolveProjectFile(options.projectRoot, product.referenceAssetPath);
      await compositeReferenceAsset(background, reference, destination);
      emit("asset", "Approved packshot composited", path.basename(product.referenceAssetPath), product.id);
    } else {
      await writeFile(destination, generated.bytes);
    }
    emit("generate", "Live generation complete", generated.requestId, product.id);
    return { heroPath: destination, source: "generated-live", provider: generated.provider, model: generated.model, prompt: generated.prompt };
  }

  if (product.cachedGeneratedHeroPath) {
    const source = await resolveProjectFile(options.projectRoot, product.cachedGeneratedHeroPath);
    const destination = path.join(sourceDir, `generated-sample${path.extname(source) || ".png"}`);
    await writeFile(destination, await readFile(source));
    const warning = `${product.name}: using the included cached sample; no live image generation occurred in this run.`;
    warnings.push(warning);
    emit("generate", "Cached sample loaded", "Sample mode makes no provider call", product.id);
    return { heroPath: destination, source: "generated-sample", provider: "sample-asset" };
  }

  throw new Error(`${product.name} has no approved hero and no live image provider is configured`);
}

async function compositeReferenceAsset(backgroundPath: string, referencePath: string, destination: string): Promise<void> {
  const size = 1254;
  const productHeight = Math.round(size * 0.5);
  const product = await sharp(referencePath)
    .resize({ height: productHeight, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.max(Math.round(size * 0.48), size - product.info.width - 72);
  const top = Math.max(24, size - product.info.height - 96);
  await sharp(backgroundPath)
    .resize(size, size, { fit: "cover" })
    .composite([{ input: product.data, left, top }])
    .png({ compressionLevel: 8 })
    .toFile(destination);
}

async function composeCreative(input: {
  brief: CampaignBrief;
  product: Product;
  market: Market;
  ratio: Ratio;
  heroPath: string;
  campaignDir: string;
  outputRoot: string;
}) {
  const format = FORMAT[input.ratio];
  const destinationDir = path.join(input.campaignDir, safeSegment(input.product.id), input.ratio);
  await mkdir(destinationDir, { recursive: true });
  const outputPath = path.join(destinationDir, `${safeSegment(input.market.locale)}.png`);
  const overlay = renderOverlay(input, format.width, format.height);
  const base = await createCropSafeBase(input.heroPath, input.ratio, input.brief.brand.primaryColor);
  const buffer = await sharp(base.buffer)
    .composite([{ input: Buffer.from(overlay.svg), top: 0, left: 0 }])
    .png({ compressionLevel: 8 })
    .toBuffer();
  await writeFile(outputPath, buffer);
  const metadata = await sharp(buffer).metadata();
  const paletteApplied = overlay.svg.includes(input.brief.brand.primaryColor)
    && overlay.svg.includes(input.brief.brand.secondaryColor);
  const legal = scanLegal(input.brief);
  const checks: ComplianceCheck[] = [
    { id: "brand", label: "Brand lockup", passed: Boolean(input.brief.brand.name), evidence: `Brand name “${input.brief.brand.name}” rendered by template` },
    { id: "palette", label: "Brand palette", passed: paletteApplied, evidence: `${input.brief.brand.primaryColor} / ${input.brief.brand.secondaryColor} embedded in overlay` },
    { id: "contrast", label: "Token contrast", passed: evaluateTokenContrast(input.brief.brand.primaryColor, input.brief.brand.secondaryColor).passed, evidence: evaluateTokenContrast(input.brief.brand.primaryColor, input.brief.brand.secondaryColor).evidence },
    { id: "legal", label: "Legal copy", passed: legal.passed, evidence: `${input.brief.brand.prohibitedWords.length} prohibited terms checked before composition` },
    { id: "copy-fit", label: "Copy fit", passed: overlay.copyFits, evidence: "Message, CTA, and disclaimer fit their template regions" },
    { id: "framing", label: "Hero framing", passed: base.framingPassed, evidence: base.framingEvidence },
    { id: "safe-zone", label: "Story safe zone", passed: overlay.safeZonePassed, evidence: input.ratio === "9x16" ? "Brand and legal copy stay within y=220–1700" : "Not applicable outside 9:16" },
    { id: "dimensions", label: "Channel dimensions", passed: metadata.width === format.width && metadata.height === format.height, evidence: `${metadata.width}×${metadata.height}` }
  ];
  const portable = relativePortable(input.outputRoot, outputPath);
  return {
    ratio: input.ratio,
    locale: input.market.locale,
    width: format.width,
    height: format.height,
    outputPath: `/${portable}`,
    publicUrl: `/outputs/${portable}`,
    bytes: buffer.length,
    checks
  };
}

async function createCropSafeBase(heroPath: string, ratio: Ratio, primaryColor: string): Promise<{
  buffer: Buffer;
  framingPassed: boolean;
  framingEvidence: string;
}> {
  const format = FORMAT[ratio];
  const zone = HERO_ZONE[ratio];
  const source = await sharp(heroPath).metadata();
  if (!source.width || !source.height) throw new Error(`Cannot inspect hero dimensions: ${heroPath}`);
  const scale = Math.min(zone.width / source.width, zone.height / source.height);
  const renderedWidth = Math.round(source.width * scale);
  const renderedHeight = Math.round(source.height * scale);
  const hero = await sharp(heroPath)
    .resize(zone.width, zone.height, { fit: "contain", background: primaryColor })
    .png()
    .toBuffer();
  const buffer = await sharp({
    create: { width: format.width, height: format.height, channels: 4, background: primaryColor }
  })
    .composite([{ input: hero, left: zone.left, top: zone.top }])
    .png()
    .toBuffer();
  const framingPassed = renderedWidth <= zone.width && renderedHeight <= zone.height;
  const placement = ratio === "9x16" ? "lower story zone" : ratio === "16x9" ? "right landscape panel" : "square canvas";
  return {
    buffer,
    framingPassed,
    framingEvidence: `${source.width}×${source.height} source contained at ${renderedWidth}×${renderedHeight} in ${placement}`
  };
}

export function renderOverlay(
  { brief, market, ratio }: { brief: CampaignBrief; market: Market; ratio: Ratio },
  width: number,
  height: number
): { svg: string; copyFits: boolean; safeZonePassed: boolean } {
  const isVertical = ratio === "9x16";
  const isLandscape = ratio === "16x9";
  const margin = Math.round(width * 0.055);
  const titleSize = isVertical ? 86 : isLandscape ? 78 : 76;
  const maxChars = isVertical ? 18 : isLandscape ? 21 : 18;
  const messageLayout = fitHeadline(market.message.toUpperCase(), maxChars, 4, isLandscape);
  const titleY = isVertical ? 470 : 300;
  const lineHeight = Math.round(titleSize * 0.93);
  const titleWidth = isLandscape ? Math.round(width * 0.42) : Math.round(width * 0.68);
  const scrimWidth = isLandscape ? Math.round(width * 0.53) : width;
  const scrimHeight = isVertical ? Math.round(height * 0.56) : height;
  const brandY = isVertical ? 280 : 86;
  const footerFontSize = isVertical ? 27 : 24;
  const footerLineHeight = footerFontSize + 7;
  const footerText = `${market.label} · ${market.disclaimer ?? brief.audience}`;
  const footerLayout = fitText(footerText, isVertical ? 54 : isLandscape ? 118 : 58, 2);
  const footerLastY = isVertical ? 1640 : height - Math.max(48, Math.round(height * 0.035));
  const footerFirstY = footerLastY - (footerLayout.lines.length - 1) * footerLineHeight;
  const ctaWidth = market.callToAction.length * 18 + 68;
  const renderedCtaWidth = Math.min(titleWidth, ctaWidth);
  const gradient = isLandscape
    ? `<linearGradient id="scrim" x1="0" x2="1"><stop offset="0" stop-color="${brief.brand.primaryColor}" stop-opacity=".96"/><stop offset=".82" stop-color="${brief.brand.primaryColor}" stop-opacity=".12"/><stop offset="1" stop-color="${brief.brand.primaryColor}" stop-opacity="0"/></linearGradient>`
    : `<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${brief.brand.primaryColor}" stop-opacity=".94"/><stop offset=".76" stop-color="${brief.brand.primaryColor}" stop-opacity=".18"/><stop offset="1" stop-color="${brief.brand.primaryColor}" stop-opacity="0"/></linearGradient>`;
  const title = messageLayout.lines.map((line, index) =>
    `<text x="${margin}" y="${titleY + index * lineHeight}" fill="#fff" font-family="Arial, sans-serif" font-weight="900" font-size="${titleSize}" letter-spacing="-2">${escapeXml(line)}</text>`
  ).join("");
  const footer = footerLayout.lines.map((line, index) =>
    `<text x="${margin}" y="${footerFirstY + index * footerLineHeight}" fill="#fff" fill-opacity=".9" font-family="Arial, sans-serif" font-size="${footerFontSize}">${escapeXml(line)}</text>`
  ).join("");
  const ctaY = titleY + messageLayout.lines.length * lineHeight + 54;
  const copyFits = messageLayout.fits && footerLayout.fits && ctaWidth <= titleWidth;
  const safeZonePassed = !isVertical || (brandY - 52 >= 220 && footerLastY + 20 <= 1700 && ctaY + 34 <= 1700);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>${gradient}</defs>
    <rect width="${scrimWidth}" height="${scrimHeight}" fill="url(#scrim)"/>
    <text x="${margin}" y="${brandY}" fill="#fff" font-family="Arial, sans-serif" font-weight="800" font-size="${isVertical ? 48 : 40}" letter-spacing="8">${escapeXml(brief.brand.name.toUpperCase())}</text>
    <rect x="${margin}" y="${titleY - titleSize}" width="8" height="${Math.max(titleSize, messageLayout.lines.length * lineHeight - 10)}" fill="${brief.brand.secondaryColor}"/>
    <g transform="translate(${24},0)">${title}</g>
    <rect x="${margin}" y="${ctaY - 39}" width="${renderedCtaWidth}" height="68" rx="5" fill="${brief.brand.secondaryColor}"/>
    <text x="${margin + renderedCtaWidth / 2}" y="${ctaY + 8}" text-anchor="middle" fill="#111" font-family="Arial, sans-serif" font-weight="800" font-size="30">${escapeXml(market.callToAction.toUpperCase())}</text>
    <rect x="${margin - 14}" y="${footerFirstY - footerFontSize - 9}" width="${width - margin * 2 + 28}" height="${footerLayout.lines.length * footerLineHeight + 16}" rx="5" fill="${brief.brand.primaryColor}" fill-opacity=".7"/>
    ${footer}
  </svg>`;
  return { svg, copyFits, safeZonePassed };
}

function fitHeadline(value: string, maxChars: number, maxLines: number, preferSentenceLines: boolean): { lines: string[]; fits: boolean } {
  if (preferSentenceLines) {
    const sentences = value.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
    if (sentences.length > 1 && sentences.length <= maxLines && sentences.every((sentence) => sentence.length <= maxChars)) {
      return { lines: sentences, fits: true };
    }
  }
  return fitText(value, maxChars, maxLines);
}

function fitText(value: string, maxChars: number, maxLines: number): { lines: string[]; fits: boolean } {
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars || !line) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return { lines: lines.slice(0, maxLines), fits: lines.length <= maxLines && lines.every((item) => item.length <= maxChars) };
}

async function resolveProjectFile(projectRoot: string, relativePath: string): Promise<string> {
  const candidate = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Asset path leaves the project workspace: ${relativePath}`);
  await access(candidate);
  return candidate;
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function relativePortable(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" })[character]!);
}

function evaluateTokenContrast(primaryColor: string, secondaryColor: string): { passed: boolean; evidence: string } {
  const primaryRatio = contrastRatio("#FFFFFF", primaryColor);
  const secondaryRatio = contrastRatio("#111111", secondaryColor);
  return {
    passed: primaryRatio >= 4.5 && secondaryRatio >= 4.5,
    evidence: `White/primary ${primaryRatio.toFixed(2)}:1 · dark/secondary ${secondaryRatio.toFixed(2)}:1`
  };
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}
