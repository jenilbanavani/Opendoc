/**
 * OpenDoc — Extension Entry Point
 *
 * Registers the OpenDoc sidebar webview provider when the extension activates.
 */

import * as vscode from "vscode";
import { OpenDocViewProvider } from "./OpenDocViewProvider";

export function activate(context: vscode.ExtensionContext) {
  const provider = new OpenDocViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OpenDocViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

export function deactivate() {}
