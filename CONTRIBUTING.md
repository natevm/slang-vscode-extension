# Contributing

This project welcomes contributions and suggestions. Contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant the rights to use your contribution.

When you submit a pull request, a CLA bot will determine whether you need to sign a CLA. Simply follow the instructions provided.

## Getting dependencies

First you need to get certain prerequisite files to run the project.

* Fork this repository
* Manually run the `Build Dependencies` workflow from the Actions tab of your fork
* Download the artifacts from the workflow run

This should produce the following files:

* `slang-wasm.js`
* `slang-wasm.d.ts`

Move them into the `media` directory.

## Structure

```plaintext
.
├── client // Language Client
│   └── src
│       └── browserClientMain.ts // Language Client entry point
├── package.json // The extension manifest.
├── server // Language Server
|   └── src
|       └── browserServerMain.ts // Language Server entry point
└── webview // Webview for playground runs. Runs WebGPU
    └── src
        └── app.ts // Vue entry point
```

## Running the Sample

- Run `npm install` in this folder. This installs all necessary npm modules in both the client and server folder
- Open VS Code on this folder.
- Press Ctrl+Shift+B to compile the client and server.
- Switch to the Debug viewlet.
- Select `Run Web Extension` from the drop down.
- Run the launch config.

You can also run and debug the extension in a browser

- `npm run chrome`
- use browser dev tools to set breakpoints

## Run Web vs Run Native

In launch.json, there are two options:  `Run Web Extension` and `Run Native Extension`, the key difference 
being the `--extensionDevelopmentKind=web` argument:

### Run Web Extension

  - Includes `--extensionDevelopmentKind=web` argument
  - Forces VS Code to load the extension as a web extension (browser environment)
  - Uses the browser entry point: client/dist/browserClientMain.js
  - Runs in a sandboxed web worker environment
  - No access to Node.js APIs or native file system
  - Uses browserServerMain.ts for the language server

### Run Native Extension

  - No extensionDevelopmentKind argument (defaults to native)
  - Loads the extension as a desktop extension (Node.js environment)
  - Uses the main entry point: client/dist/nativeClientMain.js
  - Full access to Node.js APIs and file system
  - Uses nativeServerMain.ts for the language server

This dual configuration allows testing the extension in both environments, ensuring it works correctly whether
users are running VS Code desktop or VS Code for Web (vscode.dev).
