import { describe, expect, it } from 'vitest';
import { browserActivity } from '../src/engine/browser.js';
import { eventSink } from '../src/engine/engine.js';
import { EventStore, VIEWS_KEPT } from '../src/events/store.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('browser', () => {
  it('spots browser calls and the page they go to', () => {
    expect(browserActivity('Bash', { command: 'npx playwright screenshot http://localhost:5173/login, shot.png' })).toEqual({ url: 'http://localhost:5173/login' });
    expect(browserActivity('Bash', { command: "node -e \"const { chromium } = require('playwright'); …\"" })).toEqual({});
    expect(browserActivity('Bash', { command: 'curl http://localhost:3000' })).toBeUndefined();
    expect(browserActivity('Read', { file_path: 'playwright.config.ts' })).toBeUndefined();
    expect(browserActivity('mcp__playwright__browser_navigate', { url: 'https://example.com' })).toEqual({ url: 'https://example.com' });
  });

  it('keeps the images a member saw, the newest per member, and only real images', () => {
    const store = new EventStore(':memory:');
    store.createRun({ id: 'r1', team: 't', teamFile: '/t.yaml', repo: '/r', goal: 'g' });
    const sink = eventSink(store, 'r1', { step: 'build', agent: 'web' });
    const image = { kind: 'image' as const, tool: 'Read', input: { file_path: '/w/shot.png' }, mediaType: 'image/png', data: PNG.toString('base64') };
    sink(image);
    sink({ ...image, mediaType: 'text/html' });
    const views = store.events('r1').filter((e) => e.type === 'agent.view');
    expect(views).toMatchObject([{ agent: 'web', step: 'build', data: { id: 1, tool: 'Read', file: '/w/shot.png', media_type: 'image/png' } }]);
    expect(store.getView('r1', 1)).toEqual({ mediaType: 'image/png', data: PNG });

    for (let i = 0; i < VIEWS_KEPT + 5; i++) store.addView('r1', 'web', 'image/png', PNG);
    expect(store.getView('r1', 1)).toBeUndefined();
    expect(store.getView('r1', VIEWS_KEPT + 6)).toBeDefined();
    expect(store.getView('other-run', VIEWS_KEPT + 6)).toBeUndefined();
  });
});
