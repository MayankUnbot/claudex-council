import * as vscode from "vscode";
import {
  SessionPanel,
  listPersistedSessionIds,
  readPersistedSession,
} from "./sessionPanel";
import { SessionsTreeProvider } from "./sessionsTree";
import { runFullProbe } from "./modelProber";

export function activate(context: vscode.ExtensionContext): void {
  const sessionsTree = new SessionsTreeProvider();

  // Auto-restore any sessions that were open at the last shutdown. The
  // transcripts live in context.workspaceState (written turn-by-turn by
  // SessionPanel.persistToStorage). On reload, recreate each panel with
  // its saved state — the webview rerenders the bubbles on receipt of a
  // restore-bubbles message in its `ready` handler.
  //
  // We defer the restore by one tick so the rest of activate() finishes
  // (in particular registering commands) before the panels' webviews
  // start posting messages back. Also avoids racing with VS Code's own
  // window restore for prior tabs.
  setTimeout(() => {
    const ids = listPersistedSessionIds(context);
    for (const id of ids) {
      const state = readPersistedSession(context, id);
      if (!state) continue;
      try {
        const panel = SessionPanel.restoreFromState(
          context,
          state,
          (closedId) => sessionsTree.remove(closedId),
          () => sessionsTree.refresh()
        );
        sessionsTree.add(panel);
      } catch (err) {
        console.warn(
          `[claudex-council] Failed to restore session ${id}: ${String(err).slice(0, 200)}`
        );
      }
    }
  }, 50);

  // Note: we used to auto-probe model availability at activation here, but
  // that fanned ~25 CLI calls in parallel competing with the user's first
  // real council turn for API rate limits and CPU — turning a "hey howdy"
  // round-trip into a 90-second wait. Now probing is strictly opt-in via
  // the ↻ button or the "Refresh Available Models" command. Until then,
  // sessions show the full catalog with a banner explaining how to filter.

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("claudexCouncil.sessions", sessionsTree)
  );

  // Open a brand-new council session in its own editor tab.
  context.subscriptions.push(
    vscode.commands.registerCommand("claudexCouncil.newSession", () => {
      const panel = SessionPanel.create(
        context,
        (id) => sessionsTree.remove(id),
        () => sessionsTree.refresh()
      );
      sessionsTree.add(panel);
    })
  );

  // Focus an existing session by id (invoked when the user clicks a
  // sidebar tree item).
  context.subscriptions.push(
    vscode.commands.registerCommand("claudexCouncil.focusSession", (id: string) => {
      const session = sessionsTree.find(id);
      if (session) session.reveal();
    })
  );

  // Convenience entry point: open the activity bar view, which shows the
  // sessions list. Used by the "Claudex Council: Open" command palette
  // entry. We don't auto-create a session here — let the user click +.
  context.subscriptions.push(
    vscode.commands.registerCommand("claudexCouncil.openPanel", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.claudexCouncil");
    })
  );

  // Force-refresh the model availability cache. Useful after the user
  // upgrades their Claude/Codex subscription or a new model launches.
  // Shows a notification with progress; on completion every open session
  // re-receives the new filtered catalog.
  context.subscriptions.push(
    vscode.commands.registerCommand("claudexCouncil.refreshModels", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Claudex Council: probing your account for available models…",
          cancellable: false,
        },
        async (progress) => {
          const cache = await runFullProbe(context, (p) => {
            const pct = Math.round((p.done / p.total) * 100);
            progress.report({
              message: `${p.done}/${p.total} (${pct}%) — ${p.currentId ?? ""}`,
              increment: 100 / p.total,
            });
          });
          for (const s of sessionsTree.list()) s.refreshAvailability();
          vscode.window.showInformationMessage(
            `Claudex Council found ${cache.available.length} working models on your account.` +
              (Object.keys(cache.unavailable).length > 0
                ? ` Hid ${Object.keys(cache.unavailable).length} unavailable.`
                : "")
          );
        }
      );
    })
  );

  // Clear the active session's transcript (kills in-flight agent work).
  context.subscriptions.push(
    vscode.commands.registerCommand("claudexCouncil.clearActiveSession", () => {
      const sessions = sessionsTree.list();
      const active = sessions.find((s) => s.panel.active);
      if (active) {
        active.clearConversation();
      } else {
        vscode.window.showInformationMessage(
          "Claudex Council: focus a session tab first, then run Clear Conversation."
        );
      }
    })
  );
}

export function deactivate(): void {
  // Sessions dispose themselves via panel.onDidDispose; nothing extra here.
}
