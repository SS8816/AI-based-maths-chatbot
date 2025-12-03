import { GoogleGenerativeAI, GenerativeModel, ChatSession } from "@google/generative-ai";
import type { Channel, Event, MessageResponse, StreamChat } from "stream-chat";

/**
 * Checks if an error is a Gemini quota/billing error
 */
function isQuotaError(error: unknown): boolean {
  if (!error) return false;
  
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();
  
  // Check for quota-related keywords in the error message
  if (
    lowerMessage.includes("quota") ||
    lowerMessage.includes("billing") ||
    lowerMessage.includes("exceeded") ||
    lowerMessage.includes("rate_limit") ||
    lowerMessage.includes("resource_exhausted") ||
    lowerMessage.includes("429") ||
    lowerMessage.includes("check your plan")
  ) {
    return true;
  }
  
  // Check for API error structure
  if (typeof error === "object" && error !== null) {
    const err = error as any;
    // Check status codes that might indicate quota issues
    if (err.status === 429 || err.statusCode === 429) {
      return true;
    }
    // Check for quota error codes
    if (err.code === "RESOURCE_EXHAUSTED" || err.code === "RATE_LIMIT_EXCEEDED") {
      return true;
    }
  }
  
  return false;
}

/**
 * Formats a user-friendly error message for quota errors
 */
function formatQuotaErrorMessage(error: unknown): string {
  return "⚠️ Gemini API quota exceeded. Please check your Google Cloud billing and quota limits. Visit https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas to manage your quotas.";
}

export class GeminiResponseHandler {
  private message_text = "";
  private chunk_counter = 0;
  private is_done = false;
  private last_update_time = 0;
  private abortController?: AbortController;

  constructor(
    private readonly genAI: GoogleGenerativeAI,
    private readonly model: GenerativeModel,
    private readonly chatSession: ChatSession,
    private readonly chatClient: StreamChat,
    private readonly channel: Channel,
    private readonly message: MessageResponse,
    private readonly onDispose: () => void
  ) {
    this.chatClient.on("ai_indicator.stop", this.handleStopGenerating);
  }

  run = async () => {
    const { cid, id: message_id } = this.message;
    this.abortController = new AbortController();
    const userMessage = (this as any).userMessage || "";

    try {
      await this.channel.sendEvent({
        type: "ai_indicator.update",
        ai_state: "AI_STATE_GENERATING",
        cid: cid,
        message_id: message_id,
      });

      // Send message and get streaming response
      const result = await this.chatSession.sendMessageStream(userMessage);

      let hasFunctionCall = false;
      let functionCallsToProcess: any[] = [];

      // Process the stream
      for await (const chunk of result.stream) {
        if (this.is_done) break;

        const chunkText = chunk.text();
        if (chunkText) {
          this.message_text += chunkText;
          this.chunk_counter += 1;

          // Update message every second to avoid too many updates
          const now = Date.now();
          if (now - this.last_update_time > 1000) {
            await this.chatClient.partialUpdateMessage(message_id, {
              set: { text: this.message_text },
            });
            this.last_update_time = now;
          }
        }

        // Check for function calls
        const functionCalls = chunk.functionCalls();
        if (functionCalls && functionCalls.length > 0) {
          hasFunctionCall = true;
          functionCallsToProcess.push(...functionCalls);
        }
      }

      // Handle function calls if any
      if (hasFunctionCall && functionCallsToProcess.length > 0) {
        await this.channel.sendEvent({
          type: "ai_indicator.update",
          ai_state: "AI_STATE_EXTERNAL_SOURCES",
          cid: cid,
          message_id: message_id,
        });

        const functionResponses: any[] = [];
        
        for (const functionCall of functionCallsToProcess) {
          if (functionCall.name === "web_search") {
            try {
              const args = functionCall.args as { query?: string };
              const query = args?.query || "";
              const searchResult = await this.performWebSearch(query);
              
              functionResponses.push({
                functionResponse: {
                  name: "web_search",
                  response: JSON.parse(searchResult),
                },
              });
            } catch (e) {
              console.error("Error performing web search", e);
              functionResponses.push({
                functionResponse: {
                  name: "web_search",
                  response: { error: "failed to call tool" },
                },
              });
            }
          }
        }

        // Send function responses and get final response
        if (functionResponses.length > 0) {
          const finalResult = await this.chatSession.sendMessage(functionResponses);
          const finalText = finalResult.response.text();
          this.message_text = finalText;
        }
      }

      // Get final response if we haven't already
      if (!hasFunctionCall) {
        const response = await result.response;
        const finalText = response.text();
        this.message_text = finalText || this.message_text;
      }

      // Final update with complete message
      await this.chatClient.partialUpdateMessage(message_id, {
        set: {
          text: this.message_text,
        },
      });

      await this.channel.sendEvent({
        type: "ai_indicator.clear",
        cid: cid,
        message_id: message_id,
      });
    } catch (error) {
      console.error("An error occurred during the run:", error);
      await this.handleError(error as Error);
    } finally {
      await this.dispose();
    }
  };

  dispose = async () => {
    if (this.is_done) {
      return;
    }
    this.is_done = true;
    this.chatClient.off("ai_indicator.stop", this.handleStopGenerating);
    if (this.abortController) {
      this.abortController.abort();
    }
    this.onDispose();
  };

  private handleStopGenerating = async (event: Event) => {
    if (this.is_done || event.message_id !== this.message.id) {
      return;
    }

    console.log("Stop generating for message", this.message.id);
    
    if (this.abortController) {
      this.abortController.abort();
    }

    await this.channel.sendEvent({
      type: "ai_indicator.clear",
      cid: this.message.cid,
      message_id: this.message.id,
    });
    await this.dispose();
  };

  private handleError = async (error: Error | unknown) => {
    if (this.is_done) {
      return;
    }
    
    // Check if this is a quota error and format message accordingly
    const isQuota = isQuotaError(error);
    const errorMessage = isQuota
      ? formatQuotaErrorMessage(error)
      : (error instanceof Error ? error.message : String(error)) || "Error generating the message";
    
    console.error("Gemini API error:", error);
    if (isQuota) {
      console.error("Quota/billing error detected. User needs to check their Google Cloud account.");
    }
    
    await this.channel.sendEvent({
      type: "ai_indicator.update",
      ai_state: "AI_STATE_ERROR",
      cid: this.message.cid,
      message_id: this.message.id,
    });
    await this.chatClient.partialUpdateMessage(this.message.id, {
      set: {
        text: errorMessage,
        message: error instanceof Error ? error.toString() : String(error),
      },
    });
    await this.dispose();
  };

  private performWebSearch = async (query: string): Promise<string> => {
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

    if (!TAVILY_API_KEY) {
      return JSON.stringify({
        error: "Web search is not available. API key not configured.",
      });
    }

    console.log(`Performing web search for: "${query}"`);

    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TAVILY_API_KEY}`,
        },
        body: JSON.stringify({
          query: query,
          search_depth: "advanced",
          max_results: 5,
          include_answer: true,
          include_raw_content: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Tavily search failed for query "${query}":`, errorText);
        return JSON.stringify({
          error: `Search failed with status: ${response.status}`,
          details: errorText,
        });
      }

      const data = await response.json();
      console.log(`Tavily search successful for query "${query}"`);

      return JSON.stringify(data);
    } catch (error) {
      console.error(
        `An exception occurred during web search for "${query}":`,
        error
      );
      return JSON.stringify({
        error: "An exception occurred during the search.",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}

