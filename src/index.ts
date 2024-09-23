import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { Readable } from 'stream';

dotenv.config();

type ChunkType = 'content' | 'tool_call' | 'done';

interface ParsedChunk {
	type: ChunkType;
	content?: string;
	toolCall?: {
		index: number;
		id: string;
		name: string;
		arguments: any;
	};
}

interface Env {
	LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY: string;
	LANGBASE_SPORTS_PIPE_API_KEY: string;
	LANGBASE_ELECTRONICS_PIPE_API_KEY: string;
	LANGBASE_TRAVEL_PIPE_API_KEY: string;
}

const env: Env = {
	LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY: process.env.LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY!,
	LANGBASE_SPORTS_PIPE_API_KEY: process.env.LANGBASE_SPORTS_PIPE_API_KEY!,
	LANGBASE_ELECTRONICS_PIPE_API_KEY: process.env.LANGBASE_ELECTRONICS_PIPE_API_KEY!,
	LANGBASE_TRAVEL_PIPE_API_KEY: process.env.LANGBASE_TRAVEL_PIPE_API_KEY!,
};

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

async function* streamChunks(response: any): AsyncGenerator<ParsedChunk, void, unknown> {
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



async function processMainChatbotResponse(
	response: Response,
	env: Env,
	threadId: string
): Promise<{ toolCallDetected: boolean; threadId: string }> {
	let toolCallDetected = false;

	for await (const chunk of streamChunks(response)) {
		switch (chunk.type) {
			case 'content':
				if (chunk.content) {
					process.stdout.write(chunk.content);
				}
				break;
			case 'tool_call':
				toolCallDetected = true;
				const departmentKey = getDepartmentKey(chunk.toolCall!.name);
				if (departmentKey) {
					const departmentResponse = await callDepartment(departmentKey, chunk.toolCall!.arguments.customerQuery, env, threadId);
					let responseContent = formatDepartmentResponse(departmentResponse.completion);
					process.stdout.write(responseContent);
				}
				break;
			case 'done':
				process.stdout.write('\n');
				break;
		}
	}

	return { toolCallDetected, threadId };
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

		let internalMessage: { toolCallDetected: boolean; threadId: string };

		do {
			const response = await callMainChatbot(query, threadId, env);
			threadId = response.headers.get('lb-thread-id') || threadId;

			if (!response.body) {
				console.error('No readable stream found in response body');
				break;
			}

			internalMessage = await processMainChatbotResponse(response, env, threadId || '');

			if (internalMessage.toolCallDetected) {
				console.log(chalk.yellow('🔄 Calling department agents...'));
				const response = await callMainChatbot('summarize the current status for the customer', threadId, env);
				threadId = response.headers.get('lb-thread-id') || threadId;

				if (!response.body) {
					console.error('No readable stream found in response body');
					break;
				}

				internalMessage = await processMainChatbotResponse(response, env, threadId || '');
			}
		} while (internalMessage.toolCallDetected);

		console.log(chalk.green('✅ Final response ready'));
	}
}

main().catch(console.error);
