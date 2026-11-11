import "dotenv/config";

const env = process.env;
const forceDemo = env.DEMO_MODE === "true" || process.argv.includes("--demo");

const paypalEnv = env.PAYPAL_ENV === "live" ? "live" : "sandbox";

// model:         does the reasoning (invoice extraction, reminders, copilot) with strict JSON output.
// visionModel:   when set, only transcribes chat screenshots to text, which `model` then reads.
//                When empty, screenshots go straight to `model` (it must accept images).
// fallbackModel: tried once when `model` is rate limited, overloaded or returns invalid JSON.
function aiConfig() {
  const presets = {
    groq: {
      name: "Groq",
      kind: "openai",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: env.GROQ_API_KEY || "",
      model: env.GROQ_MODEL || "openai/gpt-oss-120b",
      visionModel: env.GROQ_VISION_MODEL ?? "qwen/qwen3.8-27b",
      fallbackModel: env.GROQ_FALLBACK_MODEL ?? "openai/gpt-oss-20b",
      reasoningEffort: "medium",
    },
    gemini: {
      name: "Google Gemini",
      kind: "gemini",
      apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "",
      model: env.GEMINI_MODEL || "gemini-2.5-flash",
      visionModel: "",
      fallbackModel: env.GEMINI_FALLBACK_MODEL ?? "gemini-2.5-flash-lite",
      reasoningEffort: "",
    },
    // Any other OpenAI-compatible API (OpenRouter, Mistral, a local server, ...).
    openai: {
      name: env.AI_PROVIDER_NAME || "OpenAI-compatible API",
      kind: "openai",
      baseUrl: (env.AI_BASE_URL || "").replace(/\/$/, ""),
      apiKey: env.AI_API_KEY || "",
      model: env.AI_MODEL || "",
      visionModel: env.AI_VISION_MODEL || "",
      fallbackModel: env.AI_FALLBACK_MODEL || "",
      reasoningEffort: "",
    },
  };
  const auto = env.GROQ_API_KEY ? "groq" : env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? "gemini" : env.AI_API_KEY ? "openai" : "groq";
  const id = (env.AI_PROVIDER || auto).toLowerCase();
  if (!presets[id]) throw new Error(`Unknown AI_PROVIDER "${id}". Use groq, gemini or openai.`);
  const preset = presets[id];
  return { id, ...preset, maxImages: 3, reasoningEffort: env.AI_REASONING_EFFORT || preset.reasoningEffort };
}

export const config = {
  port: Number(env.PORT) || 3000,

  // PayPal: sandbox by default. Without credentials the app runs on an in-memory mock.
  paypal: {
    env: paypalEnv,
    baseUrl: paypalEnv === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com",
    clientId: env.PAYPAL_CLIENT_ID || "",
    clientSecret: env.PAYPAL_CLIENT_SECRET || "",
  },

  // AI provider, picked by AI_PROVIDER or by whichever key is set. Without a key the app
  // uses canned demo responses. See aiPresets below.
  ai: aiConfig(),

  business: {
    name: env.BUSINESS_NAME || "Studio Nord",
    email: env.BUSINESS_EMAIL || "",
    defaultCurrency: env.DEFAULT_CURRENCY || "USD",
  },

  // Requests per IP per 10 minutes for the AI endpoints (protects the API budget on a public demo).
  aiRateLimit: Number(env.AI_RATE_LIMIT) || 40,
};

config.paypal.live = !forceDemo && Boolean(config.paypal.clientId && config.paypal.clientSecret);
config.ai.live = !forceDemo && Boolean(config.ai.apiKey && config.ai.model);
