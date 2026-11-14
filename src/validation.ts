import { Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { default as formats } from 'ajv-formats';

// Provider schemas use several drafts. Never coerce values or fill defaults before a write.
const options = { strict: false, allErrors: true, validateFormats: true, addUsedSchema: false };
const validators = [new Ajv(options), new Ajv2019(options), new Ajv2020(options)];
for (const ajv of validators) (formats as unknown as (a: Ajv) => void)(ajv);

/**
 * Compiled checks by schema text. Each app call brings a fresh copy of the same schema, and Ajv keeps every
 * schema object it compiles, so without this the cache would grow for as long as the backend runs.
 */
const compiled = new Map<string, ReturnType<Ajv['compile']>>();
export const COMPILED_MAX = 256;

export function argumentError(schema: Record<string, unknown>, input: unknown): string | null {
  const draft = String(schema.$schema ?? '');
  const ajv = draft.includes('2020-12') ? validators[2] : draft.includes('2019-09') ? validators[1] : validators[0];
  try {
    const key = `${validators.indexOf(ajv)}:${JSON.stringify(schema)}`;
    let check = compiled.get(key);
    if (!check) {
      if (compiled.size >= COMPILED_MAX) {
        compiled.clear();
        for (const v of validators) v.removeSchema();
      }
      check = ajv.compile(schema);
      compiled.set(key, check);
    }
    return check(input) ? null : `Invalid arguments: ${ajv.errorsText(check.errors).slice(0, 1000)}`;
  } catch {
    return 'Cannot validate arguments: the provider schema is unsupported or malformed. No action was sent.';
  }
}
