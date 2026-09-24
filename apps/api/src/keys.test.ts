import { describe, expect, it } from 'vitest';
import { KeyConfigError, parseProductKeys, readKey } from './keys.js';

describe('PRODUCT_KEYS', () => {
  const keys = parseProductKeys('claude:exosocial-claude-0123456789, exopost:exosocial-exopost-0123456789');

  it('ключ називає продукт', () => {
    expect(keys.resolve('exosocial-claude-0123456789')).toBe('claude');
    expect(keys.resolve('exosocial-exopost-0123456789')).toBe('exopost');
    expect(keys.resolve('exosocial-claude-012345678')).toBeNull();
    expect(keys.resolve(null)).toBeNull();
    expect(keys.products).toEqual(['claude', 'exopost']);
    expect(keys.secretOf('claude')).toBe('exosocial-claude-0123456789');
  });

  it.each([
    ['', /порожній/],
    ['claude', /продукт:секрет/],
    ['claude:short', /16/],
    ['Claude:0123456789abcdef', /kebab/],
    ['a:0123456789abcdef,b:0123456789abcdef', /двом продуктам/],
    ['a:0123456789abcdef,a:fedcba9876543210', /два ключі/],
  ])('відмова на старті: %s', (raw, msg) => {
    expect(() => parseProductKeys(raw)).toThrow(KeyConfigError);
    expect(() => parseProductKeys(raw)).toThrow(msg);
  });

  it('повідомлення про ключі не містить ключів', () => {
    try {
      parseProductKeys('claude:tooShortSecret');
    } catch (e) {
      expect((e as Error).message).not.toContain('tooShortSecret');
    }
  });

  it('Bearer або X-Api-Key', () => {
    expect(readKey({ authorization: 'Bearer abc' })).toBe('abc');
    expect(readKey({ 'x-api-key': 'xyz' })).toBe('xyz');
    expect(readKey({})).toBeNull();
  });
});
