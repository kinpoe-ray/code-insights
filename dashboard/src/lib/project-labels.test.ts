import { describe, expect, it } from 'vitest';
import { buildProjectLabels, compactProjectPath } from './project-labels';
import type { Project } from './types';

const baseProject: Project = {
  id: 'project-a',
  name: 'workdir',
  path: '/teams/alpha/workdir',
  git_remote_url: null,
  session_count: 1,
  last_activity: '2026-08-10T00:00:00Z',
  created_at: '2026-08-10T00:00:00Z',
  updated_at: '2026-08-10T00:00:00Z',
};

describe('project labels', () => {
  it('keeps unique names concise and disambiguates duplicate names by path', () => {
    const labels = buildProjectLabels([
      baseProject,
      { ...baseProject, id: 'project-b', path: '/teams/beta/workdir' },
      { ...baseProject, id: 'project-c', name: 'skills', path: '/teams/skills' },
    ]);

    expect(labels.get('project-a')).toBe('workdir · alpha/workdir');
    expect(labels.get('project-b')).toBe('workdir · beta/workdir');
    expect(labels.get('project-c')).toBe('skills');
  });

  it('supports Windows paths and adds an id when compact paths still collide', () => {
    expect(compactProjectPath('C:\\teams\\alpha')).toBe('teams/alpha');
    const labels = buildProjectLabels([
      baseProject,
      { ...baseProject, id: 'project-b', path: baseProject.path },
    ]);

    expect(labels.get('project-a')).toContain('project-');
    expect(labels.get('project-b')).toContain('project-');
  });
});
