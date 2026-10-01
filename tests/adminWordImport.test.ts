import { describe, expect, it } from 'vitest';
import { parseAdminWordImport } from '../src/lib/adminWordImport';

describe('admin CSV', () => {
  it('supports quoted commas, explicit IDs, meaning and levels', () => {
    expect(parseAdminWordImport('id,expression,reading,meaning,level\ncard-1,"猫,犬",ねこ,cat,N3\n,鳥,とり,"small, flying",')).toEqual([
      { id: 'card-1', expression: '猫,犬', reading: 'ねこ', meaning: 'cat', level: 'N3' },
      { expression: '鳥', reading: 'とり', meaning: 'small, flying' },
    ]);
  });
  it('omitting columns preserves existing values, while an empty meaning explicitly clears it', () => {
    expect(parseAdminWordImport('expression,reading\n猫,ねこ')).toEqual([{ expression: '猫', reading: 'ねこ' }]);
    expect(parseAdminWordImport('expression,reading,meaning\n猫,ねこ,')).toEqual([{ expression: '猫', reading: 'ねこ', meaning: '' }]);
  });
  it('fails closed on malformed, duplicate, unknown or invalid rows', () => {
    for (const text of [
      'expression,reading\n猫,ねこ\n猫,ねこ',
      'id,expression,reading\na,猫,ねこ\na,犬,いぬ',
      'expression,reading,level\n猫,ねこ,Admin',
      'expression,reading,unknown\n猫,ねこ,extra',
      'expression,reading\n猫',
      'expression,reading\n,ねこ',
    ]) expect(() => parseAdminWordImport(text)).toThrow();
  });
});
