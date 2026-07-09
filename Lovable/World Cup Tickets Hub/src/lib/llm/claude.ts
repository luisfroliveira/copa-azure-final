// =============================================================================
// Story 2.5 / F5 — Adapter Claude (Anthropic Messages API, AC-10).
//
// Endpoint/modelo pinados por ADE-002 Inv 3 (anti-hallucination AC-15):
//   Base oficial: https://api.anthropic.com/v1
//   Method:       /messages
//   Function calling: campo `tools[]` (input_schema) + blocos `tool_use` /
//                      `tool_result` no `content` das mensagens.
//   Fonte: https://docs.claude.com/en/api/messages
//
// SEGURANÇA (decisão de chave): a API key NÃO vai no bundle. O front chama o
// PROXY server-side (llmFetch) que injeta a key como header x-api-key e
// encaminha ao endpoint oficial. Ver src/lib/llm/proxy.ts e
// src/Fifa2026.V2.McpServer/Llm/LlmProxyEndpoints.cs (rota /llm/claude/*).
// =============================================================================

import type { McpToolDefinition } from '@/lib/mcpTools';
import { llmFetch } from '@/lib/llm/proxy';
import type { ChatMessage, LlmProvider, LlmTurn, ToolCallRequest, ToolCallResult } from '@/lib/llm/types';

// Sobrescrevível por VITE_CLAUDE_MODEL. Default: modelo Sonnet atual.
const MODEL = import.meta.env.VITE_CLAUDE_MODEL ?? 'claude-sonnet-4-5';
const MAX_TOKENS = 4096;

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude' as const;

  async chat(
    messages: ChatMessage[],
    tools: McpToolDefinition[],
    toolResults: ToolCallResult[],
  ): Promise<LlmTurn> {
    // Anthropic trata `system` como campo separado, não como mensagem no array.
    const systemMessages = messages.filter((m) => m.role === 'system');
    const system = systemMessages.map((m) => m.content).join('\n\n') || undefined;

    const claudeMessages: ClaudeMessage[] = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

    // Resultados de tools do turno anterior → mensagem user com blocos tool_result
    // (protocolo Anthropic: tool_result sempre volta em uma mensagem role:user).
    if (toolResults.length > 0) {
      claudeMessages.push({
        role: 'user',
        content: toolResults.map((tr) => ({
          type: 'tool_result',
          tool_use_id: tr.id,
          content: tr.content,
        })),
      });
    }

    const body = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: claudeMessages,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    };

    const data = (await llmFetch('claude', '/messages', body)) as {
      content?: ClaudeContentBlock[];
    };

    const blocks: ClaudeContentBlock[] = data?.content ?? [];
    const text = blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const toolCalls: ToolCallRequest[] = blocks
      .filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        name: b.name,
        arguments: b.input ?? {},
      }));

    return { text, toolCalls };
  }
}
