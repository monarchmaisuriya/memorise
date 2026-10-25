import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Words the glossary replaced (see docs/2026-10-25-0930_memorise-ux-copy_plan.md). They name how
// Memorise works, not what people get, so no text shown in the UI may use them again.
const OLD_WORDS = /\b(retire[sd]?|tidy|tidies|capture[sd]?|proposals?|proposed|repos?|host setting|auto-approve)\b/i;

// The user-visible text in a source file, read with the TypeScript parser: its string and template
// literals (the text parts only, not the code inside ${…}) and its JSX text. Imports are skipped,
// and so are literals without a space that do not start with a capital (query keys, ids, paths).
function visibleText(source: string): string[] {
  const file = ts.createSourceFile("file.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const texts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) texts.push(node.text);
    if (ts.isJsxText(node) && node.text.trim() !== "") texts.push(node.text.trim());
    ts.forEachChild(node, visit);
  };
  visit(file);
  return texts.filter((text) => text.includes(" ") || /^[A-Z]/.test(text.trim()));
}

function oldWordsIn(source: string): string[] {
  return visibleText(source).filter((text) => OLD_WORDS.test(text));
}

const root = join(__dirname, "..");
const files = [...readdirSync(join(root, "client")).filter((name) => name.endsWith(".tsx")).map((name) => join("client", name)), "index.client.tsx"];

describe("glossary guard", () => {
  it("finds an old word in a planted label", () => {
    expect(oldWordsIn('<Button label="Retire" styles={styles} />')).toEqual(["Retire"]);
    expect(oldWordsIn("const key = [\"memorise-proposals\", repoKey]; // proposals of this repo")).toEqual([]);
  });

  it.each(files)("%s shows no old word", (file) => {
    expect(oldWordsIn(readFileSync(join(root, file), "utf8"))).toEqual([]);
  });
});
