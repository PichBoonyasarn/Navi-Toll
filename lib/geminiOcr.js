// Falls back to Gemini's vision model to transcribe text from image-based
// PDF pages that pdf-parse can't extract anything from (scanned documents,
// or coordinate info embedded in a diagram rather than the text layer).
// Uses the older, stable generateContent endpoint rather than the newer
// Interactions API: this is a simple one-shot "read this image" call with
// no multi-turn state needed, so there's no benefit to the newer surface,
// and generateContent remains fully supported by Google.
//
// Free tier quotas are tracked per model, and vary a lot between them —
// observed live on 2026-07-06 (via the account's own aistudio.google.com
// rate-limit dashboard, not general docs, which quoted a much higher and
// inaccurate ~1,500/day figure): gemini-2.5-flash caps at a mere 20
// requests/day, while gemini-3.1-flash-lite allows 500/day on the same
// project. OCR/transcription doesn't need frontier-level reasoning, so the
// lite model with the much larger daily budget is the primary choice here,
// with the others kept as a fallback chain in case it's ever unavailable.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODELS = ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash'];

const OCR_PROMPT = 'Transcribe all visible text in this image exactly as written, ' +
  'including any coordinate, latitude/longitude, or 緯度/経度 information. ' +
  'Output only the raw transcribed text, preserving line breaks. ' +
  'Do not translate, summarize, or add commentary.';

function isGeminiConfigured() {
  return !!GEMINI_API_KEY;
}

async function callModel(model, base64Png) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${url}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: OCR_PROMPT },
              { inline_data: { mime_type: 'image/png', data: base64Png } },
            ],
          }],
        }),
      });
      const body = await res.json();
      if (body.error) {
        // RESOURCE_EXHAUSTED means this model's quota window is used up —
        // retrying it immediately can't succeed, so fail fast and let the
        // caller move on to the next model in the chain.
        if (body.error.status === 'RESOURCE_EXHAUSTED') return '';
        throw new Error(`Gemini API: ${body.error.status} ${body.error.message}`);
      }
      return body.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch {
      if (i === attempts - 1) return '';
      // Only genuinely transient errors (e.g. UNAVAILABLE, Google's "high
      // demand" 503) reach this branch — worth a short retry on the same model.
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return '';
}

// Returns the transcribed text, or '' on total failure (missing key, every
// model in the chain exhausted/erroring, no text found) — callers treat
// that as "OCR found nothing usable" and move on, same graceful-degradation
// pattern used elsewhere in this app (e.g. findNearestIC). Tries each model
// in GEMINI_MODELS in order, moving to the next on any failure — a model
// being down or out of quota shouldn't fail the whole page when a fallback
// might still succeed.
async function ocrImageToText(base64Png) {
  if (!GEMINI_API_KEY) return '';

  for (const model of GEMINI_MODELS) {
    const result = await callModel(model, base64Png);
    if (result) return result;
  }
  return '';
}

module.exports = { ocrImageToText, isGeminiConfigured };
