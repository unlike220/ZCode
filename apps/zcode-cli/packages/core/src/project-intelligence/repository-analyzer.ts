import { createHash } from "node:crypto";
import ts from "typescript";
import type { RepositoryDependencyFact, RepositorySymbolFact } from "@zcode/contracts";

export const REPOSITORY_ANALYZER = `typescript-ast/${ts.version}`;
const MAX_RECORDS_PER_FILE = 1000;
const MAX_TEXT = 1024;

export interface RepositoryAnalyzerResult {
  supported: boolean;
  symbols: RepositorySymbolFact[];
  dependencies: RepositoryDependencyFact[];
  truncated: boolean;
}

/** Pure analyzer seam: receives bounded source, never performs filesystem/module resolution. */
export interface RepositoryAnalyzer {
  analyze(file: string, source: string): RepositoryAnalyzerResult;
}

export function supportsRepositorySymbols(file: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file);
}

export function analyzeRepositoryFile(file: string, source: string): RepositoryAnalyzerResult {
  const result: RepositoryAnalyzerResult = {
    supported: supportsRepositorySymbols(file),
    symbols: [],
    dependencies: [],
    truncated: false,
  };
  if (!result.supported) return result;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  // 解析恢复会制造不完整声明；有语法错误时整文件隔离，不能把恢复节点当作可靠事实。
  const diagnostics = (ast as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics?.length) throw new Error("Repository analyzer: syntax errors");
  const point = (offset: number) => {
    const location = ast.getLineAndCharacterOfPosition(offset);
    return { line: location.line + 1, column: location.character + 1 };
  };
  function dependency(specifier: string, kind: RepositoryDependencyFact["kind"]) {
    if (specifier.length > MAX_TEXT || result.dependencies.length >= MAX_RECORDS_PER_FILE) {
      result.truncated = true;
      return;
    }
    result.dependencies.push({ source: file, specifier, kind, analyzer: REPOSITORY_ANALYZER });
  }
  function walk(node: ts.Node, container?: string): void {
    let parent = container;
    const kind = declarationKind(node);
    const name = "name" in node ? (node as ts.NamedDeclaration).name : undefined;
    if (kind && name && ts.isIdentifier(name)) {
      if (result.symbols.length < MAX_RECORDS_PER_FILE && name.text.length <= MAX_TEXT) {
        const start = point(node.getStart(ast));
        const id = createHash("sha256")
          .update(`${file}:${kind}:${start.line}:${start.column}:${name.text}`)
          .digest("hex");
        const modifierNode =
          ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)
            ? node.parent.parent
            : node;
        const exported =
          ts.canHaveModifiers(modifierNode) &&
          ts
            .getModifiers(modifierNode)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
        result.symbols.push({
          id,
          name: name.text,
          kind,
          file,
          start,
          end: point(node.end),
          ...(container ? { container } : {}),
          ...(exported ? { exported: true } : {}),
          analyzer: REPOSITORY_ANALYZER,
        });
        parent = id;
      } else result.truncated = true;
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      dependency(node.moduleSpecifier.text, "import");
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      dependency(node.moduleSpecifier.text, "export");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      dependency(node.moduleReference.expression.text, "module-reference");
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      const argument = node.arguments[0] as ts.StringLiteral;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) dependency(argument.text, "import");
      // A require-shaped call can be shadowed; preserve the syntax, never claim semantic resolution.
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require")
        dependency(argument.text, "require");
    }
    ts.forEachChild(node, (child) => walk(child, parent));
  }
  walk(ast);
  return result;
}

function declarationKind(node: ts.Node): RepositorySymbolFact["kind"] | undefined {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isModuleDeclaration(node)) return "module";
  if (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    ts.isVariableStatement(node.parent.parent) &&
    ts.isSourceFile(node.parent.parent.parent)
  )
    return "variable";
  return undefined;
}
