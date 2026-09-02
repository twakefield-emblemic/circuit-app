const fetch = require("node-fetch");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5-20250929"; // vision + web_search together, same key as emblemic-backend

const SCAN_PROMPT_HEADER = `You're looking at a photo taken at CoCreate LA 2026, an Alibaba.com-hosted
B2B sourcing summit in Los Angeles connecting buyers with manufacturers and suppliers. The photo
shows a booth, sign, logo, or business card for one vendor/exhibitor.

1. Identify the company/brand shown, as best you can from the image.
2. Use the web_search tool to look up what's actually current about them right now — don't rely
   only on what you already know. Search for their flagship product, whether they're publicly
   traded (most exhibitors at a sourcing show won't be — that's fine, say so plainly), where
   buyers typically find or reach them, and any notable recent news.
3. Write ONE short, plain sentence for each field below, grounded in what you actually found. If
   a search comes back empty or you can't identify the company with confidence, say so honestly
   in that field instead of guessing.`;

// When the buyer has saved a LinkedIn URL and/or company name, this becomes step 2b: an
// extra search pass on the BUYER's side, so the score can reflect a real two-sided fit
// instead of just "is this vendor generically good." Public profiles/pages are sometimes
// not indexed or visible to a search — the instruction is explicit that finding nothing
// is a valid, honestly-reported outcome, not license to invent background.
const BUYER_CONTEXT_STEP = (linkedinUrl, companyName) => `
2b. Also use web_search to learn about the BUYER doing this scan, so the score reflects how well
    this vendor fits THEM specifically, not just a generic read on the vendor:
    ${linkedinUrl ? `- Their LinkedIn profile: ${linkedinUrl} — note their public headline/experience if the search surfaces it.\n    ` : ""}${companyName ? `- Their company: ${companyName} — look up what this company actually does.\n    ` : ""}If a search comes back empty or the profile isn't publicly visible, say so plainly in
    score_reasons rather than inventing background.`;

function buildScoreInstructions(goalsList, hasBuyerContext) {
  const hasGoals = goalsList.length > 0;
  const bullets = [];
  if (hasGoals) {
    bullets.push(`the buyer's own stated goals for this show:\n   ${goalsList.map((g) => `- ${g}`).join("\n   ")}`);
  }
  if (hasBuyerContext) {
    bullets.push(`whether this vendor's actual business meaningfully complements what you found about the buyer's own background/company in step 2b — a specific two-sided read, not just "this is a good company"`);
  }
  bullets.push(`general signal quality — a real, findable, active company with a clear product scores higher than one you couldn't pin down`);

  const openLine = hasGoals || hasBuyerContext
    ? `Compute an "Emblemic Score" from 0-100: how strong a match this company is worth prioritizing as a follow-up. Weigh:`
    : `Compute an "Emblemic Score" from 0-100 rating general follow-up worth. The buyer hasn't set goals or shared their own background yet, so score on:`;

  return `
4. ${openLine}
   ${bullets.map((b) => `- ${b}`).join("\n   ")}
   This is a first-pass score — don't overclaim precision; a plain, defensible estimate is right.
   Also write score_label as a short 2-4 word priority tag (e.g. "Strong match", "Worth a look",
   "Low priority", "Not enough signal") and score_reasons as ONE sentence grounded in what you
   actually found${hasBuyerContext ? ", naming the buyer-side fit specifically when it meaningfully affected the score" : ""}.`;
}

const SCAN_PROMPT_FOOTER = `
After you've searched, reply with ONLY a JSON object as your final message, no other text, in
exactly this shape:
{"company_name": string, "confidence": "high"|"medium"|"low"|"unknown",
 "product": string, "market": string, "find_them": string, "news": string, "why_follow_up": string,
 "score": number, "score_label": string, "score_reasons": string}

Field meanings — product: their flagship product or category. market: public trading status/
ticker if publicly traded, otherwise company stage or size if you found it, otherwise say it's
privately held with no further detail found. find_them: how a buyer would typically track this
company down, or where they're based/sell. news: the most notable current thing you found about
them, or say there's nothing notable turned up. why_follow_up: one compelling, honestly-grounded
sentence on why this could be worth a follow-up meeting.`;

async function identifyVendor(imageBuffer, mimeType, goals, buyerContext) {
  const goalsList = Array.isArray(goals) ? goals.filter(Boolean) : [];
  const linkedinUrl = (buyerContext && buyerContext.linkedinUrl) || "";
  const companyName = (buyerContext && buyerContext.companyName) || "";
  const hasBuyerContext = !!(linkedinUrl || companyName);

  const buyerContextStep = hasBuyerContext ? BUYER_CONTEXT_STEP(linkedinUrl, companyName) : "";
  const scoreInstructions = buildScoreInstructions(goalsList, hasBuyerContext);
  const scanPrompt = SCAN_PROMPT_HEADER + buyerContextStep + scoreInstructions + SCAN_PROMPT_FOOTER;

  const body = {
    model: MODEL,
    max_tokens: 1300,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBuffer.toString("base64") } },
          { type: "text", text: scanPrompt },
        ],
      },
    ],
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  // Final text block across all content (tool_use rounds included) — take the last text block,
  // since that's Claude's answer after any web_search rounds.
  const textBlocks = (data.content || []).filter((b) => b.type === "text");
  const lastText = textBlocks.length ? textBlocks[textBlocks.length - 1].text : "";
  const result = parseJsonLoose(lastText);

  // Defensive clamp — Claude usually follows the shape, but a scan feeding into a saved score
  // shouldn't trust an out-of-range or missing number blindly.
  let score = Number(result.score);
  if (!Number.isFinite(score)) score = null;
  else score = Math.max(0, Math.min(100, Math.round(score)));
  result.score = score;
  result.score_label = typeof result.score_label === "string" ? result.score_label : "";
  result.score_reasons = typeof result.score_reasons === "string" ? result.score_reasons : "";

  return result;
}

function parseJsonLoose(text) {
  if (!text) throw new Error("empty_completion");
  try {
    return JSON.parse(text);
  } catch (e) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { return JSON.parse(fenced[1]); } catch (e2) { /* fall through */ }
    }
    const start = text.search(/[{[]/);
    const endBrace = text.lastIndexOf("}");
    const endBracket = text.lastIndexOf("]");
    const end = Math.max(endBrace, endBracket);
    if (start !== -1 && end !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (e3) { /* fall through */ }
    }
    throw new Error("invalid_json: " + text.slice(0, 200));
  }
}

async function askQuestion(question) {
  const prompt = `You're a concise, well-informed event-industry assistant helping someone prepare for
CoCreate LA 2026, an Alibaba.com-hosted B2B sourcing summit in Los Angeles (Sept 9-10, 2026) that
connects buyers with manufacturers and suppliers, plus a startup pitch track called CoCreate Pitch.
Use the web_search tool if it would help answer accurately — the event is close enough that real,
current details may exist online now. Answer in 3-5 short sentences, plainly, no headers or bullet
lists.\n\nQuestion: ${question}`;

  const body = {
    model: MODEL,
    max_tokens: 700,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }],
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const textBlocks = (data.content || []).filter((b) => b.type === "text");
  return textBlocks.map((b) => b.text).join("\n\n").trim();
}

module.exports = { identifyVendor, askQuestion };
