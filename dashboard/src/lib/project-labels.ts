import type { Project } from '@/lib/types';

export function compactProjectPath(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return path;
  return segments.slice(-2).join('/');
}

/**
 * Project names are user-facing labels, not identities. Local agents commonly
 * emit generic names such as "workdir" or "Project", so duplicate labels must
 * include a compact path before they are safe to use in filters.
 */
export function buildProjectLabels(projects: Project[]): Map<string, string> {
  const nameCounts = new Map<string, number>();
  for (const project of projects) {
    nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
  }

  const baseLabels = projects.map((project) => {
    const duplicateName = (nameCounts.get(project.name) ?? 0) > 1;
    const label = duplicateName
      ? `${project.name} · ${compactProjectPath(project.path)}`
      : project.name;
    return { project, label };
  });

  const labelCounts = new Map<string, number>();
  for (const { label } of baseLabels) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }

  return new Map(baseLabels.map(({ project, label }) => [
    project.id,
    (labelCounts.get(label) ?? 0) > 1
      ? `${label} · ${project.id.slice(0, 12)}`
      : label,
  ]));
}
