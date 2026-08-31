import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Box,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Download,
  FileCheck2,
  FolderInput,
  Image as ImageIcon,
  Languages,
  LoaderCircle,
  MoreVertical,
  RefreshCw,
  Sparkles,
  Upload,
  Zap
} from "lucide-react";
import type { CampaignBrief, Market, Ratio } from "../shared/schema.js";
import type { AssetSource, CampaignReport, ComplianceCheck, ProductResult } from "../shared/types.js";

type ProviderStatus = {
  selected: "firefly" | "openai" | "gemini" | null;
  fireflyConfigured: boolean;
  openAIConfigured: boolean;
  geminiConfigured: boolean;
  verificationError?: string;
};

type WorkspaceMetrics = { campaigns: number; creatives: number; estimatedTimeSavedMinutes: number };
type SamplesPayload = { briefs: CampaignBrief[]; providers: ProviderStatus; workspace: WorkspaceMetrics };

export function App() {
  const [brief, setBrief] = useState<CampaignBrief | null>(null);
  const [sampleBriefs, setSampleBriefs] = useState<CampaignBrief[]>([]);
  const [workspaceMetrics, setWorkspaceMetrics] = useState<WorkspaceMetrics | null>(null);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [activeProductId, setActiveProductId] = useState("");
  const [activeRatio, setActiveRatio] = useState<Ratio>("1x1");
  const [activeLocale, setActiveLocale] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [briefEditorOpen, setBriefEditorOpen] = useState(false);
  const [briefDraft, setBriefDraft] = useState("");
  const [briefEditorError, setBriefEditorError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const assetInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetch("/api/samples")
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load example campaigns");
        return response.json() as Promise<SamplesPayload>;
      })
      .then((payload) => {
        const initial = payload.briefs[0];
        if (!initial) throw new Error("No example campaigns are available");
        setSampleBriefs(payload.briefs);
        setBrief(initial);
        setProviders(payload.providers);
        setWorkspaceMetrics(payload.workspace);
        setActiveProductId(initial.products[0]?.id ?? "");
        setActiveLocale(initial.markets[0]?.locale ?? "");
      })
      .catch((reason: unknown) => setError(toMessage(reason)))
      .finally(() => setLoading(false));
  }, []);

  const activeProduct = brief?.products.find((product) => product.id === activeProductId) ?? brief?.products[0];
  const activeMarket = brief?.markets.find((market) => market.locale === activeLocale) ?? brief?.markets[0];
  const productResult = report?.products.find((product) => product.productId === activeProduct?.id);
  const creative = productResult?.creatives.find((item) => item.ratio === activeRatio && item.locale === activeLocale)
    ?? productResult?.creatives.find((item) => item.ratio === activeRatio)
    ?? productResult?.creatives[0];
  const previewUrl = creative?.publicUrl ?? fallbackPreview(activeProduct?.id);
  const metrics = useMemo(() => {
    if (report) return report.metrics;
    const products = brief?.products.length ?? 0;
    const creatives = products * (brief?.ratios.length ?? 0) * (brief?.markets.length ?? 0);
    const manualMinutesPerCreative = brief?.manualMinutesPerCreative ?? 5;
    return {
      campaigns: 0,
      products,
      creatives,
      reused: brief?.products.filter((item) => item.approvedHeroPath).length ?? 0,
      generatedLive: 0,
      generatedSample: brief?.products.filter((item) => item.cachedGeneratedHeroPath).length ?? 0,
      elapsedMs: 0,
      manualMinutesPerCreative,
      estimatedManualMinutes: creatives * manualMinutesPerCreative,
      timeSavedMinutes: 0,
      creativesPerMinute: 0
    };
  }, [brief, report]);

  async function generateCampaign() {
    if (!brief || running) return;
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief })
      });
      const payload = await response.json() as { report?: CampaignReport; workspace?: WorkspaceMetrics; downloadUrl?: string; error?: string };
      if (!response.ok || !payload.report) throw new Error(payload.error ?? "Campaign generation failed");
      setReport(payload.report);
      if (payload.workspace) setWorkspaceMetrics(payload.workspace);
      setDownloadUrl(payload.downloadUrl ?? null);
      setActiveProductId(payload.report.products[0]?.productId ?? activeProductId);
      setActiveRatio("1x1");
      setActiveLocale(brief.markets[0]?.locale ?? activeLocale);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setRunning(false);
    }
  }

  async function importBrief(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const response = await fetch("/api/brief/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: await file.text() })
      });
      const payload = await response.json() as { brief?: CampaignBrief; error?: string };
      if (!response.ok || !payload.brief) throw new Error(payload.error ?? "Brief import failed");
      setBrief(payload.brief);
      setReport(null);
      setDownloadUrl(null);
      setActiveProductId(payload.brief.products[0]?.id ?? "");
      setActiveLocale(payload.brief.markets[0]?.locale ?? "");
    } catch (reason) { setError(toMessage(reason)); }
  }

  function openBriefEditor() {
    if (!brief) return;
    setBriefDraft(JSON.stringify(brief, null, 2));
    setBriefEditorOpen(true);
    setBriefEditorError(null);
    setError(null);
  }

  async function applyBriefDraft() {
    setBriefEditorError(null);
    try {
      const response = await fetch("/api/brief/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: briefDraft })
      });
      const payload = await response.json() as { brief?: CampaignBrief; error?: string };
      if (!response.ok || !payload.brief) throw new Error(payload.error ?? "Brief validation failed");
      setBrief(payload.brief);
      setReport(null);
      setDownloadUrl(null);
      setActiveProductId(payload.brief.products[0]?.id ?? "");
      setActiveLocale(payload.brief.markets[0]?.locale ?? "");
      setActiveRatio("1x1");
      setBriefEditorOpen(false);
    } catch (reason) {
      setBriefEditorError(toMessage(reason));
    }
  }

  async function uploadAsset(file: File | undefined) {
    if (!file || !brief || !activeProduct) return;
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("asset", file);
      const response = await fetch("/api/assets", { method: "POST", body });
      const payload = await response.json() as { path?: string; error?: string };
      if (!response.ok || !payload.path) throw new Error(payload.error ?? "Asset upload failed");
      setBrief({
        ...brief,
        products: brief.products.map((product) => product.id === activeProduct.id
          ? { ...product, approvedHeroPath: payload.path }
          : product)
      });
      setReport(null);
      setDownloadUrl(null);
    } catch (reason) { setError(toMessage(reason)); }
    finally { setUploading(false); }
  }

  function updateBrief<K extends keyof CampaignBrief>(key: K, value: CampaignBrief[K]) {
    if (!brief) return;
    setBrief({ ...brief, [key]: value });
    setReport(null);
    setDownloadUrl(null);
  }

  function updateMarket<K extends keyof Market>(key: K, value: Market[K]) {
    setBrief((current) => current ? {
      ...current,
      markets: current.markets.map((market) => market.locale === activeLocale ? { ...market, [key]: value } : market)
    } : current);
    setReport(null);
    setDownloadUrl(null);
  }

  function selectExample(id: string) {
    const selected = sampleBriefs.find((item) => item.id === id);
    if (!selected) return;
    setBrief(selected);
    setReport(null);
    setDownloadUrl(null);
    setActiveProductId(selected.products[0]?.id ?? "");
    setActiveLocale(selected.markets[0]?.locale ?? "");
    setActiveRatio("1x1");
  }

  if (loading) return <LoadingScreen />;
  if (!brief) return <FatalError message={error ?? "Campaign brief unavailable"} />;

  const compliance = report?.compliance ?? defaultCompliance();
  const progress = report ? 4 : running ? 3 : 2;
  const displayedMetrics = { ...metrics, campaigns: workspaceMetrics?.campaigns ?? metrics.campaigns };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-cluster">
          <div className="app-mark" aria-hidden="true">CF</div>
          <strong>Campaign Forge</strong>
          <span className="top-divider" />
          <span className="workspace-label">Local workspace <ChevronDown size={14} /></span>
        </div>
        <button className="icon-button mobile-only" aria-label="More options"><MoreVertical /></button>
        <button className="primary-action desktop-action" onClick={generateCampaign} disabled={running}>
          {running ? <LoaderCircle className="spin" /> : <Sparkles />}
          {running ? "Generating…" : "Generate campaign"}
        </button>
      </header>

      <WorkflowRail progress={progress} />

      {error && (
        <div className="error-banner" role="alert">
          <CircleAlert size={18} />
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error">×</button>
        </div>
      )}

      <main className="workspace-grid">
        <section className="brief-panel">
          <div className="panel-heading">
            <div><h2>Campaign brief</h2><p>Structured input, editable before every run.</p></div>
            <div className="heading-actions">
              <button className="quiet-button" onClick={openBriefEditor}><FileCheck2 /> View / edit</button>
              <button className="quiet-button" onClick={() => importInput.current?.click()}><FolderInput /> Import</button>
            </div>
            <input ref={importInput} hidden type="file" accept=".json,.yaml,.yml,application/json,text/yaml" onChange={(event) => void importBrief(event.target.files?.[0])} />
          </div>

          <label className="field preset-field"><span>Example campaign</span>
            <select value={sampleBriefs.some((item) => item.id === brief.id) ? brief.id : ""} onChange={(event) => selectExample(event.target.value)}>
              {!sampleBriefs.some((item) => item.id === brief.id) ? <option value="">Imported brief</option> : null}
              {sampleBriefs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>

          <label className="field"><span>Campaign name</span><input value={brief.name} onChange={(event) => updateBrief("name", event.target.value)} /></label>
          <label className="field"><span>Region</span><input value={brief.region} onChange={(event) => updateBrief("region", event.target.value)} /></label>
          <label className="field"><span>Audience</span><input value={brief.audience} onChange={(event) => updateBrief("audience", event.target.value)} /></label>
          <label className="field"><span>Campaign message</span><textarea value={brief.message} rows={3} onChange={(event) => updateBrief("message", event.target.value)} /></label>

          <div className="field-group">
            <div className="field-label"><Languages size={15} /> Market copy</div>
            <div className="segmented market-segmented">
              {brief.markets.map((market) => (
                <button type="button" key={market.locale} aria-label={market.label} className={activeLocale === market.locale ? "selected" : ""} onClick={() => setActiveLocale(market.locale)}>
                  {market.locale.split("-")[0].toUpperCase()}
                </button>
              ))}
            </div>
            {activeMarket ? (
              <div className="market-copy-fields">
                <label className="field"><span>Localized message · {activeMarket.locale}</span><textarea value={activeMarket.message} rows={2} onChange={(event) => updateMarket("message", event.target.value)} /></label>
                <label className="field"><span>Call to action</span><input value={activeMarket.callToAction} onChange={(event) => updateMarket("callToAction", event.target.value)} /></label>
                <label className="field"><span>Required disclaimer</span><input value={activeMarket.disclaimer ?? ""} onChange={(event) => updateMarket("disclaimer", event.target.value)} /></label>
              </div>
            ) : null}
          </div>

          <div className="products-heading"><span>Products ({brief.products.length})</span><small>Source provenance</small></div>
          <div className="product-list">
            {brief.products.map((product) => {
              const result = report?.products.find((item) => item.productId === product.id);
              const source = result?.source ?? inferredSource(product, Boolean(providers?.selected));
              return (
                <button key={product.id} className={`product-row ${activeProduct?.id === product.id ? "active" : ""}`} onClick={() => setActiveProductId(product.id)}>
                  <img src={fallbackPackshot(product.id)} alt="" />
                  <span className="product-name">{product.name}</span>
                  <SourceStatus source={source} provider={result?.provider} />
                </button>
              );
            })}
          </div>

          <div className="assets-label">Assets for {activeProduct?.name}</div>
          <button className="dropzone" onClick={() => assetInput.current?.click()} disabled={uploading}>
            {uploading ? <LoaderCircle className="spin" /> : <Upload />}
            <strong>{uploading ? "Uploading asset…" : "Drop an approved hero here"}</strong>
            <span>or click to browse · PNG, JPEG, WebP</span>
          </button>
          <input ref={assetInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadAsset(event.target.files?.[0])} />
          <ProviderNote providers={providers} />
        </section>

        <section className="review-panel">
          <div className="review-heading">
            <div><h2>Creative review</h2><p>{brief.region} · {brief.markets.find((market) => market.locale === activeLocale)?.label}</p></div>
            <RatioSelector value={activeRatio} onChange={setActiveRatio} />
          </div>
          <div className="product-tabs" role="tablist" aria-label="Products">
            {brief.products.map((product) => (
              <button role="tab" aria-selected={activeProduct?.id === product.id} key={product.id} className={activeProduct?.id === product.id ? "active" : ""} onClick={() => setActiveProductId(product.id)}>
                {product.name}
              </button>
            ))}
          </div>
          <div className="preview-stage">
            <div className="preview-meta">
              <span>{activeRatio.replace("x", ":")}</span>
              <span>{creative ? `${creative.width} × ${creative.height}` : dimensions(activeRatio)}</span>
              {productResult && <SourceStatus source={productResult.source} provider={productResult.provider} />}
            </div>
            <div className={`creative-frame ratio-${activeRatio}`}>
              <img key={previewUrl} src={previewUrl} alt={`${activeProduct?.name} ${activeRatio.replace("x", ":")} creative preview`} />
              {!creative && (
                <div className="pre-run-overlay">
                  <span>Source master</span>
                  <strong>Generate to render message, CTA, localization, and compliance evidence.</strong>
                </div>
              )}
            </div>
          </div>
          <div className="mobile-ratio"><RatioSelector value={activeRatio} onChange={setActiveRatio} /></div>
          {report?.warnings.length ? (
            <div className="run-note"><CircleAlert size={16} /><span>{report.warnings[0]}</span></div>
          ) : null}
        </section>

        <aside className="summary-panel">
          <SummaryMetrics metrics={displayedMetrics} completed={Boolean(report)} />
          <Compliance checks={compliance} completed={Boolean(report)} />
          <ActivityLog report={report} running={running} />
          <details className="mobile-brief-summary">
            <summary><FileCheck2 /> Campaign brief <ChevronDown /></summary>
            <p><strong>{brief.name}</strong><br />{brief.region}<br />{brief.audience}</p>
          </details>
          {downloadUrl ? (
            <a className="download-button" href={downloadUrl}><Download /> Download output ZIP</a>
          ) : (
            <button className="download-button" disabled><Download /> Output ZIP after run</button>
          )}
        </aside>
      </main>

      <button className="primary-action mobile-action" onClick={generateCampaign} disabled={running}>
        {running ? <LoaderCircle className="spin" /> : <Sparkles />}
        {running ? "Generating campaign…" : "Generate campaign"}
      </button>

      {briefEditorOpen ? (
        <BriefEditor
          value={briefDraft}
          error={briefEditorError}
          onChange={setBriefDraft}
          onCancel={() => setBriefEditorOpen(false)}
          onApply={() => void applyBriefDraft()}
        />
      ) : null}
    </div>
  );
}

function BriefEditor({
  value,
  error,
  onChange,
  onCancel,
  onApply
}: {
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  return (
    <div className="brief-editor-backdrop" role="presentation">
      <section className="brief-editor" role="dialog" aria-modal="true" aria-labelledby="brief-editor-title">
        <div className="brief-editor-heading">
          <div>
            <h2 id="brief-editor-title">View / edit campaign brief</h2>
            <p>Edit the complete JSON contract. YAML can also be pasted here; Apply validates it against the same schema used by the API and CLI.</p>
          </div>
          <button className="brief-editor-close" onClick={onCancel} aria-label="Close brief editor">×</button>
        </div>
        <div className="brief-editor-body">
          {error ? <div className="brief-editor-error" role="alert"><CircleAlert />{error}</div> : null}
          <textarea aria-label="Campaign brief JSON or YAML" value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
        </div>
        <div className="brief-editor-actions">
          <button className="quiet-button" onClick={onCancel}>Cancel</button>
          <button className="primary-action" onClick={onApply}>Validate and apply</button>
        </div>
      </section>
    </div>
  );
}

function WorkflowRail({ progress }: { progress: number }) {
  const steps = ["Brief", "Assets", "Generate", "Review"];
  return (
    <nav className="workflow" aria-label="Campaign workflow" data-progress={progress}>
      {steps.map((step, index) => {
        const number = index + 1;
        const complete = number < progress;
        const active = number === progress;
        return (
          <div key={step} className={`workflow-step ${complete ? "complete" : ""} ${active ? "active" : ""}`}>
            <span>{complete ? <Check size={14} /> : String(number).padStart(2, "0")}</span>
            <strong>{step}</strong>
          </div>
        );
      })}
    </nav>
  );
}

function RatioSelector({ value, onChange }: { value: Ratio; onChange: (ratio: Ratio) => void }) {
  return (
    <div className="segmented ratio-selector" aria-label="Aspect ratio">
      {(["1x1", "9x16", "16x9"] as Ratio[]).map((ratio) => (
        <button key={ratio} className={value === ratio ? "selected" : ""} onClick={() => onChange(ratio)}>{ratio.replace("x", ":")}</button>
      ))}
    </div>
  );
}

type DisplaySource = AssetSource | "generation-pending" | "sample-available";

function SourceStatus({ source, provider }: { source: DisplaySource; provider?: string }) {
  const value = source === "approved"
    ? { label: "Approved asset", className: "approved", icon: <Check /> }
    : source === "generated-live"
      ? { label: provider === "adobe-firefly" ? "Firefly generated" : provider === "google-gemini" ? "Gemini generated" : "Live generated", className: "generated", icon: <Sparkles /> }
      : source === "generation-pending"
        ? { label: "Live generation pending", className: "generated", icon: <Sparkles /> }
        : source === "sample-available"
          ? { label: "Sample available", className: "cached", icon: <RefreshCw /> }
          : { label: "Generated sample", className: "cached", icon: <RefreshCw /> };
  return <span className={`source-status ${value.className}`}>{value.icon}{value.label}</span>;
}

function ProviderNote({ providers }: { providers: ProviderStatus | null }) {
  const verified = providers?.selected;
  const unavailable = Boolean(providers?.verificationError);
  const providerName = verified === "firefly" ? "Adobe Firefly" : verified === "gemini" ? "Google Gemini" : "OpenAI";
  return (
    <div className={`provider-note ${verified ? "ready" : "sample"}`}>
      <Zap />
      <div><strong>{verified ? `${providerName} verified` : unavailable ? "Provider unavailable" : "Sample mode"}</strong>
      <span>{verified ? "Credentials verified. Missing heroes will call the live provider." : unavailable ? "Configured credentials could not be verified. Included samples will be used." : "Included samples keep local runs self-contained. Add server credentials for live generation."}</span></div>
    </div>
  );
}

function SummaryMetrics({ metrics, completed }: { metrics: CampaignReport["metrics"]; completed: boolean }) {
  const rows = [
    { icon: <FileCheck2 />, label: "Campaign runs", value: metrics.campaigns, mobile: true },
    { icon: <ImageIcon />, label: completed ? "Creatives" : "Planned creatives", value: metrics.creatives, mobile: true },
    { icon: <Box />, label: "Products", value: metrics.products, mobile: false },
    { icon: <RefreshCw />, label: "Reused", value: completed ? metrics.reused : "—", mobile: false },
    { icon: <Sparkles />, label: "Generated", value: completed ? metrics.generatedLive || metrics.generatedSample : "—", mobile: false },
    { icon: <Clock3 />, label: "Elapsed time", value: metrics.elapsedMs ? formatDuration(metrics.elapsedMs) : "—", mobile: true },
    { icon: <Zap />, label: "Est. time saved", value: completed ? `${metrics.timeSavedMinutes} min` : "—", mobile: true },
    { icon: <Activity />, label: "Output rate", value: completed ? `${metrics.creativesPerMinute}/min` : "—", mobile: false }
  ];
  return (
    <section className="rail-section metrics-section">
      <h2>Run summary</h2>
      <div className="metrics-list">
        {rows.map((row) => <div className={`metric-row ${row.mobile ? "" : "mobile-hidden"}`} key={row.label}><span className="metric-label">{row.icon}{row.label}</span><strong>{row.value}</strong></div>)}
      </div>
    </section>
  );
}

function Compliance({ checks, completed }: { checks: ComplianceCheck[]; completed: boolean }) {
  return (
    <section className="rail-section compliance-section">
      <h2>Compliance</h2>
      <div className="compliance-list">
        {checks.map((check) => (
          <div className="compliance-row" key={check.id} title={completed ? check.evidence : "Checked after generation"}>
            <span className={!completed ? "pending" : check.passed ? "pass" : "fail"}>{!completed ? <Clock3 /> : check.passed ? <Check /> : <CircleAlert />}</span>
            <span>{check.label}</span>
            <small>{!completed ? "Pending" : check.passed ? "Passed" : "Review"}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function ActivityLog({ report, running }: { report: CampaignReport | null; running: boolean }) {
  const events = report?.events.slice(-6) ?? [
    { at: new Date().toISOString(), stage: "brief", label: "Sample brief loaded" },
    { at: new Date().toISOString(), stage: "preflight", label: "Ready to run" }
  ];
  return (
    <section className="rail-section activity-section">
      <h2>Activity {running && <LoaderCircle className="spin" />}</h2>
      <div className="activity-list">
        {events.map((event, index) => (
          <div className="activity-row" key={`${event.label}-${index}`}>
            <span className="activity-icon">{report && index === events.length - 1 ? <Check /> : running && index === events.length - 1 ? <LoaderCircle className="spin" /> : <Activity />}</span>
            <span><strong>{event.label}</strong>{"detail" in event && event.detail ? <small>{event.detail}</small> : null}</span>
            <time>{formatTime(event.at)}</time>
          </div>
        ))}
      </div>
    </section>
  );
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="app-mark">CF</div><LoaderCircle className="spin" /><span>Loading Campaign Forge</span></div>;
}

function FatalError({ message }: { message: string }) {
  return <div className="loading-screen error"><CircleAlert /><strong>Campaign Forge could not start</strong><span>{message}</span></div>;
}

function defaultCompliance(): ComplianceCheck[] {
  return [
    { id: "brand", label: "Brand lockup", passed: false, evidence: "Not yet run" },
    { id: "palette", label: "Brand palette", passed: false, evidence: "Not yet run" },
    { id: "contrast", label: "Token contrast", passed: false, evidence: "Not yet run" },
    { id: "legal", label: "Legal copy", passed: false, evidence: "Not yet run" },
    { id: "copy-fit", label: "Copy fit", passed: false, evidence: "Not yet run" },
    { id: "safe-zone", label: "Story safe zone", passed: false, evidence: "Not yet run" },
    { id: "dimensions", label: "Channel dimensions", passed: false, evidence: "Not yet run" }
  ];
}

function inferredSource(product: CampaignBrief["products"][number], liveProviderConfigured: boolean): DisplaySource {
  return product.approvedHeroPath ? "approved" : liveProviderConfigured ? "generation-pending" : "sample-available";
}

function fallbackPreview(productId?: string): string {
  return productId === "berry-charge" ? "/samples/assets/berry-charge-generated-sample.webp" : "/samples/assets/citrus-lift-approved-hero.webp";
}

function fallbackPackshot(productId: string): string {
  return productId === "berry-charge" ? "/samples/assets/berry-charge-packshot.webp" : "/samples/assets/citrus-lift-approved-hero.webp";
}

function dimensions(ratio: Ratio): string {
  return ratio === "1x1" ? "1080 × 1080" : ratio === "9x16" ? "1080 × 1920" : "1920 × 1080";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(milliseconds / 1_000).toFixed(1)} sec`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
