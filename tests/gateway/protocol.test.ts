import { describe, expect, it } from 'vitest'
import { convertRequest, convertResponse, getRequestModel } from '../../src/main/gateway'

const timestamp = 1_700_000_000_000

describe('gateway protocol conversion', () => {
  it('converts Anthropic messages and tools to OpenAI chat', () => {
    const converted = convertRequest('anthropic-messages', 'openai-chat', {
      model: 'source-model',
      system: 'Be concise.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      max_tokens: 128,
      tools: [{ name: 'lookup', description: 'Find a value', input_schema: { type: 'object' } }]
    }, 'target-model')

    expect(converted.body).toMatchObject({
      model: 'target-model',
      max_tokens: 128,
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' }
      ],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Find a value' } }]
    })
  })

  it('converts an OpenAI chat response to Anthropic usage and tool blocks', () => {
    const converted = convertResponse('openai-chat', 'anthropic-messages', {
      id: 'chat-1',
      model: 'target-model',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Checking',
          tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"id":1}' } }]
        }
      }],
      usage: { prompt_tokens: 12, completion_tokens: 5 }
    }, 'fallback-model')

    expect(converted).toMatchObject({
      id: 'chat-1',
      type: 'message',
      model: 'target-model',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Checking' },
        { type: 'tool_use', id: 'call-1', name: 'lookup', input: { id: 1 } }
      ],
      usage: { input_tokens: 12, output_tokens: 5 }
    })
  })

  it('reads and decodes a Gemini model from the request path', () => {
    expect(getRequestModel('gemini', {}, '/v1beta/models/gemini-2.5%20pro:generateContent'))
      .toBe('gemini-2.5 pro')
  })

  it('converts OpenAI chat requests to Gemini contents and generation config', () => {
    const converted = convertRequest('openai-chat', 'gemini', {
      model: 'source-model',
      messages: [
        { role: 'system', content: 'Be precise.' },
        { role: 'user', content: 'Hello' }
      ],
      max_tokens: 64,
      temperature: 0.2,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
    }, 'gemini-target')

    expect(converted).toMatchObject({
      protocol: 'gemini',
      model: 'gemini-target',
      body: {
        systemInstruction: { parts: [{ text: 'Be precise.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        generationConfig: { maxOutputTokens: 64, temperature: 0.2 },
        tools: [{ functionDeclarations: [{ name: 'lookup', parameters: { type: 'object' } }] }]
      }
    })
  })

  it('composes non-chat response conversions through the chat representation', () => {
    const converted = convertResponse('anthropic-messages', 'openai-responses', {
      id: 'message-1',
      model: 'claude-model',
      content: [{ type: 'text', text: 'Hello from Claude' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 4 }
    }, 'fallback-model', () => timestamp)

    expect(converted).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'claude-model',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello from Claude' }] }],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }
    })
  })
})
