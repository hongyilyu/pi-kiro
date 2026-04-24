// Stateful streaming parser that splits thinking tag content from text.
//
// Kiro returns thinking inline as `<thinking>...</thinking>` inside the text
// stream. We separate it into structured ThinkingContent blocks so pi's UI
// can display reasoning distinctly. Handles four tag variants and tokens
// that straddle chunk boundaries.

import type { AssistantMessage, AssistantMessageEventStream, TextContent, ThinkingContent } from "@mariozechner/pi-ai";
import { log } from "./debug";

export const THINKING_START_TAG = "<thinking>";
export const THINKING_END_TAG = "</thinking>";

const THINKING_TAG_VARIANTS: Array<{ open: string; close: string }> = [
  { open: "<thinking>", close: "</thinking>" },
  { open: "<think>", close: "</think>" },
  { open: "<reasoning>", close: "</reasoning>" },
  { open: "<thought>", close: "</thought>" },
];

/** Longest suffix of `text` that matches a prefix of `tag`. */
function trailingPrefixLength(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

function maxTrailingPrefixLength(text: string, tags: string[]): number {
  let max = 0;
  for (const tag of tags) {
    max = Math.max(max, trailingPrefixLength(text, tag));
  }
  return max;
}

export class ThinkingTagParser {
  private textBuffer = "";
  private inThinking = false;
  private thinkingExtracted = false;
  private thinkingBlockIndex: number | null = null;
  private textBlockIndex: number | null = null;
  private lastTextBlockIndex: number | null = null;
  private activeEndTag: string = THINKING_END_TAG;

  constructor(
    private output: AssistantMessage,
    private stream: AssistantMessageEventStream,
  ) {}

  processChunk(chunk: string): void {
    this.textBuffer += chunk;
    if (log.isDebug()) {
      log.debug("thinking.chunk", {
        chunkLen: chunk.length,
        bufferLen: this.textBuffer.length,
        inThinking: this.inThinking,
        thinkingExtracted: this.thinkingExtracted,
      });
    }
    while (this.textBuffer.length > 0) {
      const prev = this.textBuffer.length;
      if (!this.inThinking && !this.thinkingExtracted) {
        this.processBeforeThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.inThinking) {
        this.processInsideThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.thinkingExtracted) {
        this.processAfterThinking();
        break;
      }
      if (this.textBuffer.length >= prev) break;
    }
  }

  finalize(): void {
    if (log.isDebug()) {
      log.debug("thinking.finalize", {
        bufferLen: this.textBuffer.length,
        inThinking: this.inThinking,
        thinkingExtracted: this.thinkingExtracted,
        textBlockIndex: this.textBlockIndex,
        thinkingBlockIndex: this.thinkingBlockIndex,
      });
    }
    if (this.textBuffer.length === 0) return;
    if (this.inThinking && this.thinkingBlockIndex !== null) {
      const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent | undefined;
      if (block) {
        block.thinking += this.textBuffer;
        this.stream.push({
          type: "thinking_delta",
          contentIndex: this.thinkingBlockIndex,
          delta: this.textBuffer,
          partial: this.output,
        });
        this.stream.push({
          type: "thinking_end",
          contentIndex: this.thinkingBlockIndex,
          content: block.thinking,
          partial: this.output,
        });
      }
    } else {
      this.emitText(this.textBuffer);
    }
    this.textBuffer = "";
  }

  getTextBlockIndex(): number | null {
    return this.textBlockIndex ?? this.lastTextBlockIndex;
  }

  private processBeforeThinking(): void {
    let bestPos = -1;
    let bestVariant: (typeof THINKING_TAG_VARIANTS)[number] | null = null;
    for (const variant of THINKING_TAG_VARIANTS) {
      const pos = this.textBuffer.indexOf(variant.open);
      if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
        bestPos = pos;
        bestVariant = variant;
      }
    }
    if (bestPos !== -1 && bestVariant) {
      if (log.isDebug()) {
        log.debug("thinking.open", { tag: bestVariant.open, at: bestPos });
      }
      if (bestPos > 0) this.emitText(this.textBuffer.slice(0, bestPos));
      this.textBuffer = this.textBuffer.slice(bestPos + bestVariant.open.length);
      this.activeEndTag = bestVariant.close;
      this.inThinking = true;
      return;
    }

    const trailing = maxTrailingPrefixLength(
      this.textBuffer,
      THINKING_TAG_VARIANTS.map((v) => v.open),
    );
    const safeLen = this.textBuffer.length - trailing;
    if (safeLen > 0) {
      this.emitText(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processInsideThinking(): void {
    const endPos = this.textBuffer.indexOf(this.activeEndTag);
    if (endPos !== -1) {
      if (log.isDebug()) {
        log.debug("thinking.close", { tag: this.activeEndTag, at: endPos });
      }
      if (endPos > 0) this.emitThinking(this.textBuffer.slice(0, endPos));
      if (this.thinkingBlockIndex !== null) {
        const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent | undefined;
        if (block) {
          this.stream.push({
            type: "thinking_end",
            contentIndex: this.thinkingBlockIndex,
            content: block.thinking,
            partial: this.output,
          });
        }
      }
      this.textBuffer = this.textBuffer.slice(endPos + this.activeEndTag.length);
      this.inThinking = false;
      this.thinkingExtracted = true;
      this.lastTextBlockIndex = this.textBlockIndex;
      this.textBlockIndex = null;
      if (this.textBuffer.startsWith("\n\n")) this.textBuffer = this.textBuffer.slice(2);
      return;
    }

    const trailing = trailingPrefixLength(this.textBuffer, this.activeEndTag);
    const safeLen = this.textBuffer.length - trailing;
    if (safeLen > 0) {
      this.emitThinking(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processAfterThinking(): void {
    this.emitText(this.textBuffer);
    this.textBuffer = "";
  }

  private emitText(text: string): void {
    if (!text) return;
    if (this.textBlockIndex === null) {
      this.textBlockIndex = this.output.content.length;
      this.output.content.push({ type: "text", text: "" });
      this.stream.push({ type: "text_start", contentIndex: this.textBlockIndex, partial: this.output });
    }
    const block = this.output.content[this.textBlockIndex] as TextContent | undefined;
    if (!block) return;
    block.text += text;
    this.stream.push({
      type: "text_delta",
      contentIndex: this.textBlockIndex,
      delta: text,
      partial: this.output,
    });
  }

  private emitThinking(thinking: string): void {
    if (!thinking) return;
    if (this.thinkingBlockIndex === null) {
      if (this.textBlockIndex !== null) {
        // Thinking arrived after text; splice it before the text block so
        // content order is thinking → text.
        this.thinkingBlockIndex = this.textBlockIndex;
        this.output.content.splice(this.thinkingBlockIndex, 0, { type: "thinking", thinking: "" });
        this.textBlockIndex = this.textBlockIndex + 1;
      } else {
        this.thinkingBlockIndex = this.output.content.length;
        this.output.content.push({ type: "thinking", thinking: "" });
      }
      this.stream.push({
        type: "thinking_start",
        contentIndex: this.thinkingBlockIndex,
        partial: this.output,
      });
    }
    const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent | undefined;
    if (!block) return;
    block.thinking += thinking;
    this.stream.push({
      type: "thinking_delta",
      contentIndex: this.thinkingBlockIndex,
      delta: thinking,
      partial: this.output,
    });
  }
}
