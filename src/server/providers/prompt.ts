import type { GenerateRequest } from "./types.js";

export function buildGenerationPrompt({ brief, product }: GenerateRequest): string {
  const base = product.generationPrompt ??
    `Premium editorial product photography for ${product.name}. ${product.description}.`;

  const assetDirection = product.referenceAssetPath
    ? "Generate only the environment and lighting plate: no product, can, package, label, or logo. Leave a clean placement area in the lower-right; the approved transparent packshot will be composited there by code."
    : "Keep the complete product in the lower-right area, with its cap and base fully visible and clear margin on every side.";

  return [
    base,
    `Campaign: ${brief.name}. Market: ${brief.region}. Audience: ${brief.audience}.`,
    `Brand palette: ${brief.brand.primaryColor} and ${brief.brand.secondaryColor}.`,
    `Square campaign master. ${assetDirection}`,
    "This square master will be adapted to square, story, and landscape layouts. Reserve clean negative space in the left and upper areas for code-rendered campaign copy.",
    "No headline, promotional copy, watermark, extra product, or real-world logo in the generated scene."
  ].join(" ");
}
