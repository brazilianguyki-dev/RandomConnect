import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function moderateContent(text: string): Promise<boolean> {
  if (!process.env.GEMINI_API_KEY) return true; // Skip if no key

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Analyze the following message for abusive, hateful, or inappropriate content. Respond with ONLY "SAFE" or "UNSAFE".\n\nMessage: "${text}"`,
    });

    const result = response.text?.trim().toUpperCase();
    return result === "SAFE";
  } catch (error) {
    console.error("Moderation error:", error);
    return true; // Default to safe on error to avoid blocking users
  }
}
