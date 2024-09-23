import ora from 'ora';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import chalk from 'chalk';
import { Env } from './types';
import { streamChunks } from './streaming';

dotenv.config();


export const env: Env = {
	LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY: process.env.LANGBASE_ONLINE_STORE_CUSTOMER_SERVICE_API_KEY!,
	LANGBASE_SPORTS_PIPE_API_KEY: process.env.LANGBASE_SPORTS_PIPE_API_KEY!,
	LANGBASE_ELECTRONICS_PIPE_API_KEY: process.env.LANGBASE_ELECTRONICS_PIPE_API_KEY!,
	LANGBASE_TRAVEL_PIPE_API_KEY: process.env.LANGBASE_TRAVEL_PIPE_API_KEY!,
};

export function printLangbaseAgentsVars() {
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

async function callDepartmentAgents(
	deptKey: keyof Pick<Env, 'LANGBASE_SPORTS_PIPE_API_KEY' | 'LANGBASE_ELECTRONICS_PIPE_API_KEY' | 'LANGBASE_TRAVEL_PIPE_API_KEY'>,
	customerQuery: string,
	env: Env,
	threadId?: string
): Promise<any> {
	const spinner = ora('Calling department agents...').start();
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

		spinner.succeed('Department Agent response received');
		return await response.json();
	} catch (error) {
		spinner.fail('Error calling department');
		console.error(error);
		return null;
	}
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

export async function processCSAgentResponse(
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
					const departmentResponse = await callDepartmentAgents(departmentKey, chunk.toolCall!.arguments.customerQuery, env, threadId);
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

export async function mainCsAgent(query: string, threadId: string | undefined, env: Env): Promise<any> {
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
		spinner.succeed('CS Agent response received');
		return response;
	} catch (error) {
		spinner.fail('Error calling CS Agent');
		console.error(error);
		return null;
	}
}