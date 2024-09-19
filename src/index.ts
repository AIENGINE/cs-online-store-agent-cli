import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { Pipe } from 'langbase';

dotenv.config();

function printEnvironmentVariables() {
	console.log('Environment Variables:');
	const envVars: (keyof Env)[] = [
		'LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY',
		'LANGBASE_SPORTS_PIPE_API_KEY',
		'LANGBASE_ELECTRONICS_PIPE_API_KEY',
		'LANGBASE_TRAVEL_PIPE_API_KEY',
	];

	envVars.forEach(key => {
		console.log(`${key}: ${process.env[key] || 'Not set'}`);
	});
}

const csAgent = new Pipe({
	apiKey: process.env.LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY!,
});

interface Env {
	LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY: string;
	LANGBASE_SPORTS_PIPE_API_KEY: string;
	LANGBASE_ELECTRONICS_PIPE_API_KEY: string;
	LANGBASE_TRAVEL_PIPE_API_KEY: string;
}

interface InternalMessage {
	entity: 'main' | 'internal';
	responseStream: ReadableStream;
	toolCallDetected: boolean;
	customerQuery?: string;
	threadId: string;
}

const env: Env = {
	LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY: process.env.LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY!,
	LANGBASE_SPORTS_PIPE_API_KEY: process.env.LANGBASE_SPORTS_PIPE_API_KEY!,
	LANGBASE_ELECTRONICS_PIPE_API_KEY: process.env.LANGBASE_ELECTRONICS_PIPE_API_KEY!,
	LANGBASE_TRAVEL_PIPE_API_KEY: process.env.LANGBASE_TRAVEL_PIPE_API_KEY!,
};

const encoder = new TextEncoder();

function getDepartmentKey(
	functionName: string
): keyof Pick<Env, 'LANGBASE_SPORTS_PIPE_API_KEY' | 'LANGBASE_ELECTRONICS_PIPE_API_KEY' | 'LANGBASE_TRAVEL_PIPE_API_KEY'> | null {
	const departmentMap: {
		[key: string]: keyof Pick<Env, 'LANGBASE_SPORTS_PIPE_API_KEY' | 'LANGBASE_ELECTRONICS_PIPE_API_KEY' | 'LANGBASE_TRAVEL_PIPE_API_KEY'>;
	} = {
		call_sports_dept: 'LANGBASE_SPORTS_PIPE_API_KEY',
		call_electronics_dept: 'LANGBASE_ELECTRONICS_PIPE_API_KEY',
		call_travel_dept: 'LANGBASE_TRAVEL_PIPE_API_KEY',
	};
	return departmentMap[functionName] || null;
}

async function callDepartment(
	deptKey: keyof Pick<Env, 'LANGBASE_SPORTS_PIPE_API_KEY' | 'LANGBASE_ELECTRONICS_PIPE_API_KEY' | 'LANGBASE_TRAVEL_PIPE_API_KEY'>,
	customerQuery: string,
	env: Env,
	threadId?: string
): Promise<any> {
	const spinner = ora('Calling department...').start();
	try {
		const response = await fetch('https://api.langbase.com/beta/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${env[deptKey]}`,
			},
			body: JSON.stringify({
				messages: [{ role: 'user', content: customerQuery }],
				...(threadId && { threadId }),
			}),
		});

		if (!response.ok) {
			throw new Error(`Error: ${response.status} ${response.statusText}`);
		}

		spinner.succeed('Department response received');
		return await response.json();
	} catch (error) {
		spinner.fail('Error calling department');
		console.error(error);
		return null;
	}
}

async function processMainChatbotResponse(
	response: any,
	env: Env,
	threadId: string,
	initialState: { entity: 'main' | 'internal'; toolCallDetected: boolean }
): Promise<InternalMessage> {
	let reader;
	if (response.body && typeof response.body.getReader === 'function') {
		reader = response.body.getReader();
	} else {
		const text = await response.text();
		const lines = text.split('\n');
		let lineIndex = 0;
		reader = {
			read: async () => {
				if (lineIndex < lines.length) {
					return {
						done: false,
						value: new TextEncoder().encode(lines[lineIndex++] + '\n'),
					};
				} else {
					return { done: true, value: undefined };
				}
			},
		};
	}

	const decoder = new TextDecoder();

	let accumulatedToolCall: any = null;
	let accumulatedArguments = '';
	const sharedState = {
		toolCallDetected: initialState.toolCallDetected,
		entity: initialState.entity,
	};

	const [processStream, responseStream] = new ReadableStream({
		async start(controller: ReadableStreamDefaultController) {
			try {
				let buffer = '';
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						const result = await processLine(line, controller, env, threadId, accumulatedToolCall, accumulatedArguments, sharedState);
						accumulatedToolCall = result[0];
						accumulatedArguments = result[1];
					}
				}
			} catch (error) {
				console.error('Error in stream processing:', error);
			} finally {
				controller.close();
			}
		},
	}).tee();

	await processStream.pipeTo(new WritableStream());

	return {
		entity: sharedState.toolCallDetected ? 'internal' : 'main',
		responseStream: responseStream,
		toolCallDetected: sharedState.toolCallDetected,
		customerQuery: '',
		threadId: threadId,
	};
}

async function processLine(
	line: string,
	controller: ReadableStreamDefaultController,
	env: Env,
	threadId: string,
	accumulatedToolCall: any,
	accumulatedArguments: string,
	sharedState: { toolCallDetected: boolean }
): Promise<[any, string]> {
	if (line.trim() === 'data: [DONE]') {
		controller.enqueue(encoder.encode('data: [DONE]\n\n'));
		return [accumulatedToolCall, accumulatedArguments];
	}
	if (!line.startsWith('data: ')) return [accumulatedToolCall, accumulatedArguments];

	try {
		const data = JSON.parse(line.slice(6));
		if (!data.choices || !data.choices[0].delta) return [accumulatedToolCall, accumulatedArguments];

		const delta = data.choices[0].delta;
		if (delta.content) {
			enqueueContentChunk(controller, data, delta.content);
		} else if (delta.tool_calls) {
			sharedState.toolCallDetected = true;
			if (!accumulatedToolCall) {
				accumulatedToolCall = delta.tool_calls[0];
				accumulatedArguments = delta.tool_calls[0].function.arguments || '';
			} else {
				accumulatedArguments += delta.tool_calls[0].function.arguments || '';
			}

			if (accumulatedToolCall.function.name && accumulatedArguments.endsWith('}')) {
				const departmentKey = getDepartmentKey(accumulatedToolCall.function.name);
				if (departmentKey) {
					const args = JSON.parse(accumulatedArguments);
					const departmentResponse = await callDepartment(departmentKey, args.customerQuery, env, threadId);
					let responseContent = formatDepartmentResponse(departmentResponse.completion);
					console.log(`Dept response: ${responseContent}`);
					enqueueContentChunk(controller, data, responseContent);
				}
				accumulatedToolCall = null;
				accumulatedArguments = '';
			}
		}
	} catch (error) {
		console.warn('Error processing chunk:', error, 'Line:', line);
	}

	return [accumulatedToolCall, accumulatedArguments];
}

function enqueueContentChunk(controller: ReadableStreamDefaultController, data: any, content: string) {
	// process.stdout.write(content);
	const chunk = {
		id: data.id,
		object: data.object,
		created: data.created,
		model: data.model,
		choices: [{ index: 0, delta: { content }, finish_reason: null }],
	};
	controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}

function formatDepartmentResponse(response: string): string {
	try {
		const parsedResponse = JSON.parse(response);
		const [key, value] = Object.entries(parsedResponse)[0];
		return `${key} ${value}`;
	} catch (parseError) {
		console.warn('Error parsing department response:', parseError);
		return response;
	}
}

async function callMainChatbot(query: string, threadId: string | undefined, env: Env): Promise<any> {
	const spinner = ora('Calling main chatbot...').start();
	try {
		const userQuery = {
			threadId,
			messages: [{ role: 'user', content: query }],
		};
		const response = await fetch('https://api.langbase.com/beta/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${env['LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY']}`,
			},
			body: JSON.stringify(userQuery),
		});
		spinner.succeed('Main chatbot response received');
		return response;
	} catch (error) {
		spinner.fail('Error calling main chatbot');
		console.error(error);
		return null;
	}
}

async function streamResponse(responseStream: ReadableStream) {
	const reader = responseStream.getReader();
	const decoder = new TextDecoder();

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value);
		const lines = chunk.split('\n');
		for (const line of lines) {
			if (line.startsWith('data: ')) {
				try {
					const data = JSON.parse(line.slice(6));
					if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
						process.stdout.write(data.choices[0].delta.content);
					}
				} catch (error) {
					// Ignore parsing errors
				}
			}
		}
	}
	console.log(); // Add a new line after the response is complete
}


async function csAgentGreetings(): Promise<any[]> {
  
  const {stream, threadId} = await csAgent.streamText({
    messages: [{role: 'user', content: 'Hello'}],
    chat: true,
  });
  return [stream, threadId];
}

async function main() {
	printEnvironmentVariables();

	let threadId: string | undefined;

	while (true) {
		const { query } = await inquirer.prompt([
			{
				type: 'input',
				name: 'query',
				message: 'Enter your query (or type "exit" to quit):',
			},
		]);

		if (query.toLowerCase() === 'exit') break;

		let internalMessage: InternalMessage;

		do {
			const response = await callMainChatbot(query, threadId, env);
			threadId = response.headers.get('lb-thread-id') || threadId;

			if (!response.body) {
				console.error('No readable stream found in response body');
				break;
			}

			internalMessage = await processMainChatbotResponse(response, env, threadId || '', {
				entity: 'main',
				toolCallDetected: false,
			});
			await streamResponse(internalMessage.responseStream);

			if (internalMessage.entity === 'internal') {
				console.log(chalk.yellow('🔄 Calling department agents...'));
				const response = await callMainChatbot('summarize the current status for the customer', threadId, env);
				threadId = response.headers.get('lb-thread-id') || threadId;

				if (!response.body) {
					console.error('No readable stream found in response body');
					break;
				}

				internalMessage = await processMainChatbotResponse(response, env, threadId || '', {
					entity: 'main',
					toolCallDetected: false,
				});
				await streamResponse(internalMessage.responseStream);
			}
		} while (internalMessage.entity === 'internal');

		console.log(chalk.green('✅ Final response ready'));
	}
}

main().catch(console.error);
