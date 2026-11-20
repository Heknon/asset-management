import { describe, expect, it } from 'bun:test';
import { otherNamesOf } from './model.js';

describe('otherNamesOf', () => {
  it('keeps every other name once, trimmed', () => {
    expect(otherNamesOf(['Noa', ' Levi ', 'Noa Levi', 'נועה לוי', 'NOA'], ['Noa Levi (IT)', 'noal', null])).toEqual(['Noa', 'Levi', 'Noa Levi', 'נועה לוי']);
  });
  it('drops names already stored as the display name, username or email', () => {
    expect(otherNamesOf(['noal', 'Noa Levi', 'noa@corp.example', ''], ['noa levi', 'NOAL', 'noa@corp.example'])).toEqual([]);
  });
});
