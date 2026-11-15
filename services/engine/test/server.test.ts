import { expect, test } from 'bun:test';
import { contract } from '@traces/contract';

test('contract router is exported', () => {
  expect(contract).toBeDefined();
});
