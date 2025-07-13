
import createModule from '../../media/slang-wasm.node.js';
import type { MainModule } from '../../media/slang-wasm.node.js';
import spirvTools from '../../media/spirv-tools.node.js';
import type { EntrypointsRequest, Result, ServerInitializationOptions, WorkerRequest, ServerMessage } from '../../shared/playgroundInterface.js';
import playgroundSource from "./slang/playground.slang";
import { SlangCompiler } from './compiler.js';
import { modifyEmscriptenFile, getEmscriptenURI, getSlangdURI, removePrefix } from './lspSharedUtils.js';
import { parentPort } from 'worker_threads';
// We'll set these after dynamic import
let compiler: SlangCompiler;
let slangWasmModule: MainModule;

// // Dynamically import the WASM module and set up the language server
let initializationOptions: ServerInitializationOptions;

globalThis.GPUShaderStage = { // Fix node's lack of support for WebGPU
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
};

function loadFileIntoEmscriptenFS(uri: string, content: string) {
    // Ensure directory exists
    const splitPath = uri.split("/")
    splitPath.pop()
    const dir = splitPath.join("/");
    let pathData = slangWasmModule.FS.analyzePath(uri, false);
    if (!pathData.parentExists) {
        slangWasmModule.FS.createPath('/', dir, true, true);
    }

    // Write the actual file
    slangWasmModule.FS.writeFile(uri, content);
}

let moduleReady: Promise<Result<undefined>> | null = null;
async function ensureSlangModuleLoaded() {
    if (moduleReady) return moduleReady;
    moduleReady = (async () => {
        // Instantiate the WASM module and create the language server
        slangWasmModule = await createModule();
        compiler = new SlangCompiler(slangWasmModule);
        return compiler.init();
    })();
    return moduleReady;
}

parentPort!.on("message", async (params: WorkerRequest) => {
    switch (params.type) {
        case 'Initialize':
            parentPort!.postMessage(await initialize(params));
            break;
        case 'DidOpenTextDocument':
            await DidOpenTextDocument(params);
            break;
        case 'DidChangeTextDocument':
            await DidChangeTextDocument(params);
            break;
        case 'slang/compile':
            await slangCompile(params);
            break;
        case 'slang/entrypoints':
            await slangEntrypoints(params);
            break;
        case 'slang/debug/testServerLogs':
            await testServerLogs();
            break;
        case 'slang/actionResponse':
            handleActionResponse(params);
            break;
        default:
            let _type: never = params; // Ensure all cases are handled
            console.error(`Unknown request type`);
            break;
    }
});

async function initialize(params: WorkerRequest & { type: 'Initialize' }): Promise<Result<undefined>> {
    // Accept extensionUri from initializationOptions
    if (params.initializationOptions) {
        initializationOptions = params.initializationOptions;
    }
    let moduleLoadResult = await ensureSlangModuleLoaded();

    if(!moduleLoadResult.succ) {
        return moduleLoadResult;
    }
    

    for (const file of initializationOptions.files) {
        const emscriptenURI = getEmscriptenURI(file.uri, initializationOptions.workspaceUris);
        loadFileIntoEmscriptenFS(emscriptenURI, file.content);
    }

    return {
        succ: true,
        result: undefined,
    }
}

// This whole technique is somewhat hacky, but I'm not sure there's a better way to make playground imports work
const loadedPlaygroundFiles: Set<string> = new Set();
function openPlayground(wasmURI: string) {
    let splitUri = wasmURI.split('/');
    splitUri.pop(); // Remove the file name
    const playgroundURI = splitUri.join('/') + '/playground.slang';
    if (loadedPlaygroundFiles.has(playgroundURI)) {
        return; // Already opened
    }
    const emscriptenPlaygroundURI = removePrefix(playgroundURI, "file://");
    loadedPlaygroundFiles.add(playgroundURI);
    loadFileIntoEmscriptenFS(emscriptenPlaygroundURI, playgroundSource);
}

async function DidOpenTextDocument(params: WorkerRequest & { type: 'DidOpenTextDocument' }) {
    const uri = params.textDocument.uri;
    const wasmURI = getSlangdURI(uri, initializationOptions.workspaceUris);
    const emscriptenURI = getEmscriptenURI(uri, initializationOptions.workspaceUris);
    loadFileIntoEmscriptenFS(emscriptenURI, params.textDocument.text);

    openPlayground(wasmURI);
}
// Diagnostics (textDocument/didChange, didOpen, didClose handled by TextDocuments)
async function DidChangeTextDocument(params: WorkerRequest & { type: 'DidChangeTextDocument' }) {
    const uri = params.textDocument.uri;
    const emscriptenURI = getEmscriptenURI(uri, initializationOptions.workspaceUris);
    modifyEmscriptenFile(emscriptenURI, params.contentChanges, slangWasmModule);
}

async function slangCompile(params: WorkerRequest & { type: 'slang/compile' }) {
    const result = await compiler.compile(params, initializationOptions.workspaceUris, spirvTools);
    
    // Check if the error is due to missing playground import
    if (!result.succ && result.message.includes('Unable to load user module')) {
        // Check if the error log mentions undefined print/imageMain functions
        const errorLog = result.log || '';
        const sourceCode = params.sourceCode;
        
        // Check if the code uses print() or other playground functions without importing playground
        const usesPrint = sourceCode.includes('print(') || sourceCode.includes('print ');
        const hasPlaygroundImport = sourceCode.includes('import playground');
        
        if (usesPrint && !hasPlaygroundImport && (errorLog.includes('undefined identifier \'print\'') || errorLog.includes('print'))) {
            // Send a friendly notification with action to add import
            sendNotificationWithCallback(
                'error',
                'Missing playground import. The print() function requires "import playground;" at the top of your file.',
                ['Add Playground Import', 'Cancel'],
                async (action) => {
                    if (action === 'Add Playground Import') {
                        // Send a special message to the client to add the import
                        parentPort!.postMessage({
                            type: 'addPlaygroundImport',
                            filePath: params.shaderPath
                        });
                    }
                }
            );
            
            // Send the error result with notification handled flag
            const modifiedResult = {
                succ: false,
                message: 'The print() function requires "import playground;" at the top of your file.',
                log: 'Add "import playground;" to use playground functions like print().\n\nOriginal error:\n' + errorLog,
                notificationHandled: true
            };
            parentPort!.postMessage(modifiedResult);
            return; // Important: return here to avoid sending the result twice
        }
    }
    
    parentPort!.postMessage(result);
}

async function slangEntrypoints(params: EntrypointsRequest) {
    let path = getEmscriptenURI(params.shaderPath, initializationOptions.workspaceUris);
    parentPort!.postMessage(compiler.findDefinedEntryPoints(params.sourceCode, path));
}

// Helper functions to send messages to client
function sendLogToClient(level: 'info' | 'warning' | 'error', message: string, details?: string) {
    const serverMessage: ServerMessage = {
        type: 'log',
        level,
        message,
        details
    };
    parentPort!.postMessage(serverMessage);
}

function sendNotificationToClient(level: 'info' | 'warning' | 'error', message: string, actions?: string[], notificationId?: string) {
    const serverMessage: ServerMessage = {
        type: 'notification',
        level,
        message,
        actions,
        notificationId
    };
    parentPort!.postMessage(serverMessage);
}

// Store for tracking notification callbacks
const notificationCallbacks = new Map<string, (action: string) => void>();

function sendNotificationWithCallback(
    level: 'info' | 'warning' | 'error', 
    message: string, 
    actions: string[], 
    callback: (action: string) => void
) {
    const notificationId = `notification_${Date.now()}_${Math.random()}`;
    notificationCallbacks.set(notificationId, callback);
    sendNotificationToClient(level, message, actions, notificationId);
}

function handleActionResponse(params: WorkerRequest & { type: 'slang/actionResponse' }) {
    const callback = notificationCallbacks.get(params.notificationId);
    if (callback) {
        callback(params.action);
        notificationCallbacks.delete(params.notificationId); // Clean up
    } else {
        sendLogToClient('warning', `No callback found for notification ${params.notificationId}`);
    }
}

// Test function to demonstrate server-to-client logging
async function testServerLogs() {
    // Test 1: Send logs to output channel
    sendLogToClient('info', '=== Server Debug Test Started ===');
    sendLogToClient('info', 'Testing server-to-client logging mechanism');
    
    // Simulate various scenarios
    sendLogToClient('info', 'Server initialized successfully', 'Module version: 1.0.0\nWASM loaded: true');
    
    // Simulate a warning
    sendLogToClient('warning', 'WebGPU feature not supported', 'Falling back to compatibility mode');
    
    // Simulate an error
    sendLogToClient('error', 'Compilation failed', 'Error at line 42: undefined symbol "foo"');
    
    // Test 2: Send notifications without callbacks
    await new Promise(resolve => setTimeout(resolve, 500));
    
    sendNotificationToClient('info', 'Server processing completed successfully');
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    sendNotificationToClient('warning', 'Performance degradation detected');
    
    // Test 3: Notification with callback - simulate renderer control
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Simulate a renderer state
    let rendererPaused = false;
    
    sendNotificationWithCallback(
        'warning', 
        'Renderer performance issue detected. What would you like to do?',
        ['Pause Renderer', 'Continue', 'Restart'],
        (action) => {
            sendLogToClient('info', `User selected: ${action}`);
            
            switch (action) {
                case 'Pause Renderer':
                    rendererPaused = true;
                    sendLogToClient('info', 'Renderer paused by user action');
                    // In a real scenario, you would pause the actual renderer here
                    
                    // Show follow-up notification
                    sendNotificationWithCallback(
                        'info',
                        'Renderer has been paused',
                        ['Resume', 'Stop'],
                        (followUpAction) => {
                            if (followUpAction === 'Resume') {
                                rendererPaused = false;
                                sendLogToClient('info', 'Renderer resumed');
                            } else if (followUpAction === 'Stop') {
                                sendLogToClient('info', 'Renderer stopped');
                            }
                        }
                    );
                    break;
                    
                case 'Continue':
                    sendLogToClient('info', 'Continuing with current renderer settings');
                    break;
                    
                case 'Restart':
                    sendLogToClient('info', 'Restarting renderer...');
                    // In a real scenario, you would restart the renderer here
                    break;
            }
        }
    );
    
    // Test 4: Simulate compilation error with retry
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    sendNotificationWithCallback(
        'error',
        'Shader compilation failed. Would you like to retry?',
        ['Retry', 'Cancel', 'View Error Details'],
        (action) => {
            if (action === 'Retry') {
                sendLogToClient('info', 'Retrying compilation...');
                // Simulate retry
                setTimeout(() => {
                    sendNotificationToClient('info', 'Compilation succeeded on retry!');
                }, 1000);
            } else if (action === 'View Error Details') {
                sendLogToClient('error', 'Detailed compilation error:', 
                    'Line 42: Undefined symbol "foo"\nLine 43: Expected semicolon\nLine 44: Type mismatch');
            } else {
                sendLogToClient('info', 'Compilation cancelled by user');
            }
        }
    );
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    sendLogToClient('info', '=== Server Debug Test Completed ===');
}
