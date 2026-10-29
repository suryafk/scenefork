// Contract test (eng review D8): the frontend accepts and rejects the same shared/ fixtures
// as the backend (backend/tests/test_contracts.py).
import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shared = resolve(__dirname, '../../shared');
const load = (p: string) => JSON.parse(readFileSync(resolve(shared, p), 'utf8'));

describe.each(['grounding', 'entity', 'plugin', 'suggestions'])('%s contract', (name) => {
  const validate = new Ajv2020({ strict: false }).compile(load(`${name}.schema.json`));
  it('accepts every valid fixture', () => {
    for (const doc of load(`fixtures/${name}_valid.json`)) expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });
  it('rejects every invalid fixture', () => {
    for (const doc of load(`fixtures/${name}_invalid.json`)) expect(validate(doc)).toBe(false);
  });
});

describe('frontend types track the schemas', () => {
  it('Grounding has exactly the schema fields', () => {
    const fields: (keyof import('./sim/types').Grounding)[] = [
      'label', 'body_type', 'mass_kg', 'restitution', 'friction', 'acoustic_material', 'approx_height_m',
    ];
    expect([...fields].sort()).toEqual(Object.keys(load('grounding.schema.json').properties).sort());
  });

  it('FreedEntity has exactly the schema fields', () => {
    const fields: (keyof import('./net/BackendClient').FreedEntity)[] = [
      'id', 'label', 'polygon_px', 'sprite_url', 'sprite_bbox', 'physics', 'acoustic_material',
    ];
    expect([...fields].sort()).toEqual(Object.keys(load('entity.schema.json').properties).sort());
  });
});
