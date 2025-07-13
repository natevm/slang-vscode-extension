import { ExtensionContext, Uri, commands, window, workspace } from 'vscode';
import * as vscode from 'vscode';

let slangLogChannel: vscode.OutputChannel | undefined;
export function getSlangLogChannel(): vscode.OutputChannel {
	if (!slangLogChannel) {
		slangLogChannel = vscode.window.createOutputChannel('Slang Extension Log');
	}
	return slangLogChannel;
}
import { LanguageClientOptions } from 'vscode-languageclient';

import { LanguageClient } from 'vscode-languageclient/browser';
import type { CompileRequest, EntrypointsRequest, EntrypointsResult, PlaygroundMessage, Result, Shader } from '../../shared/playgroundInterface';
import { checkShaderType, getResourceCommandsFromAttributes, getUniformControllers, getUniformSize, isControllerRendered, parseCallCommands } from "../../shared/util.js";

// Maps to track open panels by file URI and command type
const playgroundPanels = new Map<string, vscode.WebviewPanel>();
const uniformPanels = new Map<string, vscode.WebviewPanel>();
const outputPanels = new Map<string, vscode.OutputChannel>();

const compileOptions = ['SPIRV', 'HLSL', 'GLSL', 'METAL', 'WGSL', 'CUDA'] as const;
type LanguageOptions = {
	languageId: string,
	requiresEntrypoint: boolean,
}
const compileOptionMap: { [k in (typeof compileOptions)[number]]: LanguageOptions } = {
	SPIRV: {
		languageId: 'spirv',
		requiresEntrypoint: false,
	},
	HLSL: {
		languageId: 'hlsl',
		requiresEntrypoint: true,
	},
	GLSL: {
		languageId: 'glsl',
		requiresEntrypoint: true,
	},
	METAL: {
		languageId: 'metal',
		requiresEntrypoint: false,
	},
	WGSL: {
		languageId: 'wgsl',
		requiresEntrypoint: false,
	},
	CUDA: {
		languageId: 'cuda-cpp',
		requiresEntrypoint: true
	}
}

export async function getSlangFilesWithContents(): Promise<{ uri: string, content: string }[]> {
	const pattern = '**/*.slang';
	const files = await vscode.workspace.findFiles(pattern);

	const results: { uri: string, content: string }[] = [];

	for (const uri of files) {
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			results.push({ uri: uri.toString(false), content: document.getText() });
		} catch (err) {
			const logChannel = getSlangLogChannel();
			logChannel.appendLine(`Failed to read ${uri.fsPath}: ${err}`);
			logChannel.show(true);
		}
	}

	return results;
}

export type SlangHandler = {
	compileShader: (parameter: CompileRequest) => Promise<Result<Shader>>;
	entrypoints: (parameter: EntrypointsRequest) => Promise<EntrypointsResult>;
};

// this method is called when vs code is activated
export async function sharedActivate(context: ExtensionContext, slangHandler: SlangHandler) {
	// Register Playground Run command to open a webview
	context.subscriptions.push(
		commands.registerCommand('slang.playgroundRun', async () => {
			const userSource = window.activeTextEditor.document.getText();
			const userURI = window.activeTextEditor.document.uri;
			const shaderType = checkShaderType(userSource);
			if (shaderType == null) {
				vscode.window.showErrorMessage("Error: In order to run the shader, please define either imageMain or printMain function in the shader code.");
				return;
			}
			const compileResult = await slangHandler.compileShader({
				target: "WGSL",
				entrypoint: shaderType,
				sourceCode: userSource,
				shaderPath: window.activeTextEditor.document.uri.toString(false),
				noWebGPU: false,
			});
			if (compileResult.succ == false) {
				const logChannel = getSlangLogChannel();
				// Only show error message if it wasn't already handled by a notification
				if (!compileResult.notificationHandled) {
					vscode.window.showErrorMessage(compileResult.message);
				}
				if (compileResult.log) {
					logChannel.appendLine(compileResult.log);
					logChannel.show(true);
				}
				return;
			}
			const compilation = compileResult.result;

			let resourceCommandsResult = getResourceCommandsFromAttributes(compilation.reflection);
			if (resourceCommandsResult.succ == false) {
				const logChannel = getSlangLogChannel();
				vscode.window.showErrorMessage("Error while parsing Resource commands: " + resourceCommandsResult.message);
				if (resourceCommandsResult.log) {
					logChannel.appendLine(resourceCommandsResult.log);
					logChannel.show(true);
				}
				return;
			}
			let uniformSize = getUniformSize(compilation.reflection)
			let uniformComponents = getUniformControllers(resourceCommandsResult.result)

			let callCommandResult = parseCallCommands(compilation.reflection);
			if (callCommandResult.succ == false) {
				const logChannel = getSlangLogChannel();
				vscode.window.showErrorMessage("Error while parsing CALL commands: " + callCommandResult.message);
				if (callCommandResult.log) {
					logChannel.appendLine(callCommandResult.log);
					logChannel.show(true);
				}
				return;
			}

			// Key for this file/run
			const playgroundKey = userURI.toString() + ':playground';
			// Close previous panel if exists
			if (playgroundPanels.has(playgroundKey)) {
				try { playgroundPanels.get(playgroundKey)!.dispose(); } catch { }
				playgroundPanels.delete(playgroundKey);
			}
			const panel = window.createWebviewPanel(
				'slangPlayground',
				'Slang Playground',
				vscode.ViewColumn.Beside,
				{
					enableScripts: true,
					retainContextWhenHidden: true,
				}
			);
			playgroundPanels.set(playgroundKey, panel);
			panel.onDidDispose(() => playgroundPanels.delete(playgroundKey));
			panel.webview.html = getWebviewContent(context, panel, 'client/dist/webviewBundle.js', 'client/dist/webviewBundle.css');

			if (shaderType === 'printMain') {
				const outputKey = userURI.toString() + ':output';
				if (outputPanels.has(outputKey)) {
					try { outputPanels.get(outputKey)!.dispose(); } catch { }
					outputPanels.delete(outputKey);
				}
				const shaderOutputLog = vscode.window.createOutputChannel(`Slang Shader Output (${window.activeTextEditor.document.fileName})`);
				outputPanels.set(outputKey, shaderOutputLog);
				panel.webview.onDidReceiveMessage(message => {
					if (message.type === 'log') {
						shaderOutputLog.append(message.text);
						shaderOutputLog.show(true);
					}
				});
				panel.onDidDispose(() => {
					shaderOutputLog.dispose();
					outputPanels.delete(outputKey);
				});
			}

			let message: PlaygroundMessage = {
				type: "init",
				payload: {
					slangSource: userSource,
					callCommands: callCommandResult.result,
					mainEntryPoint: shaderType,
					resourceCommands: resourceCommandsResult.result,
					uniformComponents,
					uniformSize,
					shader: compilation,
					uri: panel.webview.asWebviewUri(userURI).toString(),
				},
			};
			panel.webview.postMessage(message)

			if (uniformComponents.some(isControllerRendered)) {
				const uniformKey = userURI.toString() + ':uniform';
				if (uniformPanels.has(uniformKey)) {
					try { uniformPanels.get(uniformKey)!.dispose(); } catch { }
					uniformPanels.delete(uniformKey);
				}
				const uniform_panel = window.createWebviewPanel(
					'slangPlaygroundUniforms',
					'Slang Playground Uniforms',
					vscode.ViewColumn.Beside,
					{
						enableScripts: true,
						retainContextWhenHidden: true,
					}
				);
				uniformPanels.set(uniformKey, uniform_panel);
				uniform_panel.onDidDispose(() => uniformPanels.delete(uniformKey));
				uniform_panel.webview.html = getWebviewContent(context, uniform_panel, "client/dist/uniformWebviewBundle.js", "client/dist/uniformWebviewBundle.css");
				uniform_panel.webview.onDidReceiveMessage(uniform_message => {
					if (uniform_message.type === 'update') {
						let playground_message: PlaygroundMessage = {
							type: "uniformUpdate",
							payload: uniform_message.data,
						};
						panel.webview.postMessage(playground_message)
					}
				});
				uniform_panel.webview.postMessage({
					type: "init",
					uniformComponents,
				})

				panel.onDidDispose(() => {
					try {
						uniform_panel.dispose()
					} catch {
						// ignore if panel was already disposed
					}
					uniformPanels.delete(uniformKey);
				})
			}
		})
	);

	vscode.window.onDidChangeActiveTextEditor(editor => {
		updateContext(editor);
	});

	vscode.workspace.onDidChangeTextDocument(event => {
		if (vscode.window.activeTextEditor?.document === event.document) {
			updateContext(vscode.window.activeTextEditor);
		}
	});

	updateContext(window.activeTextEditor);

	function updateContext(editor: vscode.TextEditor | undefined) {
		const text = editor?.document.getText() || "";
		const shouldShow = text.match("void\\s+printMain\\s*\\(") != null || text.match("float4\\s+imageMain\\s*\\(") != null;
		vscode.commands.executeCommand('setContext', 'isPlaygroundFile', shouldShow);
	}

	// Register a virtual document content provider for readonly docs
	const slangVirtualScheme = 'slang-virtual';
	const virtualDocumentContents = new Map();

	context.subscriptions.push(
		workspace.registerTextDocumentContentProvider(slangVirtualScheme, {
			provideTextDocumentContent: (uri) => {
				return virtualDocumentContents.get(uri.path.slice(1));
			}
		})
	);

	// Register the user command
	context.subscriptions.push(commands.registerCommand('slang.compile', async () => {
		const targetSelection = await window.showQuickPick(compileOptions, {
			placeHolder: 'Select a Target',
		}) as (typeof compileOptions)[number] | undefined;
		if (!targetSelection) {
			return;
		}
		const userSource = window.activeTextEditor.document.getText() ?? '';
		let selectedEntrypoint = ""
		if (compileOptionMap[targetSelection].requiresEntrypoint) {
			// Send the picked option to the server and get the result
			const parameter: EntrypointsRequest = {
				sourceCode: userSource,
				shaderPath: window.activeTextEditor.document.uri.toString(false),
			}
			let entrypoints: EntrypointsResult = await slangHandler.entrypoints(parameter);
			const entrypointSelection = await window.showQuickPick(entrypoints, {
				placeHolder: 'Select a Entrypoint',
			}) as (typeof compileOptions)[number] | undefined;
			if (!entrypointSelection) {
				return;
			}
			selectedEntrypoint = entrypointSelection;
		}
		// Send the picked option to the server and get the result
		let compilationResult = await slangHandler.compileShader({
			target: targetSelection,
			entrypoint: selectedEntrypoint,
			sourceCode: userSource,
			shaderPath: window.activeTextEditor.document.uri.toString(false),
			noWebGPU: true,
		});
		if (compilationResult.succ == false) {
			vscode.window.showErrorMessage(compilationResult.message);
			return;
		}
		const shader = compilationResult.result;
		const vDocName = `Slang Compile (${targetSelection})`
		// Show the result in a readonly virtual document
		const vdocUri = Uri.parse(`${slangVirtualScheme}:/${vDocName}`);
		virtualDocumentContents.set(vDocName, shader.code);
		const doc = await workspace.openTextDocument(vdocUri);
		await window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside }).then(editor => {
			vscode.languages.setTextDocumentLanguage(doc, compileOptionMap[targetSelection].languageId);
		});
	}));

	context.subscriptions.push(commands.registerCommand('slang.reflection', async () => {
		const userSource = window.activeTextEditor.document.getText() ?? '';
		// Send the picked option to the server and get the result
		let compilationResult = await slangHandler.compileShader({
			target: "WGSL",
			entrypoint: "",
			sourceCode: userSource,
			shaderPath: window.activeTextEditor.document.uri.toString(false),
			noWebGPU: true,
		});
		if (compilationResult.succ == false) {
			vscode.window.showErrorMessage(compilationResult.message);
			return;
		}
		const shader = compilationResult.result;
		const vDocName = `Slang Reflection (${window.activeTextEditor.document.fileName.replace('\\', "")})`
		// Show the result in a readonly virtual document
		const vdocUri = Uri.parse(`${slangVirtualScheme}:/${vDocName}`);
		virtualDocumentContents.set(vDocName, JSON.stringify(shader.reflection, undefined, 4));
		const doc = await workspace.openTextDocument(vdocUri);
		await window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside }).then(editor => {
			vscode.languages.setTextDocumentLanguage(doc, "json");
		});
	}));

	context.subscriptions.push(commands.registerCommand('slang.playgroundDocumentation', async () => {
		const mdFile = vscode.Uri.joinPath(context.extensionUri, 'media', 'playgroundDocumentation.md')
		await vscode.commands.executeCommand('markdown.showPreviewToSide', mdFile);
	}));

	// Debug Commands for testing different logging mechanisms
	context.subscriptions.push(commands.registerCommand('slang.debug.testNotification', async () => {
		// Test showing notifications in client's VSCode
		vscode.window.showInformationMessage('Slang Debug: Information notification test');
		vscode.window.showWarningMessage('Slang Debug: Warning notification test');
		vscode.window.showErrorMessage('Slang Debug: Error notification test');
		
		// Test notification with options
		const choice = await vscode.window.showInformationMessage(
			'Slang Debug: Interactive notification test',
			'Option 1',
			'Option 2'
		);
		if (choice) {
			vscode.window.showInformationMessage(`You selected: ${choice}`);
		}
	}));

	context.subscriptions.push(commands.registerCommand('slang.debug.testOutputChannel', async () => {
		// Test writing to client's output channel
		const logChannel = getSlangLogChannel();
		
		logChannel.appendLine('=== Slang Debug: Output Channel Test ===');
		logChannel.appendLine(`Timestamp: ${new Date().toISOString()}`);
		logChannel.appendLine('Testing different log levels:');
		logChannel.appendLine('  [INFO] This is an informational message');
		logChannel.appendLine('  [WARN] This is a warning message');
		logChannel.appendLine('  [ERROR] This is an error message');
		logChannel.appendLine('');
		logChannel.append('Testing append without newline... ');
		logChannel.appendLine('completed!');
		logChannel.appendLine('=== End of Output Channel Test ===\n');
		
		// Show the output channel
		logChannel.show(true);
		
		vscode.window.showInformationMessage('Output written to Slang Extension Log channel');
	}));

	context.subscriptions.push(commands.registerCommand('slang.debug.testConsoleLog', async () => {
		// Test logging to developer tools console
		console.log('=== Slang Debug: Console Log Test ===');
		console.log('Standard log message', { timestamp: new Date().toISOString() });
		console.info('Info message with data:', { test: true, value: 42 });
		console.warn('Warning message:', 'This is a warning from Slang extension');
		console.error('Error message:', new Error('Test error from Slang extension'));
		
		// Test console grouping
		console.group('Slang Debug Group');
		console.log('Message inside group');
		console.log('Another message in group');
		console.groupEnd();
		
		// Test console table
		console.table([
			{ feature: 'Notifications', status: 'working' },
			{ feature: 'Output Channel', status: 'working' },
			{ feature: 'Console Log', status: 'testing' }
		]);
		
		console.log('=== End of Console Log Test ===');
		
		vscode.window.showInformationMessage('Logs written to Developer Tools Console (Help > Toggle Developer Tools)');
	}));

	context.subscriptions.push(commands.registerCommand('slang.debug.testClientCommunication', async () => {
		// Run all debug tests
		vscode.window.showInformationMessage('Running all Slang debug tests...');
		
		// Test 1: Notifications
		await vscode.commands.executeCommand('slang.debug.testNotification');
		
		// Small delay between tests
		await new Promise(resolve => setTimeout(resolve, 500));
		
		// Test 2: Output Channel
		await vscode.commands.executeCommand('slang.debug.testOutputChannel');
		
		// Test 3: Console Log
		await vscode.commands.executeCommand('slang.debug.testConsoleLog');
		
		vscode.window.showInformationMessage('All Slang debug tests completed!');
	}));

	context.subscriptions.push(commands.registerCommand('slang.debug.testServerCommunication', async () => {
		// Test server-to-client communication
		vscode.window.showInformationMessage('Testing server-to-client communication...');
		
		// Send test command to server
		if ('sendMessageToWorker' in globalThis && typeof (globalThis as any).sendMessageToWorker === 'function') {
			(globalThis as any).sendMessageToWorker({ type: 'slang/debug/testServerLogs' });
			
			const logChannel = getSlangLogChannel();
			logChannel.appendLine('=== Client: Sent test request to server ===');
			logChannel.appendLine('Watch for server messages below...');
			logChannel.show(true);
		} else {
			vscode.window.showErrorMessage('Server communication test only available in native extension mode');
		}
	}));
}

export function getWebviewContent(context: ExtensionContext, panel: vscode.WebviewPanel, scriptPath: string, stylePath: string): string {
	// Webview HTML with script tag for the esbuild webview bundle
	const webviewMain = panel.webview.asWebviewUri(Uri.joinPath(context.extensionUri, scriptPath));
	const webviewStyle = panel.webview.asWebviewUri(Uri.joinPath(context.extensionUri, stylePath));
	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Slang Playground</title>
      	<link rel="stylesheet" href="${webviewStyle.toString(true)}">
		<script type="module" src="${webviewMain.toString(true)}"></script>
		<style>
			#app {
			    position: absolute;
				left: 0;
				right: 0;
				bottom: 0;
				top: 0;
			}
		</style>
	</head>
	<body>
	<div id="app">
		<p>Loading</p>
	</div>
	</body>
	</html>
`;
}
