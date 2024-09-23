import { Readable } from 'stream';
import { ParsedChunk } from './types';

export async function* streamChunks(response: any): AsyncGenerator<ParsedChunk, void, unknown> {
    const stream = Readable.from(response.body);
    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolCall: ParsedChunk['toolCall'] | null = null;

    for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim() === 'data: [DONE]') {
                if (currentToolCall) {
                    yield { type: 'tool_call', toolCall: currentToolCall };
                    currentToolCall = null;
                }
                yield { type: 'done' };
            } else if (line.startsWith('data: ')) {
                try {
                    const data = JSON.parse(line.slice(6));
                    const delta = data.choices?.[0]?.delta;

                    if (delta?.content) {
                        yield { type: 'content', content: delta.content };
                    } else if (delta?.tool_calls?.[0]) {
                        const toolCall = delta.tool_calls[0];
                        if (!currentToolCall) {
                            currentToolCall = {
                                index: toolCall.index,
                                id: toolCall.id,
                                name: toolCall.function?.name,
                                arguments: toolCall.function?.arguments || '',
                            };
                        } else {
                            currentToolCall.arguments += toolCall.function?.arguments || '';
                        }

                        if (currentToolCall.arguments.endsWith('}')) {
                            try {
                                currentToolCall.arguments = JSON.parse(currentToolCall.arguments);
                                yield { type: 'tool_call', toolCall: currentToolCall };
                                currentToolCall = null;
                            } catch (parseError) {
                                console.warn('Error parsing tool call arguments:', parseError);
                            }
                        }
                    }
                } catch (error) {
                    console.warn('Error parsing chunk:', error);
                }
            }
        }
    }
}
