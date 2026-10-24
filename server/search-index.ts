import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FactListItem } from "../shared/memory";

// A full-text index (SQLite FTS5, ranked by BM25) over the facts. The Markdown files stay the source
// of truth: the index is a cache, kept per context (a repo key, or "global" outside a repo) and
// rebuilt for that context only when its facts or their versions change. Callers index every fact
// of the context and pass, separately, which ids may be returned, so filters and expiry never force
// a rebuild.
export class SearchIndex {
  private readonly db: DatabaseSync;

  constructor(root: string) {
    this.db = new DatabaseSync(join(root, "index.sqlite"));
    this.db.exec(`
      DROP TABLE IF EXISTS facts;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_by_context USING fts5(id UNINDEXED, context UNINDEXED, subject, body, extra, tokenize = 'unicode61');
    `);
  }

  private static signature(facts: readonly FactListItem[]): string {
    const hash = createHash("sha256");
    for (const fact of [...facts].sort((a, b) => a.id.localeCompare(b.id))) hash.update(`${fact.id}:${fact.modified}\n`);
    return hash.digest("hex");
  }

  private sync(context: string, facts: readonly FactListItem[]): void {
    const key = `signature:${context}`;
    const signature = SearchIndex.signature(facts);
    const stored = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    if (stored?.value === signature) return;
    const insert = this.db.prepare("INSERT INTO facts_by_context (id, context, subject, body, extra) VALUES (?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM facts_by_context WHERE context = ?").run(context);
      for (const fact of facts) {
        insert.run(fact.id, context, fact.subject, fact.body, [fact.type, ...fact.paths, ...fact.citations.map((citation) => citation.path)].join(" "));
      }
      this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, signature);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Terms are quoted so user text can never become FTS5 query syntax.
  private static matchExpression(query: string): string | null {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
    if (terms.length === 0) return null;
    return [...new Set(terms)].map((term) => `"${term}"`).join(" OR ");
  }

  // Ids among `allowed` that match, best first. `indexed` is every fact of the context.
  search(context: string, indexed: readonly FactListItem[], allowed: ReadonlySet<string>, query: string, limit: number): string[] {
    this.sync(context, indexed);
    const expression = SearchIndex.matchExpression(query);
    if (!expression) return [];
    const rows = this.db
      .prepare("SELECT id FROM facts_by_context WHERE facts_by_context MATCH ? AND context = ? ORDER BY bm25(facts_by_context, 0.0, 0.0, 4.0, 1.0, 2.0)")
      .all(expression, context) as { id: string }[];
    return rows.map((row) => row.id).filter((id) => allowed.has(id)).slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}
