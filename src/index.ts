import inquirer from "inquirer";
import chalk from "chalk";
import { printLangbaseAgentsVars, mainCsAgent as callMainCsAgent, processCSAgentResponse as processMainCsAgentResponse, env  } from "./online-cs-agent";

async function main() {
	printLangbaseAgentsVars();

	let threadId: string | undefined;
	
	let internalMessage: { toolCallDetected: boolean; threadId: string };
	let response: any;
	response = await callMainCsAgent("Hello", threadId, env);
	threadId = response.headers.get('lb-thread-id') || threadId;

	if (!response.body) {
		console.error('No readable stream found in response body');
	}

	await processMainCsAgentResponse(response, env, threadId || '');
	while (true) {

		const { query } = await inquirer.prompt([
			{
				type: 'input',
				name: 'query',
				message: 'Enter your query (or type "exit" to quit):',
			},
		]);

		if (query.toLowerCase() === 'exit') break;

		response = await callMainCsAgent(query, threadId, env);
		threadId = response.headers.get('lb-thread-id') || threadId;

		if (!response.body) {
			console.error('No readable stream found in response body');
			break;
		}

		internalMessage = await processMainCsAgentResponse(response, env, threadId || '');

		if (internalMessage.toolCallDetected) {
			console.log(chalk.yellow('🔄 Calling department agents...'));
			const response = await callMainCsAgent('summarize the current ticket for the customer', threadId, env);
			threadId = response.headers.get('lb-thread-id') || threadId;

			if (!response.body) {
				console.error('No readable stream found in response body');
				break;
			}

			internalMessage = await processMainCsAgentResponse(response, env, threadId || '');
		}

		console.log(chalk.green('✅ CS Agent response completed'));
	}
}

main().catch(console.error);
