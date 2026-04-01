import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export const chatSession = ai.chats.create({
  model: "gemini-3.1-pro-preview",
  config: {
    systemInstruction: "You are QUTA, an elite AI architect with deep internet integration. You have real-time access to Google Search and can analyze content from specific URLs. Your responses are sharp, insightful, and technically precise. Use search results to provide the most current information. If a user provides a URL, use the urlContext tool to analyze it. Maintain a sleek, professional persona. Use Markdown for structured data, code, and emphasis.",
    tools: [{ googleSearch: {} }, { urlContext: {} }],
  },
});

export async function sendMessage(message: string) {
  try {
    const response = await chatSession.sendMessage({ message });
    return response.text;
  } catch (error) {
    console.error("Error sending message to Gemini:", error);
    throw error;
  }
}

export async function* sendMessageStream(message: string) {
  try {
    const responseStream = await chatSession.sendMessageStream({ message });
    for await (const chunk of responseStream) {
      yield {
        text: chunk.text,
        groundingMetadata: chunk.candidates?.[0]?.groundingMetadata,
      };
    }
  } catch (error) {
    console.error("Error streaming message from Gemini:", error);
    throw error;
  }
}

export async function generateImage(prompt: string, options?: { aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9", style?: string }) {
  try {
    const finalPrompt = options?.style ? `${options.style} style: ${prompt}` : prompt;
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          {
            text: finalPrompt,
          },
        ],
      },
      config: {
        imageConfig: {
          aspectRatio: options?.aspectRatio || "1:1",
        },
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
    throw new Error("No image data found in response");
  } catch (error) {
    console.error("Error generating image:", error);
    throw error;
  }
}
