import { describe, expect, it } from 'vitest'
import { takeActiveParsingTasks, trackParsingTask } from './_parsingTaskRegistry.js'

describe('parsing task registry', () => {
  it('returns an empty list for a project with no tracked tasks', () => {
    expect(takeActiveParsingTasks('unknown-project')).toEqual([])
  })

  it('tracks a task and hands it back exactly once', () => {
    trackParsingTask('project-a', 'task-1')
    expect(takeActiveParsingTasks('project-a')).toEqual(['task-1'])
    expect(takeActiveParsingTasks('project-a')).toEqual([])
  })

  it('tracks multiple tasks for the same project', () => {
    trackParsingTask('project-b', 'task-1')
    trackParsingTask('project-b', 'task-2')
    expect(takeActiveParsingTasks('project-b').sort()).toEqual([
      'task-1',
      'task-2',
    ])
  })

  it('untrack removes only its own task, leaving siblings tracked', () => {
    trackParsingTask('project-c', 'task-1')
    const untrack = trackParsingTask('project-c', 'task-2')
    untrack()
    expect(takeActiveParsingTasks('project-c')).toEqual(['task-1'])
  })

  it('untrack after the project was already taken is a no-op', () => {
    const untrack = trackParsingTask('project-d', 'task-1')
    expect(takeActiveParsingTasks('project-d')).toEqual(['task-1'])
    expect(() => untrack()).not.toThrow()
    expect(takeActiveParsingTasks('project-d')).toEqual([])
  })
})
