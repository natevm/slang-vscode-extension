import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionContext, workspace } from 'vscode';

import * as fs from 'fs';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';
import { Worker } from 'worker_threads';
import { CompileRequest, EntrypointsRequest, EntrypointsResult, Result, ServerInitializationOptions, Shader, WorkerRequest, ServerMessage } from '../../shared/playgroundInterface';
import { PlaygroundImportQuickFixProvider } from './native/playgroundQuickFix';
import { getSlangdLocation } from './native/slangd';
import { SlangSynthesizedCodeProvider } from './native/synth_doc_provider';
import { getSlangFilesWithContents, sharedActivate, getSlangLogChannel } from './sharedClient';

let client: LanguageClient;
let worker: Worker;


function sendDidOpenTextDocument(document: vscode.TextDocument) {
	if (document.languageId !== 'slang') return;
	sendMessageToWorker({
		type: 'DidOpenTextDocument',
		textDocument: {
			uri: document.uri.toString(),
			text: document.getText(),
		}
	});
}


function sendDidChangeTextDocument(event: vscode.TextDocumentChangeEvent) {
	const document = event.document;
	if (document.languageId !== 'slang') return;
	sendMessageToWorker({
		type: 'DidChangeTextDocument',
		textDocument: {
			uri: document.uri.toString(),
		},
		contentChanges: event.contentChanges.map(change => ({
			range: {
				start: {
					character: change.range.start.character,
					line: change.range.start.line,
				},
				end: {
					character: change.range.end.character,
					line: change.range.end.line,
				},
			},
			text: change.text
		}))
	});
}

export async function activate(context: ExtensionContext) {
	// Register quick fix provider for playground import errors
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			{ language: 'slang', scheme: 'file' },
			new PlaygroundImportQuickFixProvider(),
			{ providedCodeActionKinds: PlaygroundImportQuickFixProvider.providedCodeActionKinds }
		)
	);

	// Register command to create playground.slang if missing
	context.subscriptions.push(
		vscode.commands.registerCommand('slang.createPlaygroundSlang', async (uri: vscode.Uri) => {
			const dir = path.dirname(uri.fsPath);
			const playgroundPath = path.join(dir, 'playground.slang');
			if (fs.existsSync(playgroundPath)) {
				vscode.window.showInformationMessage('playground.slang already exists in this directory.');
				return;
			}
			// Copy from extension's server/src/slang/playground.slang
			let srcPath = path.join(context.extensionPath, 'server', 'src', 'slang', 'playground.slang');
			// Fallback if running from source
			if (!fs.existsSync(srcPath)) {
				srcPath = path.join(__dirname, '../../server/src/slang/playground.slang');
			}
			if (!fs.existsSync(srcPath)) {
				vscode.window.showErrorMessage('Could not find playground.slang template in extension.');
				return;
			}
			fs.copyFileSync(srcPath, playgroundPath);
			vscode.window.showInformationMessage('playground.slang created in this directory.');
			// Optionally open the new file
			const doc = await vscode.workspace.openTextDocument(playgroundPath);
			vscode.window.showTextDocument(doc);
		})
	);
	const serverModule = getSlangdLocation(context);
	const serverOptions: ServerOptions = {
		run: { command: serverModule, transport: TransportKind.stdio },
		debug: {
			command: serverModule, transport: TransportKind.stdio,
			//	, args: ["--debug"]
		}
	};
	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'slang' }],
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'slangLanguageServer',
		'Slang Language Server',
		serverOptions,
		clientOptions
	);
	// Start the client. This will also launch the server
	client.start();

	let synthCodeProvider = new SlangSynthesizedCodeProvider();
	synthCodeProvider.extensionContext = context;

	context.subscriptions.push(
		workspace.registerTextDocumentContentProvider('slang-synth', synthCodeProvider)
	);

	// Initialize language server options, including the implicit playground.slang file.
	const playgroundUri = vscode.Uri.file(path.join(context.extensionPath, 'server', 'src', 'slang', 'playground.slang'));
	const playgroundDocument = await vscode.workspace.openTextDocument(playgroundUri);
	const initializationOptions: ServerInitializationOptions = {
		extensionUri: context.extensionUri.toString(true),
		workspaceUris: vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.map(folder => folder.uri.fsPath) : [],
		files: [... await getSlangFilesWithContents(), {uri: playgroundUri.toString(), content: playgroundDocument.getText() }]
	}
	worker = new Worker(path.join(context.extensionPath, 'server', 'dist', 'nativeServerMain.js'), {
		workerData: initializationOptions
	});
	
	// Set up general message handler for server messages
	worker.on('message', (message: any) => {
		// Check if it's a server message (log or notification)
		if (message && typeof message === 'object' && 'type' in message) {
			const serverMessage = message as ServerMessage;
			
			if (serverMessage.type === 'log') {
				const logChannel = getSlangLogChannel();
				const prefix = `[${serverMessage.level.toUpperCase()}]`;
				logChannel.appendLine(`${prefix} ${serverMessage.message}`);
				if (serverMessage.details) {
					logChannel.appendLine(`  Details: ${serverMessage.details}`);
				}
				
				// Show channel for errors
				if (serverMessage.level === 'error') {
					logChannel.show(true);
				}
			} else if (serverMessage.type === 'notification') {
				const showNotification = 
					serverMessage.level === 'info' ? vscode.window.showInformationMessage :
					serverMessage.level === 'warning' ? vscode.window.showWarningMessage :
					vscode.window.showErrorMessage;
				
				if (serverMessage.actions && serverMessage.actions.length > 0) {
					showNotification(serverMessage.message, ...serverMessage.actions).then(action => {
						if (action) {
							const logChannel = getSlangLogChannel();
							logChannel.appendLine(`User selected action: ${action}`);
							
							// Send action response back to server if notification has an ID
							if (serverMessage.notificationId) {
								sendMessageToWorker({
									type: 'slang/actionResponse',
									notificationId: serverMessage.notificationId,
									action: action
								});
							}
						}
					});
				} else {
					showNotification(serverMessage.message);
				}
			} else if (serverMessage.type === 'addPlaygroundImport') {
				// Handle adding playground import to file
				handleAddPlaygroundImport(serverMessage.filePath);
			}
		}
		// Other messages are handled by specific handlers (compile results, etc.)
	});
	
	sendMessageToWorker({ type: 'Initialize', initializationOptions: initializationOptions });

	// Listen for document open/change events
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(sendDidOpenTextDocument),
		vscode.workspace.onDidChangeTextDocument(sendDidChangeTextDocument)
	);

	// Make sendMessageToWorker available globally for debug commands
	(globalThis as any).sendMessageToWorker = sendMessageToWorker;
	
	sharedActivate(context, {
		compileShader: function (parameter: CompileRequest): Promise<Result<Shader>> {
			sendMessageToWorker({ type: 'slang/compile', ...parameter });
			return new Promise((resolve, reject) => {
				const handler = (message: any) => {
					// Check if this is actually a compile result (not a notification or other message)
					if (message && typeof message === 'object' && 'succ' in message) {
						worker.off('message', handler); // Remove this specific handler
						resolve(message as Result<Shader>);
					}
					// If it's not a compile result, keep listening
				};
				worker.on('message', handler);
			});
		},
		entrypoints: function (parameter: EntrypointsRequest): Promise<EntrypointsResult> {
			sendMessageToWorker({ type: 'slang/entrypoints', ...parameter });
			return new Promise((resolve, reject) => {
				const handler = (message: any) => {
					// Check if this is actually an entrypoints result (array of strings)
					if (Array.isArray(message)) {
						worker.off('message', handler);
						resolve(message as EntrypointsResult);
					}
					// If it's not an entrypoints result, keep listening
				};
				worker.on('message', handler);
			});
		}
	});
}

async function handleAddPlaygroundImport(filePath: string) {
	try {
		// Convert the file path to a VS Code URI
		const uri = vscode.Uri.parse(filePath);
		
		// Open the document
		const document = await vscode.workspace.openTextDocument(uri);
		
		// Get the current content
		const currentContent = document.getText();
		
		// Check if playground import already exists (defensive check)
		if (currentContent.includes('import playground')) {
			vscode.window.showInformationMessage('Playground import already exists in the file');
			return;
		}
		
		// Create a WorkspaceEdit to add the import
		const edit = new vscode.WorkspaceEdit();
		
		// Add "import playground;\n" at the beginning of the file
		const position = new vscode.Position(0, 0);
		edit.insert(uri, position, 'import playground;\n\n');
		
		// Apply the edit
		const success = await vscode.workspace.applyEdit(edit);
		
		if (success) {
			vscode.window.showInformationMessage('Added playground import successfully');
			
			// Optionally, save the document
			await document.save();
			
			// Re-run the playground command after adding the import
			vscode.commands.executeCommand('slang.playgroundRun');
		} else {
			vscode.window.showErrorMessage('Failed to add playground import');
		}
	} catch (error) {
		const logChannel = getSlangLogChannel();
		logChannel.appendLine(`Error adding playground import: ${error}`);
		vscode.window.showErrorMessage(`Failed to add playground import: ${error}`);
	}
}

export function sendMessageToWorker(message: WorkerRequest) {
	worker.postMessage(message);
}

export function deactivate(): Thenable<void> | undefined {
	if (worker) {
		worker.terminate();
	}
	if (!client) {
		return undefined;
	}
	client.stop();
}