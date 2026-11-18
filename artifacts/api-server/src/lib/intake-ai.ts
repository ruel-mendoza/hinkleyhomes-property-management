import { EXTRACTION_ASK, EXTRACTION_SYSTEM, type AiInput, type Extraction } from "./intake-rules";

// Reads one invoice document with OpenAI, as the n8n intake check does
// (Responses API, JSON output, low reasoning effort, nothing stored at OpenAI).

const TIMEOUT_MS = 120_000;

export async function readInvoice(input: AiInput, opts: { apiKey: string; model: string }): Promise<Extraction> {
  const content: Record<string, unknown>[] =
    input.kind === "text"
      ? [{ type: "input_text", text: `${input.text}\n\n${EXTRACTION_ASK}` }]
      : input.kind === "pdf"
        ? [{ type: "input_file", filename: input.filename, file_data: `data:${input.mime};base64,${input.base64}` }, { type: "input_text", text: EXTRACTION_ASK }]
        : [{ type: "input_image", image_url: `data:${input.mime};base64,${input.base64}`, detail: "high" }, { type: "input_text", text: EXTRACTION_ASK }];
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      instructions: EXTRACTION_SYSTEM,
      input: [{ role: "user", content }],
      max_output_tokens: 8000,
      reasoning: { effort: "low" },
      text: { format: { type: "json_object" } },
      store: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string }; output?: { content?: { type?: string; text?: string }[] }[] };
  if (!response.ok) throw new Error(`OpenAI: ${body.error?.message ?? `HTTP ${response.status}`}`.slice(0, 500));
  const text = (body.output ?? []).flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
  const parsed: unknown = JSON.parse(text.replace(/```json|```/g, "").trim());
  if (!parsed || typeof parsed !== "object") throw new Error("OpenAI did not return a JSON object.");
  return parsed as Extraction;
}
