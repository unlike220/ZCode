import { isAbsolute, relative, resolve } from "node:path";
import type { ProjectWorkScopeEntry } from "@zcode/contracts";
import { resolveWorkspacePath } from "../tool/path-policy.js";

interface ProjectWorkMutationPathInput {
  inputPath: string;
  workingDirectory: string;
  workspaceRoot: string;
}

export function resolveProjectWorkMutationPath(input: ProjectWorkMutationPathInput): string {
  const workspaceRoot = resolve(input.workspaceRoot);
  const resolved = resolveWorkspacePath({
    inputPath: input.inputPath,
    operation: "write",
    workingDirectory: input.workingDirectory,
    workspaceRoot,
  });
  const workspaceRelative = relative(workspaceRoot, resolved);
  if (
    workspaceRelative.length === 0 ||
    isAbsolute(workspaceRelative) ||
    workspaceRelative === ".." ||
    workspaceRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    workspaceRelative.startsWith("../") ||
    workspaceRelative.startsWith("..\\")
  ) {
    throw new Error(`Project Work mutation target is outside the workspace: ${input.inputPath}`);
  }
  return workspaceRelative.split("\\").join("/");
}

export function isProjectWorkPathAllowed(
  targetPath: string,
  scope: readonly ProjectWorkScopeEntry[],
): boolean {
  const target = comparisonPath(targetPath);
  return scope.some((entry) => {
    const allowed = comparisonPath(entry.path);
    if (target === allowed) return true;
    return entry.recursive && target.startsWith(`${allowed}/`);
  });
}

function comparisonPath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
