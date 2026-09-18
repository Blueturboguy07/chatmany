import type { Env } from "../types";

export async function generateSmartReply(env: Env, userMessage: string, systemPrompt?: string): Promise<string | null> {
  if (!env.MUSE_API_KEY) {
    console.warn("[chatmany] MUSE_API_KEY is not set.");
    return null;
  }

  const defaultPrompt = "You are a helpful, friendly assistant. Keep your responses short, natural, and use emojis. You are replying to Instagram DMs.";
  const sys = systemPrompt ?? defaultPrompt;

  try {
    const res = await fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.MUSE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "muse-spark-1.3-contributor",
        input: [
          { role: "system", content: sys },
          { role: "user", content: userMessage }
        ],
        stream: false,
        temperature: 0.7,
        max_output_tokens: 1000,
        top_p: 1,
        reasoning: { effort: "low" }
      })
    });

    if (!res.ok) {
      console.warn(`[chatmany] Muse API error: ${await res.text()}`);
      return null;
    }

    const data = await res.json() as any;
    const msg = data?.output?.find((o: any) => o.type === "message");
    if (!msg || !msg.content) return null;
    
    const textObj = msg.content.find((c: any) => c.type === "output_text");
    if (!textObj || !textObj.text) return null;

    return textObj.text;
  } catch (e) {
    console.warn(`[chatmany] AI fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

