import type { Protocol } from '../../shared/types'
import type { ProtocolRequest } from './types'

type JsonObject = Record<string, unknown>

export class UnsupportedProtocolConversionError extends Error {
  constructor(from: Protocol, to: Protocol) {
    super(`Conversion from ${from} to ${to} is not supported`)
    this.name = 'UnsupportedProtocolConversionError'
  }
}

export function getRequestModel(protocol: Protocol, body: JsonObject, pathname?: string): string {
  if (protocol === 'gemini') {
    const modelFromPath = pathname?.match(/\/models\/([^/:?]+)/)?.[1]
    if (modelFromPath) return decodeURIComponent(modelFromPath)
  }
  const model = body.model
  return typeof model === 'string' ? model : ''
}

export function convertRequest(
  from: Protocol,
  to: Protocol,
  body: JsonObject,
  targetModel: string
): ProtocolRequest {
  if (from === to) {
    return { protocol: to, body: withModel(body, to, targetModel), model: targetModel }
  }

  if (to === 'openai-chat') {
    if (from === 'anthropic-messages') {
      return { protocol: to, body: anthropicRequestToChat(body, targetModel), model: targetModel }
    }
    if (from === 'openai-responses') {
      return { protocol: to, body: responsesRequestToChat(body, targetModel), model: targetModel }
    }
    if (from === 'gemini') {
      return { protocol: to, body: geminiRequestToChat(body, targetModel), model: targetModel }
    }
  }
  if (from === 'openai-chat' && to === 'anthropic-messages') {
    return { protocol: to, body: chatRequestToAnthropic(body, targetModel), model: targetModel }
  }
  if (from === 'openai-chat' && to === 'openai-responses') {
    return { protocol: to, body: chatRequestToResponses(body, targetModel), model: targetModel }
  }
  if (from === 'openai-chat' && to === 'gemini') {
    return { protocol: to, body: chatRequestToGemini(body), model: targetModel }
  }
  if (from !== 'openai-chat' && to !== 'openai-chat') {
    const intermediate = convertRequest(from, 'openai-chat', body, targetModel)
    return convertRequest('openai-chat', to, intermediate.body, targetModel)
  }
  throw new UnsupportedProtocolConversionError(from, to)
}

export function convertResponse(
  from: Protocol,
  to: Protocol,
  body: JsonObject,
  fallbackModel: string,
  now = Date.now
): JsonObject {
  if (from === to) return body
  if (to === 'openai-chat') {
    if (from === 'anthropic-messages') return anthropicResponseToChat(body, fallbackModel, now)
    if (from === 'openai-responses') return responsesResponseToChat(body, fallbackModel, now)
    if (from === 'gemini') return geminiResponseToChat(body, fallbackModel, now)
  }
  if (from === 'openai-chat' && to === 'anthropic-messages') {
    return chatResponseToAnthropic(body, fallbackModel)
  }
  if (from === 'openai-chat' && to === 'openai-responses') {
    return chatResponseToResponses(body, fallbackModel)
  }
  if (from === 'openai-chat' && to === 'gemini') {
    return chatResponseToGemini(body, fallbackModel)
  }
  if (from !== 'openai-chat' && to !== 'openai-chat') {
    const intermediate = convertResponse(from, 'openai-chat', body, fallbackModel, now)
    return convertResponse('openai-chat', to, intermediate, fallbackModel, now)
  }
  throw new UnsupportedProtocolConversionError(from, to)
}

function withModel(body: JsonObject, protocol: Protocol, model: string): JsonObject {
  if (protocol === 'gemini') return { ...body }
  return { ...body, model }
}

function anthropicRequestToChat(body: JsonObject, model: string): JsonObject {
  const messages: JsonObject[] = []
  const system = textValue(body.system)
  if (system) messages.push({ role: 'system', content: system })
  for (const message of arrayOfObjects(body.messages)) {
    if (stringValue(message.role, 'user') === 'assistant') {
      messages.push(anthropicAssistantMessageToChat(message))
    } else {
      messages.push(...anthropicUserMessageToChat(message))
    }
  }
  const output: JsonObject = {
    model,
    messages,
    max_tokens: numberValue(body.max_tokens),
    stream: booleanValue(body.stream)
  }
  copyOptional(body, output, ['temperature', 'top_p', 'metadata'])
  const stopSequences = stringArray(body.stop_sequences)
  if (stopSequences !== undefined) output.stop = stopSequences
  const tools = anthropicToolsToChat(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = anthropicToolChoiceToChat(body.tool_choice)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  const anthropicToolChoice = objectValue(body.tool_choice)
  if (typeof anthropicToolChoice?.disable_parallel_tool_use === 'boolean') {
    output.parallel_tool_calls = !anthropicToolChoice.disable_parallel_tool_use
  }
  return omitUndefined(output)
}

function chatRequestToAnthropic(body: JsonObject, model: string): JsonObject {
  const messages: JsonObject[] = []
  const systemParts: string[] = []
  let pendingToolResults: JsonObject[] = []

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return
    messages.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }

  for (const message of arrayOfObjects(body.messages)) {
    const role = stringValue(message.role, 'user')
    if (role === 'system' || role === 'developer') {
      const content = chatContentToText(message.content)
      if (content) systemParts.push(content)
      continue
    }
    if (role === 'tool' || role === 'function') {
      pendingToolResults.push(chatToolMessageToAnthropicResult(message))
      continue
    }
    if (role === 'assistant') {
      flushToolResults()
      messages.push({ role: 'assistant', content: chatMessageToAnthropicContent(message) })
      continue
    }

    const content = chatMessageToAnthropicContent(message)
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: [...pendingToolResults, ...content] })
      pendingToolResults = []
    } else {
      messages.push({ role: 'user', content })
    }
  }
  flushToolResults()
  const output: JsonObject = {
    model,
    messages,
    max_tokens: numberValue(body.max_tokens) ?? 1024,
    stream: booleanValue(body.stream)
  }
  if (systemParts.length > 0) output.system = systemParts.join('\n\n')
  copyOptional(body, output, ['temperature', 'top_p', 'metadata'])
  const stopSequences = chatStopToAnthropic(body.stop)
  if (stopSequences !== undefined) output.stop_sequences = stopSequences
  const tools = chatToolsToAnthropic(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = chatToolChoiceToAnthropic(body.tool_choice, body.parallel_tool_calls)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  return omitUndefined(output)
}

function responsesRequestToChat(body: JsonObject, model: string): JsonObject {
  const messages: JsonObject[] = []
  const instructions = textValue(body.instructions)
  if (instructions) messages.push({ role: 'system', content: instructions })
  const input = body.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else {
    let functionCallMessage: JsonObject | undefined
    for (const item of arrayOfObjects(input)) {
      const type = stringValue(item.type)
      if (type === 'message' || (!type && typeof item.role === 'string')) {
        const message: JsonObject = {
          role: stringValue(item.role, 'user'),
          content: responsesContentToChat(item.content)
        }
        messages.push(message)
        functionCallMessage = stringValue(message.role) === 'assistant' ? message : undefined
        continue
      }
      if (type === 'function_call') {
        if (!functionCallMessage) {
          functionCallMessage = { role: 'assistant', content: null, tool_calls: [] }
          messages.push(functionCallMessage)
        }
        const toolCalls = arrayValue(functionCallMessage.tool_calls)
        functionCallMessage.tool_calls = [...toolCalls, responsesFunctionCallToChat(item)]
        continue
      }
      if (type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: stringValue(item.call_id, stringValue(item.id)),
          content: responsesFunctionOutputToChat(item.output)
        })
        functionCallMessage = undefined
        continue
      }
      functionCallMessage = undefined
    }
  }
  const output: JsonObject = {
    model,
    messages,
    max_tokens: numberValue(body.max_output_tokens),
    stream: booleanValue(body.stream)
  }
  copyOptional(body, output, ['temperature', 'top_p', 'metadata', 'parallel_tool_calls'])
  const tools = responsesToolsToChat(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = responsesToolChoiceToChat(body.tool_choice)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  return omitUndefined(output)
}

function chatRequestToResponses(body: JsonObject, model: string): JsonObject {
  const input: JsonObject[] = []
  const instructions: string[] = []
  for (const message of arrayOfObjects(body.messages)) {
    const role = stringValue(message.role, 'user')
    const content = chatContentToResponses(message.content)
    if (role === 'system' || role === 'developer') {
      const text = chatContentToText(message.content)
      if (text) instructions.push(text)
      continue
    }
    if (role === 'tool' || role === 'function') {
      input.push({
        type: 'function_call_output',
        call_id: stringValue(message.tool_call_id, stringValue(message.name)),
        output: chatToolOutputToResponses(message.content)
      })
      continue
    }
    if (role === 'assistant') {
      if (content.length > 0) input.push({ type: 'message', role: 'assistant', content: chatContentToResponses(message.content, true) })
      for (const toolCall of chatMessageToolCalls(message)) {
        input.push(chatFunctionCallToResponses(toolCall))
      }
      continue
    }
    input.push({ type: 'message', role, content })
  }
  const output: JsonObject = {
    model,
    input,
    max_output_tokens: numberValue(body.max_tokens),
    stream: booleanValue(body.stream)
  }
  if (instructions.length > 0) output.instructions = instructions.join('\n\n')
  copyOptional(body, output, ['temperature', 'top_p', 'metadata', 'parallel_tool_calls'])
  const tools = chatToolsToResponses(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = chatToolChoiceToResponses(body.tool_choice)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  return omitUndefined(output)
}

function geminiRequestToChat(body: JsonObject, model: string): JsonObject {
  const messages: JsonObject[] = []
  const pendingCallIds = new Map<string, string[]>()
  let generatedCallId = 0
  const systemInstruction = objectValue(body.systemInstruction) ?? objectValue(body.system_instruction)
  if (systemInstruction) {
    const text = geminiPartsToText(systemInstruction.parts)
    if (text) messages.push({ role: 'system', content: text })
  }
  for (const content of arrayOfObjects(body.contents)) {
    const parts = arrayOfObjects(content.parts)
    if (stringValue(content.role) === 'model') {
      const text = geminiPartsToText(parts)
      const toolCalls = parts.flatMap((part) => {
        const call = objectValue(part.functionCall) ?? objectValue(part.function_call)
        if (!call) return []
        const name = stringValue(call.name)
        const id = optionalString(call.id) ?? `call_gemini_${++generatedCallId}`
        const ids = pendingCallIds.get(name) ?? []
        ids.push(id)
        pendingCallIds.set(name, ids)
        return [{
          id,
          type: 'function',
          function: { name, arguments: jsonString(call.args ?? {}) }
        }]
      })
      const message: JsonObject = { role: 'assistant', content: text || null }
      if (toolCalls.length > 0) message.tool_calls = toolCalls
      messages.push(message)
      continue
    }

    const text = geminiPartsToText(parts)
    for (const part of parts) {
      const response = objectValue(part.functionResponse) ?? objectValue(part.function_response)
      if (!response) continue
      const name = stringValue(response.name)
      const queuedIds = pendingCallIds.get(name) ?? []
      const explicitId = optionalString(response.id)
      let id: string
      if (explicitId) {
        id = explicitId
        const queuedIndex = queuedIds.indexOf(explicitId)
        if (queuedIndex >= 0) queuedIds.splice(queuedIndex, 1)
      } else {
        id = queuedIds.shift() ?? `call_gemini_${++generatedCallId}`
      }
      pendingCallIds.set(name, queuedIds)
      messages.push({
        role: 'tool',
        tool_call_id: id,
        name,
        content: geminiFunctionResponseToChat(response.response)
      })
    }
    if (text || !parts.some((part) => objectValue(part.functionResponse) ?? objectValue(part.function_response))) {
      messages.push({ role: 'user', content: text })
    }
  }
  const generationConfig = objectValue(body.generationConfig) ?? objectValue(body.generation_config) ?? {}
  const output: JsonObject = {
    model,
    messages,
    max_tokens: numberValue(generationConfig.maxOutputTokens),
    temperature: numberValue(generationConfig.temperature),
    top_p: numberValue(generationConfig.topP),
    stop: stringArray(generationConfig.stopSequences),
    stream: booleanValue(body.stream)
  }
  const tools = geminiToolsToChat(body.tools)
  if (tools.length > 0) output.tools = tools
  const toolChoice = geminiToolChoiceToChat(body.toolConfig ?? body.tool_config)
  if (toolChoice !== undefined) output.tool_choice = toolChoice
  return omitUndefined(output)
}

function chatRequestToGemini(body: JsonObject): JsonObject {
  const contents: JsonObject[] = []
  const systemParts: string[] = []
  const callNames = new Map<string, string>()
  let pendingToolResponses: JsonObject[] = []

  const flushToolResponses = (): void => {
    if (pendingToolResponses.length === 0) return
    contents.push({ role: 'user', parts: pendingToolResponses })
    pendingToolResponses = []
  }

  for (const message of arrayOfObjects(body.messages)) {
    const role = stringValue(message.role, 'user')
    if (role === 'system' || role === 'developer') {
      const text = chatContentToText(message.content)
      if (text) systemParts.push(text)
      continue
    }
    if (role === 'tool' || role === 'function') {
      const id = stringValue(message.tool_call_id)
      const name = stringValue(message.name, callNames.get(id) ?? '')
      pendingToolResponses.push({
        functionResponse: omitUndefined({
          id: optionalString(id),
          name,
          response: chatToolContentToGeminiResponse(message.content)
        })
      })
      continue
    }

    const parts = chatMessageToGeminiParts(message)
    if (role === 'assistant') {
      flushToolResponses()
      for (const toolCall of chatMessageToolCalls(message)) {
        const definition = objectValue(toolCall.function) ?? {}
        const id = stringValue(toolCall.id)
        if (id) callNames.set(id, stringValue(definition.name))
      }
      contents.push({ role: 'model', parts })
      continue
    }

    if (pendingToolResponses.length > 0) {
      contents.push({ role: 'user', parts: [...pendingToolResponses, ...parts] })
      pendingToolResponses = []
    } else {
      contents.push({ role: 'user', parts })
    }
  }
  flushToolResponses()

  const generationConfig = omitUndefined({
    maxOutputTokens: numberValue(body.max_tokens) ?? numberValue(body.max_completion_tokens),
    temperature: numberValue(body.temperature),
    topP: numberValue(body.top_p),
    stopSequences: stringArray(body.stop)
  })
  const output: JsonObject = { contents }
  if (systemParts.length > 0) output.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] }
  if (Object.keys(generationConfig).length > 0) output.generationConfig = generationConfig

  const functionDeclarations = arrayOfObjects(body.tools).flatMap((tool) => {
    const definition = objectValue(tool.function)
    if (stringValue(tool.type) !== 'function' || !definition) return []
    return [{
      name: stringValue(definition.name),
      description: stringValue(definition.description),
      parameters: objectValue(definition.parameters) ?? { type: 'object', properties: {} }
    }]
  })
  if (functionDeclarations.length > 0) output.tools = [{ functionDeclarations }]
  const toolConfig = chatToolChoiceToGemini(body.tool_choice)
  if (toolConfig !== undefined) output.toolConfig = toolConfig
  return output
}

function anthropicResponseToChat(body: JsonObject, fallbackModel: string, now: () => number): JsonObject {
  const content = arrayOfObjects(body.content)
  const text = content.filter((block) => stringValue(block.type) === 'text').map((block) => stringValue(block.text)).join('')
  const toolCalls = content.filter((block) => stringValue(block.type) === 'tool_use').map((block) => ({
    id: stringValue(block.id),
    type: 'function',
    function: { name: stringValue(block.name), arguments: JSON.stringify(block.input ?? {}) }
  }))
  const message: JsonObject = { role: 'assistant', content: text || null }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const usage = objectValue(body.usage)
  return {
    id: stringValue(body.id, `chatcmpl_${now()}`),
    object: 'chat.completion',
    created: Math.floor(now() / 1000),
    model: stringValue(body.model, fallbackModel),
    choices: [{ index: 0, message, finish_reason: anthropicStopReasonToChat(stringValue(body.stop_reason)) }],
    usage: {
      prompt_tokens: numberValue(usage?.input_tokens) ?? 0,
      completion_tokens: numberValue(usage?.output_tokens) ?? 0,
      total_tokens: (numberValue(usage?.input_tokens) ?? 0) + (numberValue(usage?.output_tokens) ?? 0)
    }
  }
}

function chatResponseToAnthropic(body: JsonObject, fallbackModel: string): JsonObject {
  const choice = objectValue(arrayValue(body.choices)[0]) ?? {}
  const message = objectValue(choice.message) ?? {}
  const content = chatMessageToAnthropicContent(message)
  const usage = objectValue(body.usage)
  return {
    id: stringValue(body.id, `msg_${Date.now()}`),
    type: 'message',
    role: 'assistant',
    model: stringValue(body.model, fallbackModel),
    content,
    stop_reason: chatFinishReasonToAnthropic(stringValue(choice.finish_reason)),
    stop_sequence: null,
    usage: {
      input_tokens: numberValue(usage?.prompt_tokens) ?? 0,
      output_tokens: numberValue(usage?.completion_tokens) ?? 0
    }
  }
}

function responsesResponseToChat(body: JsonObject, fallbackModel: string, now: () => number): JsonObject {
  const output = arrayOfObjects(body.output)
  const messageItem = output.find((item) => stringValue(item.type) === 'message')
  const text = messageItem ? responsesContentToText(messageItem.content) : ''
  const toolCalls = output.filter((item) => stringValue(item.type) === 'function_call').map((item) => ({
    id: stringValue(item.call_id, stringValue(item.id)),
    type: 'function',
    function: { name: stringValue(item.name), arguments: stringValue(item.arguments, '{}') }
  }))
  const message: JsonObject = { role: 'assistant', content: text || null }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const usage = objectValue(body.usage)
  const inputTokens = numberValue(usage?.input_tokens) ?? 0
  const outputTokens = numberValue(usage?.output_tokens) ?? 0
  return {
    id: stringValue(body.id, `chatcmpl_${now()}`),
    object: 'chat.completion',
    created: Math.floor(now() / 1000),
    model: stringValue(body.model, fallbackModel),
    choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
  }
}

function chatResponseToResponses(body: JsonObject, fallbackModel: string): JsonObject {
  const choice = objectValue(arrayValue(body.choices)[0]) ?? {}
  const message = objectValue(choice.message) ?? {}
  const content: JsonObject[] = []
  const text = chatContentToText(message.content)
  if (text) content.push({ type: 'output_text', text, annotations: [] })
  const output: JsonObject[] = []
  if (content.length > 0) {
    output.push({ id: `msg_${stringValue(body.id, Date.now().toString())}`, type: 'message', role: 'assistant', status: 'completed', content })
  }
  for (const toolCall of arrayOfObjects(message.tool_calls)) {
    const functionValue = objectValue(toolCall.function) ?? {}
    output.push({
      type: 'function_call',
      id: stringValue(toolCall.id),
      call_id: stringValue(toolCall.id),
      name: stringValue(functionValue.name),
      arguments: stringValue(functionValue.arguments, '{}'),
      status: 'completed'
    })
  }
  if (output.length === 0) {
    output.push({ id: `msg_${stringValue(body.id, Date.now().toString())}`, type: 'message', role: 'assistant', status: 'completed', content })
  }
  const usage = objectValue(body.usage)
  const inputTokens = numberValue(usage?.prompt_tokens) ?? 0
  const outputTokens = numberValue(usage?.completion_tokens) ?? 0
  return {
    id: `resp_${stringValue(body.id, Date.now().toString())}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: stringValue(body.model, fallbackModel),
    output,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
  }
}

function geminiResponseToChat(body: JsonObject, fallbackModel: string, now: () => number): JsonObject {
  const candidate = objectValue(arrayValue(body.candidates)[0]) ?? {}
  const content = objectValue(candidate.content) ?? {}
  const text = geminiPartsToText(content.parts)
  let generatedCallId = 0
  const toolCalls = arrayOfObjects(content.parts).flatMap((part) => {
    const call = objectValue(part.functionCall)
    return call ? [{
      id: stringValue(call.id, `call_${now()}_${++generatedCallId}`),
      type: 'function',
      function: { name: stringValue(call.name), arguments: jsonString(call.args ?? {}) }
    }] : []
  })
  const message: JsonObject = { role: 'assistant', content: text || null }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const usage = objectValue(body.usageMetadata) ?? objectValue(body.usage_metadata)
  const inputTokens = numberValue(usage?.promptTokenCount) ?? 0
  const outputTokens = numberValue(usage?.candidatesTokenCount) ?? 0
  return {
    id: `chatcmpl_${now()}`,
    object: 'chat.completion',
    created: Math.floor(now() / 1000),
    model: fallbackModel,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0
        ? 'tool_calls'
        : geminiFinishReasonToChat(stringValue(candidate.finishReason))
    }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
  }
}

function chatResponseToGemini(body: JsonObject, fallbackModel: string): JsonObject {
  const choice = objectValue(arrayValue(body.choices)[0]) ?? {}
  const message = objectValue(choice.message) ?? {}
  const parts: JsonObject[] = []
  const text = chatContentToText(message.content)
  if (text) parts.push({ text })
  for (const toolCall of arrayOfObjects(message.tool_calls)) {
    const functionValue = objectValue(toolCall.function) ?? {}
    let args: JsonObject = {}
    try {
      const parsed: unknown = JSON.parse(stringValue(functionValue.arguments, '{}'))
      args = objectValue(parsed) ?? {}
    } catch {
      args = {}
    }
    parts.push({
      functionCall: omitUndefined({
        id: optionalString(toolCall.id),
        name: stringValue(functionValue.name),
        args
      })
    })
  }
  const usage = objectValue(body.usage)
  const promptTokens = numberValue(usage?.prompt_tokens) ?? 0
  const candidateTokens = numberValue(usage?.completion_tokens) ?? 0
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: chatFinishReasonToGemini(stringValue(choice.finish_reason)) }],
    usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: candidateTokens, totalTokenCount: promptTokens + candidateTokens },
    modelVersion: stringValue(body.model, fallbackModel)
  }
}

function anthropicAssistantMessageToChat(message: JsonObject): JsonObject {
  if (typeof message.content === 'string') return { role: 'assistant', content: message.content }

  const blocks = arrayOfObjects(message.content)
  const text = blocks
    .filter((block) => stringValue(block.type) === 'text')
    .map((block) => stringValue(block.text))
    .join('')
  const toolCalls = blocks
    .filter((block) => stringValue(block.type) === 'tool_use')
    .map((block) => ({
      id: stringValue(block.id),
      type: 'function',
      function: {
        name: stringValue(block.name),
        arguments: jsonString(block.input ?? {})
      }
    }))
  const converted: JsonObject = { role: 'assistant', content: text || null }
  if (toolCalls.length > 0) converted.tool_calls = toolCalls
  return converted
}

function anthropicUserMessageToChat(message: JsonObject): JsonObject[] {
  if (typeof message.content === 'string') return [{ role: 'user', content: message.content }]

  const converted: JsonObject[] = []
  let text = ''
  const flushText = (): void => {
    if (!text) return
    converted.push({ role: 'user', content: text })
    text = ''
  }

  for (const block of arrayOfObjects(message.content)) {
    if (stringValue(block.type) === 'tool_result') {
      flushText()
      const toolMessage: JsonObject = {
        role: 'tool',
        tool_call_id: stringValue(block.tool_use_id),
        content: anthropicToolResultToChat(block.content)
      }
      if (typeof block.is_error === 'boolean') toolMessage.is_error = block.is_error
      converted.push(toolMessage)
    } else if (stringValue(block.type) === 'text') {
      text += stringValue(block.text)
    }
  }
  flushText()
  return converted.length > 0 ? converted : [{ role: 'user', content: '' }]
}

function anthropicToolResultToChat(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const content = arrayOfObjects(value).flatMap((block) => {
      if (stringValue(block.type) !== 'text') return []
      return [{ type: 'text', text: stringValue(block.text) }]
    })
    if (content.length > 0) return content
  }
  return jsonString(value ?? '')
}

function chatToolMessageToAnthropicResult(message: JsonObject): JsonObject {
  return omitUndefined({
    type: 'tool_result',
    tool_use_id: stringValue(message.tool_call_id, stringValue(message.name)),
    content: chatToolContentToAnthropic(message.content),
    is_error: booleanValue(message.is_error)
  })
}

function chatToolContentToAnthropic(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const blocks = arrayOfObjects(value).flatMap((part) => {
      const text = stringValue(part.text)
      return text ? [{ type: 'text', text }] : []
    })
    if (blocks.length > 0) return blocks
  }
  return jsonString(value ?? '')
}

function responsesFunctionCallToChat(item: JsonObject): JsonObject {
  return {
    id: stringValue(item.call_id, stringValue(item.id)),
    type: 'function',
    function: {
      name: stringValue(item.name),
      arguments: typeof item.arguments === 'string' ? item.arguments : jsonString(item.arguments ?? {})
    }
  }
}

function responsesFunctionOutputToChat(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const content = arrayOfObjects(value).flatMap((item) => {
      const text = stringValue(item.text)
      return text ? [{ type: 'text', text }] : []
    })
    if (content.length > 0) return content
  }
  return jsonString(value ?? '')
}

function chatMessageToolCalls(message: JsonObject): JsonObject[] {
  return arrayOfObjects(message.tool_calls)
}

function chatFunctionCallToResponses(toolCall: JsonObject): JsonObject {
  const definition = objectValue(toolCall.function) ?? {}
  return {
    type: 'function_call',
    call_id: stringValue(toolCall.id),
    name: stringValue(definition.name),
    arguments: typeof definition.arguments === 'string'
      ? definition.arguments
      : jsonString(definition.arguments ?? {})
  }
}

function chatToolOutputToResponses(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const output = arrayOfObjects(value).flatMap((part) => {
      const text = stringValue(part.text)
      return text ? [{ type: 'input_text', text }] : []
    })
    if (output.length > 0) return output
  }
  return jsonString(value ?? '')
}

function anthropicToolsToChat(value: unknown): JsonObject[] {
  return arrayOfObjects(value).flatMap((tool) => {
    const name = optionalString(tool.name)
    if (!name) return []
    return [{
      type: 'function',
      function: omitUndefined({
        name,
        description: optionalString(tool.description),
        parameters: objectValue(tool.input_schema) ?? { type: 'object', properties: {} }
      })
    }]
  })
}

function responsesToolsToChat(value: unknown): JsonObject[] {
  return arrayOfObjects(value).flatMap((tool) => {
    if (stringValue(tool.type) !== 'function') return []
    const name = optionalString(tool.name)
    if (!name) return []
    return [{
      type: 'function',
      function: omitUndefined({
        name,
        description: optionalString(tool.description),
        parameters: objectValue(tool.parameters) ?? { type: 'object', properties: {} },
        strict: booleanValue(tool.strict)
      })
    }]
  })
}

function chatToolsToAnthropic(value: unknown): JsonObject[] {
  return arrayOfObjects(value).flatMap((tool) => {
    const definition = objectValue(tool.function)
    if (stringValue(tool.type) !== 'function' || !definition) return []
    const name = optionalString(definition.name)
    if (!name) return []
    return [omitUndefined({
      name,
      description: optionalString(definition.description),
      input_schema: objectValue(definition.parameters) ?? { type: 'object', properties: {} }
    })]
  })
}

function chatToolsToResponses(value: unknown): JsonObject[] {
  return arrayOfObjects(value).flatMap((tool) => {
    const definition = objectValue(tool.function)
    if (stringValue(tool.type) !== 'function' || !definition) return []
    const name = optionalString(definition.name)
    if (!name) return []
    return [omitUndefined({
      type: 'function',
      name,
      description: optionalString(definition.description),
      parameters: objectValue(definition.parameters) ?? { type: 'object', properties: {} },
      strict: booleanValue(definition.strict)
    })]
  })
}

function anthropicToolChoiceToChat(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === 'any') return 'required'
    if (value === 'auto' || value === 'none') return value
    return undefined
  }
  const choice = objectValue(value)
  if (!choice) return undefined
  const type = stringValue(choice.type)
  if (type === 'any') return 'required'
  if (type === 'auto' || type === 'none') return type
  if (type === 'tool' && optionalString(choice.name)) {
    return { type: 'function', function: { name: stringValue(choice.name) } }
  }
  return undefined
}

function responsesToolChoiceToChat(value: unknown): unknown {
  if (typeof value === 'string') {
    return value === 'auto' || value === 'required' || value === 'none' ? value : undefined
  }
  const choice = objectValue(value)
  if (stringValue(choice?.type) === 'function' && optionalString(choice?.name)) {
    return { type: 'function', function: { name: stringValue(choice?.name) } }
  }
  return undefined
}

function chatToolChoiceToAnthropic(value: unknown, parallelToolCalls: unknown): unknown {
  let choice: JsonObject | undefined
  if (typeof value === 'string') {
    if (value === 'auto' || value === 'none') choice = { type: value }
    if (value === 'required') choice = { type: 'any' }
  } else {
    const chatChoice = objectValue(value)
    const definition = objectValue(chatChoice?.function)
    if (stringValue(chatChoice?.type) === 'function' && optionalString(definition?.name)) {
      choice = { type: 'tool', name: stringValue(definition?.name) }
    }
  }
  if (typeof parallelToolCalls === 'boolean') {
    choice ??= { type: 'auto' }
    choice.disable_parallel_tool_use = !parallelToolCalls
  }
  return choice
}

function chatToolChoiceToResponses(value: unknown): unknown {
  if (typeof value === 'string') {
    return value === 'auto' || value === 'required' || value === 'none' ? value : undefined
  }
  const choice = objectValue(value)
  const definition = objectValue(choice?.function)
  if (stringValue(choice?.type) === 'function' && optionalString(definition?.name)) {
    return { type: 'function', name: stringValue(definition?.name) }
  }
  return undefined
}

function chatMessageToAnthropicContent(message: JsonObject): JsonObject[] {
  const blocks: JsonObject[] = []
  const text = chatContentToText(message.content)
  if (text) blocks.push({ type: 'text', text })
  for (const toolCall of chatMessageToolCalls(message)) {
    const functionValue = objectValue(toolCall.function) ?? {}
    let input: JsonObject = {}
    try {
      input = objectValue(JSON.parse(stringValue(functionValue.arguments, '{}'))) ?? {}
    } catch {
      input = {}
    }
    blocks.push({ type: 'tool_use', id: stringValue(toolCall.id), name: stringValue(functionValue.name), input })
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

function chatMessageToGeminiParts(message: JsonObject): JsonObject[] {
  const parts: JsonObject[] = []
  const text = chatContentToText(message.content)
  if (text) parts.push({ text })
  for (const toolCall of arrayOfObjects(message.tool_calls)) {
    const definition = objectValue(toolCall.function) ?? {}
    let args: JsonObject = {}
    try {
      args = objectValue(JSON.parse(stringValue(definition.arguments, '{}'))) ?? {}
    } catch {
      args = {}
    }
    parts.push({
      functionCall: omitUndefined({
        id: optionalString(toolCall.id),
        name: stringValue(definition.name),
        args
      })
    })
  }
  return parts.length > 0 ? parts : [{ text: '' }]
}

function responsesContentToChat(value: unknown): string {
  if (typeof value === 'string') return value
  return arrayOfObjects(value).map((item) => stringValue(item.text) || stringValue(item.value)).join('')
}

function responsesContentToText(value: unknown): string {
  return responsesContentToChat(value)
}

function chatContentToResponses(value: unknown, output = false): JsonObject[] {
  const text = chatContentToText(value)
  return text ? [{ type: output ? 'output_text' : 'input_text', text }] : []
}

function geminiPartsToText(value: unknown): string {
  return arrayOfObjects(value).map((part) => stringValue(part.text)).join('')
}

function geminiFunctionResponseToChat(value: unknown): string {
  return typeof value === 'string' ? value : jsonString(value ?? {})
}

function chatToolContentToGeminiResponse(value: unknown): JsonObject {
  let candidate: unknown = value
  if (Array.isArray(value)) candidate = chatContentToText(value)
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return { result: candidate }
    }
  }
  return objectValue(candidate) ?? { result: candidate ?? '' }
}

function geminiToolsToChat(value: unknown): JsonObject[] {
  const tools: JsonObject[] = []
  for (const tool of arrayOfObjects(value)) {
    for (const declaration of arrayOfObjects(tool.functionDeclarations)) {
      tools.push({ type: 'function', function: {
        name: stringValue(declaration.name),
        description: stringValue(declaration.description),
        parameters: objectValue(declaration.parameters) ?? { type: 'object', properties: {} }
      } })
    }
  }
  return tools
}

function geminiToolChoiceToChat(value: unknown): unknown {
  const toolConfig = objectValue(value)
  const config = objectValue(toolConfig?.functionCallingConfig)
    ?? objectValue(toolConfig?.function_calling_config)
  if (!config) return undefined
  const mode = stringValue(config.mode).toUpperCase()
  if (mode === 'NONE') return 'none'
  if (mode === 'AUTO' || mode === 'VALIDATED') return 'auto'
  if (mode === 'ANY') {
    const names = stringArray(config.allowedFunctionNames ?? config.allowed_function_names)
    if (names?.length === 1) return { type: 'function', function: { name: names[0] } }
    return 'required'
  }
  return undefined
}

function chatToolChoiceToGemini(value: unknown): JsonObject | undefined {
  let functionCallingConfig: JsonObject | undefined
  if (typeof value === 'string') {
    if (value === 'none') functionCallingConfig = { mode: 'NONE' }
    if (value === 'auto') functionCallingConfig = { mode: 'AUTO' }
    if (value === 'required') functionCallingConfig = { mode: 'ANY' }
  } else {
    const choice = objectValue(value)
    const definition = objectValue(choice?.function)
    if (stringValue(choice?.type) === 'function' && optionalString(definition?.name)) {
      functionCallingConfig = {
        mode: 'ANY',
        allowedFunctionNames: [stringValue(definition?.name)]
      }
    }
  }
  return functionCallingConfig ? { functionCallingConfig } : undefined
}

function anthropicStopReasonToChat(reason: string): string {
  if (reason === 'tool_use') return 'tool_calls'
  if (reason === 'max_tokens') return 'length'
  return 'stop'
}

function chatFinishReasonToAnthropic(reason: string): string {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

function geminiFinishReasonToChat(reason: string): string {
  if (reason === 'MAX_TOKENS') return 'length'
  if (reason === 'STOP' || reason === '') return 'stop'
  return 'stop'
}

function chatFinishReasonToGemini(reason: string): string {
  if (reason === 'length') return 'MAX_TOKENS'
  return 'STOP'
}

function chatStopToAnthropic(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value]
  return stringArray(value)
}

function copyOptional(source: JsonObject, target: JsonObject, keys: string[]): void {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key]
  }
}

function omitUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function arrayOfObjects(value: unknown): JsonObject[] {
  return arrayValue(value).flatMap((item) => {
    const object = objectValue(item)
    return object ? [object] : []
  })
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return arrayOfObjects(value).map((part) => stringValue(part.text)).join('')
  return ''
}

function chatContentToText(value: unknown): string {
  if (typeof value === 'string') return value
  return arrayOfObjects(value).map((part) => stringValue(part.text)).join('')
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined
  return value as string[]
}
