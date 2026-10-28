import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AgentRequestRegistry, cancelWhenPageGoes } from './agent-requests.js';

describe('AgentRequestRegistry', () => {
  it('refuses an id that is already in use, rather than sharing it', () => {
    const calls = new AgentRequestRegistry();

    expect(calls.begin('call-1')).toBeInstanceOf(AbortController);
    expect(calls.begin('call-1')).toBeUndefined();
  });

  it('removes only the call it finished, so an older call cannot take a newer one out', () => {
    const calls = new AgentRequestRegistry();
    const older = calls.begin('call-1');
    if (older === undefined) throw new Error('expected the older call');
    calls.finish('call-1', older);
    const newer = calls.begin('call-1');
    if (newer === undefined) throw new Error('expected the newer call');

    // The older call finishes again. It must not remove the newer call.
    calls.finish('call-1', older);

    expect(calls.cancel('call-1')).toBe(true);
    expect(newer.signal.aborted).toBe(true);
  });

  it('cancels a named call, and every call in progress when the page reloads', () => {
    const calls = new AgentRequestRegistry();
    const first = calls.begin('a');
    const second = calls.begin('b');
    if (first === undefined || second === undefined) throw new Error('expected both calls');

    expect(calls.cancel('a')).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);

    calls.cancelAll();

    expect(second.signal.aborted).toBe(true);
    expect(calls.cancel('b')).toBe(false);
  });

  it.each(['did-start-loading', 'render-process-gone'])(
    'ends every call in progress when the page emits %s',
    (pageEvent) => {
      const calls = new AgentRequestRegistry();
      const webContents = new EventEmitter();
      const browserWindow = Object.assign(new EventEmitter(), { webContents });
      cancelWhenPageGoes(calls, browserWindow);
      const call = calls.begin('call-1');
      if (call === undefined) throw new Error('expected the call');

      webContents.emit(pageEvent);

      expect(call.signal.aborted).toBe(true);
      expect(calls.cancel('call-1')).toBe(false);
    },
  );

  it('ends every call in progress when the window closes', () => {
    const calls = new AgentRequestRegistry();
    const browserWindow = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
    cancelWhenPageGoes(calls, browserWindow);
    const call = calls.begin('call-1');
    if (call === undefined) throw new Error('expected the call');

    browserWindow.emit('closed');

    expect(call.signal.aborted).toBe(true);
  });
});

describe('the desktop entry point', () => {
  it('ends the calls in progress when the main window goes', () => {
    // electron-entry.ts loads Electron, so it cannot be imported here. Its syntax tree must hold the wiring call as a
    // statement: a comment that names the call, or a block comment that holds it, is not one.
    const entry = ts.createSourceFile(
      'electron-entry.ts',
      readFileSync(fileURLToPath(new URL('./electron-entry.ts', import.meta.url)), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(hasWiringCall(entry)).toBe(true);
  });

  it('does not take a commented-out call for the wiring', () => {
    const commented = ts.createSourceFile(
      'sample.ts',
      '/* cancelWhenPageGoes(agentRequests, win); */\n// cancelWhenPageGoes(agentRequests, win);\n',
      ts.ScriptTarget.Latest,
      true,
    );

    expect(hasWiringCall(commented)).toBe(false);
  });
});

/** True when a statement in the tree is the call cancelWhenPageGoes(agentRequests, win). Comments are not nodes. */
function hasWiringCall(node: ts.Node): boolean {
  return isWiringCall(node) || ts.forEachChild(node, hasWiringCall) === true;
}

function isWiringCall(node: ts.Node): boolean {
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
  const call = node.expression;
  const names = ['agentRequests', 'win'];
  return (
    ts.isIdentifier(call.expression) &&
    call.expression.text === 'cancelWhenPageGoes' &&
    call.arguments.length === names.length &&
    call.arguments.every(
      (argument, index) => ts.isIdentifier(argument) && argument.text === names[index],
    )
  );
}
