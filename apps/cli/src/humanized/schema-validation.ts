import Ajv from 'ajv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ajv = new Ajv({ allErrors: true });
const schemaDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../schemas/v1');
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

/** Validate a CLI document/event using the versioned schemas shipped with the CLI source. */
export function cliSchemaErrors(schemaFile: string, value: unknown): string[] {
  const path = resolve(schemaDirectory, schemaFile);
  const relativePath = relative(schemaDirectory, path);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return [`schema path escapes versioned schema directory: ${schemaFile}`];
  }
  if (!existsSync(path)) return [`schema file is missing: ${schemaFile}`];

  let validator = validators.get(schemaFile);
  if (!validator) {
    const schema = JSON.parse(readFileSync(path, 'utf8')) as object;
    validator = ajv.compile(schema);
    validators.set(schemaFile, validator);
  }

  return validator(value)
    ? []
    : (validator.errors ?? []).map(
        (error) => `${error.dataPath || '/'} ${error.message ?? error.keyword}`,
      );
}
