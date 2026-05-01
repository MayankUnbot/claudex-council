import * as vscode from "vscode";
import { SessionPanel } from "./sessionPanel";

/**
 * Sidebar tree showing all currently-open council sessions. The sidebar
 * is also where the "+ New Session" action lives through package.json's
 * view/title menu. Clicking a session in the tree focuses its editor tab.
 */
export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private sessions: SessionPanel[] = [];

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SessionTreeItem[] {
    if (this.sessions.length === 0) {
      return [];
    }

    return this.sessions.map((s) => {
      const item = new SessionTreeItem(s.title || "Council", s);
      item.iconPath = new vscode.ThemeIcon("comment-discussion");
      item.contextValue = "session";
      item.command = {
        command: "claudexCouncil.focusSession",
        title: "Focus Session",
        arguments: [s.id],
      };
      return item;
    });
  }

  add(panel: SessionPanel): void {
    this.sessions.push(panel);
    this._onDidChange.fire();
  }

  remove(id: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this._onDidChange.fire();
  }

  find(id: string): SessionPanel | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  list(): readonly SessionPanel[] {
    return this.sessions;
  }
}

class SessionTreeItem extends vscode.TreeItem {
  constructor(label: string, public readonly session: SessionPanel | undefined) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (session) {
      this.tooltip = session.title;
    }
  }
}
