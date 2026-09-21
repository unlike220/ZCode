import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

interface ProjectIntelligenceRootInput {
  cliStorageRoot: string;
  workspaceIdentity?: string;
  workspacePath: string;
}

export function resolveProjectIntelligenceRoot(input: ProjectIntelligenceRootInput): string {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  const normalizedWorkspacePath = resolve(input.workspacePath);
  const keySource =
    workspaceIdentity ||
    (process.platform === "win32"
      ? normalizedWorkspacePath.toLowerCase()
      : normalizedWorkspacePath);
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const slug = workspaceIdentity
    ? "project"
    : sanitizeProjectSlug(basename(normalizedWorkspacePath) || "project");

  return join(input.cliStorageRoot, "project-intelligence", "projects", `${slug}-${hash}`);
}

export function resolveProjectIntelligenceStatePath(rootDir: string): string {
  return join(rootDir, "state.json");
}

function sanitizeProjectSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "project";
}
