import { GoogleGenerativeAI, GenerativeModel, ChatSession, SchemaType } from "@google/generative-ai";
import type { Channel, DefaultGenerics, Event, StreamChat } from "stream-chat";
import type { AIAgent } from "../types";
import { GeminiResponseHandler } from "./GeminiResponseHandler";

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

export class GeminiAgent implements AIAgent {
  private genAI?: GoogleGenerativeAI;
  private model?: GenerativeModel;
  private chatSession?: ChatSession;
  private lastInteractionTs = Date.now();
  private conversationHistory: Array<{ role: string; parts: string | Array<{ functionResponse?: any; text?: string }> }> = [];

  private handlers: GeminiResponseHandler[] = [];

  constructor(
    readonly chatClient: StreamChat,
    readonly channel: Channel
  ) {}

  dispose = async () => {
    this.chatClient.off("message.new", this.handleMessage);
    await this.chatClient.disconnectUser();

    this.handlers.forEach((handler) => handler.dispose());
    this.handlers = [];
    this.conversationHistory = [];
  };

  get user() {
    return this.chatClient.user;
  }

  getLastInteraction = (): number => this.lastInteractionTs;

  init = async () => {
    const apiKey = process.env.GEMINI_API_KEY as string | undefined;
    if (!apiKey) {
      throw new Error("Gemini API key is required. Please set GEMINI_API_KEY environment variable.");
    }

    try {
      this.genAI = new GoogleGenerativeAI(apiKey);
      
      // Initialize the model with system instructions and function calling
      this.model = this.genAI.getGenerativeModel({
        model: "gemini-2.5-pro",
        systemInstruction: this.getWritingAssistantPrompt(),
        tools: [
          {
            functionDeclarations: [
              {
                name: "web_search",
                description:
                  "Search the web for current information, news, facts, or research on any topic",
                parameters: {
                  type: SchemaType.OBJECT,
                  properties: {
                    query: {
                      type: SchemaType.STRING,
                      description: "The search query to find information about",
                    },
                  },
                  required: ["query"],
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.7,
        },
      });

      // Start a new chat session
      this.chatSession = this.model.startChat({
        history: [],
      });

      this.chatClient.on("message.new", this.handleMessage);
    } catch (error) {
      if (isQuotaError(error)) {
        const quotaError = new Error(formatQuotaErrorMessage(error));
        console.error("Gemini quota error during initialization:", error);
        throw quotaError;
      }
      throw error;
    }
  };

  private getWritingAssistantPrompt = (context?: string): string => {
    const currentDate = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    return `You are an expert Primary Level Mathematics Tutor. Your primary purpose is to help students solve primary level (elementary/grade 1-6) math problems.

**Your Core Capabilities:**
- Solve primary level mathematics problems including: addition, subtraction, multiplication, division, fractions, decimals, basic geometry, word problems, and number patterns.
- Explain solutions step-by-step in a clear and simple manner that primary school students can understand.
- Use visual representations, examples, and simple language appropriate for young learners.
- **Web Search**: You have the ability to search the web for current information using the 'web_search' tool when needed.
- **Current Date**: Today's date is ${currentDate}. Please use this for any time-sensitive queries.

**Crucial Instructions:**
1. **Focus ONLY on primary level mathematics** (typically ages 6-12, grades 1-6). Do not solve advanced mathematics, algebra, calculus, or high school level problems.
2. **Always show your work step-by-step** so students can learn the process, not just the answer.
3. **Use simple, age-appropriate language** and explain concepts clearly.
4. **For word problems**, break them down into smaller parts and identify what operation(s) are needed.
5. **ALWAYS use the 'web_search' tool when the user asks for current information, news, or facts.** Your internal knowledge is outdated.
6. When you use the 'web_search' tool, you will receive a JSON object with search results. **You MUST base your response on the information provided in that search result.**

**Response Format:**
- Start by identifying what type of math problem it is.
- Show all steps clearly and explain what you're doing at each step.
- Use simple language and avoid complex mathematical jargon.
- Provide the final answer clearly.
- If it's a word problem, explain how you translated it into a math equation.

**Math Context**: ${context || "Primary level mathematics problem solving."}

Your goal is to help students understand and solve primary level math problems with clear, step-by-step explanations.`;
  };

  private handleMessage = async (e: Event<DefaultGenerics>) => {
    if (!this.genAI || !this.model || !this.chatSession) {
      console.log("Gemini not initialized");
      return;
    }

    if (!e.message || e.message.ai_generated) {
      return;
    }

    const message = e.message.text;
    if (!message) return;

    this.lastInteractionTs = Date.now();

    const writingTask = (e.message.custom as { writingTask?: string })
      ?.writingTask;
    const context = writingTask ? `Writing Task: ${writingTask}` : undefined;

    let channelMessage;
    try {
      // Create a placeholder message for the AI response
      const result = await this.channel.sendMessage({
        text: "",
        ai_generated: true,
      });
      channelMessage = result.message;

      await this.channel.sendEvent({
        type: "ai_indicator.update",
        ai_state: "AI_STATE_THINKING",
        cid: channelMessage.cid,
        message_id: channelMessage.id,
      });

      // If we have context, we need to update the system instruction
      // For now, we'll add it as part of the user message
      const userMessage = context ? `[Context: ${context}]\n\n${message}` : message;

      // Create a new handler for this message
      const handler = new GeminiResponseHandler(
        this.genAI,
        this.model,
        this.chatSession,
        this.chatClient,
        this.channel,
        channelMessage,
        () => this.removeHandler(handler)
      );

      // Store the user message in the handler so it can send it
      (handler as any).userMessage = userMessage;

      this.handlers.push(handler);
      void handler.run();
    } catch (error) {
      console.error("Error handling message:", error);
      
      // If we created a channel message but got an error, update it with the error
      if (channelMessage) {
        if (isQuotaError(error)) {
          await this.channel.sendEvent({
            type: "ai_indicator.update",
            ai_state: "AI_STATE_ERROR",
            cid: channelMessage.cid,
            message_id: channelMessage.id,
          });
          await this.chatClient.partialUpdateMessage(channelMessage.id, {
            set: {
              text: formatQuotaErrorMessage(error),
            },
          });
        } else {
          await this.channel.sendEvent({
            type: "ai_indicator.update",
            ai_state: "AI_STATE_ERROR",
            cid: channelMessage.cid,
            message_id: channelMessage.id,
          });
          await this.chatClient.partialUpdateMessage(channelMessage.id, {
            set: {
              text: error instanceof Error ? error.message : "Error processing message",
            },
          });
        }
      }
    }
  };

  private removeHandler = (handlerToRemove: GeminiResponseHandler) => {
    this.handlers = this.handlers.filter(
      (handler) => handler !== handlerToRemove
    );
  };
}

