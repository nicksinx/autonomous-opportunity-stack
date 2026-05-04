// Inlined into wf_layer3_creative_pack — expects nodes:
// "Prepare idempotency" (candidate), "Postgres insert creative run" (run_id).

function envOr(key, fallback) {
  try {
    if (typeof $env !== "undefined" && $env[key]) return String($env[key]);
  } catch (_e) {}
  return fallback;
}

function extractJsonObject(raw) {
  const s = String(raw == null ? "" : raw).trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw new Error("No JSON object in response");
}

function extractSvg(raw) {
  const s = String(raw || "");
  const m = s.match(/<svg[\s\S]*?<\/svg>/i);
  if (m) return m[0];
  throw new Error("No SVG element in response");
}

const ins = $("Insert creative_generation_run").first()?.json || {};
const prep = $("Prepare idempotency").first()?.json || {};
const run_id = ins.run_id;
const candidate = prep.candidate || {};

if (!run_id) {
  return [{ json: { skipped: true, reason: "idempotency_conflict_or_no_insert" } }];
}

const anthropicKey = envOr("ANTHROPIC_API_KEY", "");
const openaiKey = envOr("OPENAI_API_KEY", "");
const imageModel = envOr("LAYER3_OPENAI_IMAGE_MODEL", "dall-e-3");
const skipDrive = String(envOr("LAYER3_SKIP_DRIVE_UPLOAD", "true")).toLowerCase() === "true";

const title = String(candidate.title || "").trim();
const niche = String(candidate.primary_niche || "").trim();
const audience = candidate.target_audience
  ? typeof candidate.target_audience === "object"
    ? JSON.stringify(candidate.target_audience)
    : String(candidate.target_audience)
  : "";
const ctx = candidate.market_context
  ? typeof candidate.market_context === "object"
    ? JSON.stringify(candidate.market_context)
    : String(candidate.market_context)
  : "";

const mjSystem =
  "You output JSON only. No markdown fences. POD-safe: no brand names, celebrities, sports teams, or trademarks.";
const mjUser = `Create Midjourney-oriented prompts and three shorter English prompts for OpenAI image generation for print-on-demand (apparel graphics).

Return strict JSON:
{
  "midjourney_primary": "",
  "midjourney_alt_a": "",
  "midjourney_alt_b": "",
  "image_prompts": ["flat vector illustration ...", "minimal line art ...", "badge logo style ..."]
}

Theme/title: ${title}
Niche: ${niche}
Audience/context JSON: ${audience}
Market JSON: ${ctx}

Rules:
- image_prompts must be exactly 3 strings, each under 900 characters, no text requiring trademarked logos.
- Midjourney-style richness for the three midjourney_* fields (parameters ok: --ar 1:1 --v 6).`;

let prompt_pack = {};
let images_b64 = [];
let svg_text = "";
let error_summary = null;

try {
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");
  if (!openaiKey) throw new Error("OPENAI_API_KEY not set");

  const mjBody = await this.helpers.httpRequest({
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: mjSystem,
      messages: [{ role: "user", content: mjUser }],
    },
    json: true,
  });
  const mjTxt = (mjBody?.content || []).find((b) => b.type === "text" && b.text)?.text || "";
  prompt_pack = extractJsonObject(mjTxt);

  const ips = Array.isArray(prompt_pack.image_prompts) ? prompt_pack.image_prompts : [];
  const prompts3 = [ips[0], ips[1], ips[2]].map((p, i) =>
    String(p || "").trim() || `Original illustration concept for ${title} variant ${i + 1}`,
  );

  for (let i = 0; i < 3; i++) {
    const imgRes = await this.helpers.httpRequest({
      method: "POST",
      url: "https://api.openai.com/v1/images/generations",
      headers: {
        authorization: `Bearer ${openaiKey}`,
        "content-type": "application/json",
      },
      body: {
        model: imageModel,
        prompt: prompts3[i],
        n: 1,
        size: "1024x1024",
        response_format: "b64_json",
      },
      json: true,
    });
    const b64 = imgRes?.data?.[0]?.b64_json;
    if (!b64) throw new Error(`OpenAI image ${i + 1}: no b64_json`);
    images_b64.push(b64);
  }

  const svgSystem =
    "Reply with a single valid SVG root element only. viewBox=\"0 0 1024 1024\". No script, no foreignObject, no external images. Use basic shapes and text for a POD graphic.";
  const svgUser = `Design a simple editable SVG graphic inspired by this POD theme (no trademarks):\nTitle: ${title}\nNiche: ${niche}\nConcept: ${String(prompt_pack.midjourney_primary || "").slice(0, 1200)}`;

  const svgBody = await this.helpers.httpRequest({
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: {
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: svgSystem,
      messages: [{ role: "user", content: svgUser }],
    },
    json: true,
  });
  const svgTxt = (svgBody?.content || []).find((b) => b.type === "text" && b.text)?.text || "";
  svg_text = extractSvg(svgTxt);
} catch (e) {
  error_summary = String(e?.message || e);
}

const mjMd = [
  "# Midjourney prompts",
  "",
  "## Primary",
  String(prompt_pack.midjourney_primary || ""),
  "",
  "## Alternate A",
  String(prompt_pack.midjourney_alt_a || ""),
  "",
  "## Alternate B",
  String(prompt_pack.midjourney_alt_b || ""),
  "",
].join("\n");

const prompt_pack_obj = {
  ...prompt_pack,
  openai_image_model: imageModel,
  skipped_drive_upload: skipDrive,
};

const output_rows = [];
output_rows.push({
  run_id,
  kind: "mj_prompt_bundle",
  variant_index: 0,
  mime_type: "text/markdown",
  body_text: mjMd,
  metadata_json: JSON.stringify({ source: "layer3_inline" }),
});

for (let i = 0; i < images_b64.length; i++) {
  output_rows.push({
    run_id,
    kind: "openai_image",
    variant_index: i,
    mime_type: "image/png",
    body_text: null,
    metadata_json: JSON.stringify({
      variant: i + 1,
      model: imageModel,
      prompt_used: Array.isArray(prompt_pack.image_prompts) ? prompt_pack.image_prompts[i] : "",
    }),
  });
}

output_rows.push({
  run_id,
  kind: "svg_sample",
  variant_index: 0,
  mime_type: "image/svg+xml",
  body_text: svg_text || "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><!-- failed --></svg>",
  metadata_json: JSON.stringify({ valid: Boolean(svg_text && !error_summary) }),
});

const finalStatus = error_summary ? "failed" : "success";

return [
  {
    json: {
      run_id,
      opportunity_id: candidate.opportunity_id,
      prompt_pack_obj,
      output_rows,
      images_b64,
      mj_markdown: mjMd,
      svg_text,
      final_status: finalStatus,
      error_summary,
      skip_drive: skipDrive,
    },
  },
];
