import { describe, expect, it } from 'bun:test';
import { buildSearchText } from '@am/core';
import { personSearchName } from './pg-registry-store.js';

describe('personSearchName', () => {
  it('adds username, email and other names after the display name', () => {
    expect(personSearchName('Noa Levi', ['noal', 'noa@corp.example', 'Noa', 'Levi', 'נועה לוי'])).toBe('Noa Levi (noal, noa@corp.example, Noa, Levi, נועה לוי)');
  });
  it('is just the display name when there is nothing else', () => {
    expect(personSearchName('Noa Levi', [null, null])).toBe('Noa Levi');
    expect(personSearchName('Noa Levi', ['noa levi'])).toBe('Noa Levi');
  });
  it('puts every name of the owner into an asset\'s search text', () => {
    const text = buildSearchText({ fields: [] }, 'Figma', {}, personSearchName('Noa Levi', ['noal', 'noa@corp.example', 'Levi']), {
      typeName: 'License',
      statusLabel: 'Active',
      unitName: 'Design',
      personName: () => undefined,
      assetName: () => undefined,
    });
    for (const name of ['Noa Levi', 'noal', 'noa@corp.example', 'Levi']) expect(text).toContain(name);
  });
});
