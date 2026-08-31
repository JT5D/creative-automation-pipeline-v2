import { z } from "zod";

export const RatioSchema = z.enum(["1x1", "9x16", "16x9"]);
export type Ratio = z.infer<typeof RatioSchema>;

const LanguageTagSchema = z.string().min(2).max(35).refine(
  (value) => {
    try {
      return Intl.getCanonicalLocales(value).length === 1;
    } catch {
      return false;
    }
  },
  "Use a valid BCP 47 language tag such as en-US or fr-FR"
);

export const MarketSchema = z.object({
  locale: LanguageTagSchema,
  label: z.string().min(2),
  message: z.string().min(4).max(120),
  callToAction: z.string().min(2).max(32),
  disclaimer: z.string().max(140).optional()
}).strict();

export const ProductSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(2).max(64),
  description: z.string().min(4).max(160),
  approvedHeroPath: z.string().optional(),
  referenceAssetPath: z.string().optional(),
  cachedGeneratedHeroPath: z.string().optional(),
  generationPrompt: z.string().min(12).max(800).optional()
}).strict();

export const CampaignBriefSchema = z.object({
  schemaVersion: z.literal("1.0").default("1.0"),
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(3).max(80),
  region: z.string().min(2).max(80),
  audience: z.string().min(4).max(160),
  message: z.string().min(4).max(120),
  manualMinutesPerCreative: z.number().int().min(1).max(120).default(5),
  brand: z.object({
    name: z.string().min(2).max(40),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    prohibitedWords: z.array(z.string().min(2)).default([])
  }).strict(),
  products: z.array(ProductSchema).min(2, "The assignment requires at least two products"),
  markets: z.array(MarketSchema).min(1),
  ratios: z.array(RatioSchema).length(3).refine(
    (ratios) => new Set(ratios).size === 3 && ["1x1", "9x16", "16x9"].every((ratio) => ratios.includes(ratio as Ratio)),
    "Ratios must include 1x1, 9x16, and 16x9"
  )
}).strict().superRefine((brief, ctx) => {
  addDuplicateIssues(brief.products.map((product) => product.id), "products", ctx);
  addDuplicateIssues(brief.markets.map((market) => canonicalLocale(market.locale)), "markets", ctx);
});

export const CampaignBriefJsonSchema = {
  ...z.toJSONSchema(CampaignBriefSchema, { target: "draft-2020-12" }),
  $id: "https://campaign-forge.local/schemas/campaign-brief-1.0.json",
  title: "Campaign Forge campaign brief",
  description: "Strict, versioned campaign input contract with BCP 47 market locales."
};

export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Market = z.infer<typeof MarketSchema>;

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "brief"}: ${issue.message}`).join("\n");
}

function canonicalLocale(value: string): string {
  try {
    return Intl.getCanonicalLocales(value)[0]?.toLowerCase() ?? value.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function addDuplicateIssues(
  values: string[],
  field: "products" | "markets",
  ctx: z.RefinementCtx
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({
        code: "custom",
        path: [field, index, field === "products" ? "id" : "locale"],
        message: field === "products" ? "Product IDs must be unique" : "Market locales must be unique"
      });
    }
    seen.add(value);
  });
}
