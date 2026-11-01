import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAgentSlotConfigured } from '@joy-media/provider-sdk';
import {
  clearAgentSlotsForProfile,
  readAgentSlot,
  readAgentSlots,
  writeAgentSlot,
} from './agent-slots.js';
import { LocalDatabase } from './local-database.js';

/**
 * The desktop side of the two agent slots (D17, PLAN-v4 §6d-1). The store keeps each slot on its own, so one agent's
 * binding never touches the other's, and a profile that is deleted empties only the slots that named it.
 */
describe('agent slots in the desktop store', () => {
  let dir: string;
  let file: string;
  let opened: LocalDatabase[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'joy-slots-'));
    file = join(dir, 'app.sqlite');
  });

  afterEach(() => {
    // A failed assertion must not leave a database open, or the directory cannot be removed.
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // Already closed by the test.
      }
    }
    opened = [];
    rmSync(dir, { recursive: true, force: true });
  });

  function open(): LocalDatabase {
    const db = new LocalDatabase({ filePath: file, now: () => 'T0' });
    opened.push(db);
    return db;
  }

  it('starts with two empty slots that cannot run', () => {
    const db = open();

    const slots = readAgentSlots(db);

    expect(slots.map((slot) => slot.id)).toEqual(['workhorse', 'creative']);
    expect(slots.every((slot) => slot.profileId === undefined)).toBe(true);
    expect(slots.every((slot) => slot.model === undefined)).toBe(true);
    expect(slots.some((slot) => isAgentSlotConfigured(slot))).toBe(false);
  });

  it('writes a slot and reads it back, and leaves the other slot alone', () => {
    const db = open();

    const result = writeAgentSlot(db, 'workhorse', {
      profileId: 'p-one',
      model: 'model-one',
      instructions: 'Be brief.',
      settings: { temperature: 0.3 },
    });

    expect(result.ok).toBe(true);
    expect(readAgentSlot(db, 'workhorse')).toMatchObject({
      profileId: 'p-one',
      model: 'model-one',
      instructions: 'Be brief.',
      settings: { temperature: 0.3 },
    });
    expect(readAgentSlot(db, 'creative').profileId).toBeUndefined();
    expect(isAgentSlotConfigured(readAgentSlot(db, 'creative'))).toBe(false);
  });

  it('keeps the two slots independent, with their own profiles and models', () => {
    const db = open();

    writeAgentSlot(db, 'workhorse', { profileId: 'p-one', model: 'model-one' });
    writeAgentSlot(db, 'creative', { profileId: 'p-two', model: 'model-two' });

    expect(readAgentSlot(db, 'workhorse')).toMatchObject({
      profileId: 'p-one',
      model: 'model-one',
    });
    expect(readAgentSlot(db, 'creative')).toMatchObject({
      profileId: 'p-two',
      model: 'model-two',
    });
  });

  it('holds two agents on one provider, each with its own model', () => {
    const db = open();

    writeAgentSlot(db, 'workhorse', { profileId: 'p-shared', model: 'model-one' });
    writeAgentSlot(db, 'creative', { profileId: 'p-shared', model: 'model-two' });

    expect(readAgentSlot(db, 'workhorse')).toMatchObject({
      profileId: 'p-shared',
      model: 'model-one',
    });
    expect(readAgentSlot(db, 'creative')).toMatchObject({
      profileId: 'p-shared',
      model: 'model-two',
    });
  });

  it('refuses a draft that breaks the rules and leaves the saved slot as it was', () => {
    const db = open();
    writeAgentSlot(db, 'workhorse', { profileId: 'p-one', model: 'model-one' });

    const result = writeAgentSlot(db, 'workhorse', { settings: { temperature: 9 } });

    expect(result.ok).toBe(false);
    expect(readAgentSlot(db, 'workhorse')).toMatchObject({
      profileId: 'p-one',
      model: 'model-one',
    });
  });

  it('reads a stored slot that no longer passes the rules as empty', () => {
    const db = open();
    db.setSetting('agent_slot.workhorse', JSON.stringify({ profileId: 42, model: 'model-one' }));

    const slot = readAgentSlot(db, 'workhorse');

    expect(slot.profileId).toBeUndefined();
    expect(slot.model).toBeUndefined();
    expect(isAgentSlotConfigured(slot)).toBe(false);
  });

  it('empties only the slot that names the deleted profile', () => {
    const db = open();
    writeAgentSlot(db, 'workhorse', {
      profileId: 'p-one',
      model: 'model-one',
      instructions: 'Be brief.',
    });
    writeAgentSlot(db, 'creative', { profileId: 'p-two', model: 'model-two' });

    const cleared = clearAgentSlotsForProfile(db, 'p-one');

    expect(cleared).toEqual(['workhorse']);
    expect(readAgentSlot(db, 'workhorse')).toMatchObject({
      profileId: undefined,
      model: 'model-one',
      instructions: 'Be brief.',
    });
    // The other agent keeps its own binding: only the slot that named the deleted profile is affected.
    expect(readAgentSlot(db, 'creative')).toMatchObject({
      profileId: 'p-two',
      model: 'model-two',
    });
    expect(isAgentSlotConfigured(readAgentSlot(db, 'creative'))).toBe(true);
  });

  it('empties both slots when they share the deleted profile', () => {
    const db = open();
    writeAgentSlot(db, 'workhorse', { profileId: 'p-shared', model: 'model-one' });
    writeAgentSlot(db, 'creative', { profileId: 'p-shared', model: 'model-two' });

    const cleared = clearAgentSlotsForProfile(db, 'p-shared');

    expect(cleared).toEqual(['workhorse', 'creative']);
    expect(readAgentSlot(db, 'workhorse').profileId).toBeUndefined();
    expect(readAgentSlot(db, 'creative').profileId).toBeUndefined();
    // Only the profile binding is emptied. Each agent keeps its own model.
    expect(readAgentSlot(db, 'workhorse').model).toBe('model-one');
    expect(readAgentSlot(db, 'creative').model).toBe('model-two');
  });

  it('changes nothing when the deleted profile names no slot', () => {
    const db = open();
    writeAgentSlot(db, 'workhorse', { profileId: 'p-one', model: 'model-one' });

    const cleared = clearAgentSlotsForProfile(db, 'p-other');

    expect(cleared).toEqual([]);
    expect(readAgentSlot(db, 'workhorse')).toMatchObject({
      profileId: 'p-one',
      model: 'model-one',
    });
  });
});
