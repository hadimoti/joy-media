import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const REPO_ROOT = new URL('../../../', import.meta.url);
const INSERT_KIND = 'timeline.insertExistingAsset';

function unwrap(node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function propertyName(node) {
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return undefined;
}

function findProperty(object, name) {
  const node = unwrap(object);
  if (!ts.isObjectLiteralExpression(node)) throw new Error(`expected an object for ${name}`);
  return node.properties.find(
    (property) => ts.isPropertyAssignment(property) && propertyName(property) === name,
  );
}

function propertyValue(object, name) {
  const property = findProperty(object, name);
  if (!property) throw new Error(`renderer contract is missing ${name}`);
  return unwrap(property.initializer);
}

function findVariableInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        if (!declaration.initializer) throw new Error(`${name} has no initializer`);
        return unwrap(declaration.initializer);
      }
    }
  }
  throw new Error(`renderer contract is missing ${name}`);
}

function findFunction(sourceFile, name) {
  const declaration = sourceFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body,
  );
  if (!declaration) throw new Error(`renderer contract is missing ${name}`);
  return declaration;
}

function findReturnObject(functionDeclaration) {
  let result;
  function visit(node) {
    if (result) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const expression = unwrap(node.expression);
      if (ts.isObjectLiteralExpression(expression)) result = expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(functionDeclaration.body);
  if (!result)
    throw new Error(`renderer contract has no object return in ${functionDeclaration.name.text}`);
  return result;
}

function findDescendant(node, predicate) {
  if (predicate(node)) return node;
  let found;
  ts.forEachChild(node, (child) => {
    if (!found) found = findDescendant(child, predicate);
  });
  return found;
}

function literalValue(node) {
  const value = unwrap(node);
  if (ts.isStringLiteral(value) || ts.isNumericLiteral(value)) {
    return ts.isStringLiteral(value) ? value.text : Number(value.text);
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(value)) return value.elements.map(literalValue);
  if (ts.isObjectLiteralExpression(value)) return objectValue(value);
  throw new Error(`renderer contract contains an unsupported literal: ${value.getText()}`);
}

function objectValue(node) {
  const value = unwrap(node);
  if (!ts.isObjectLiteralExpression(value)) throw new Error('expected a renderer object literal');
  return Object.fromEntries(
    value.properties
      .filter(ts.isPropertyAssignment)
      .map((property) => [propertyName(property), literalValue(property.initializer)]),
  );
}

function stringArray(node) {
  const values = literalValue(node);
  if (!Array.isArray(values) || !values.every((value) => typeof value === 'string')) {
    throw new Error('renderer contract expected an array of strings');
  }
  return values;
}

function parseFile(text, fileName) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function validateSchema(value, schema, path, errors) {
  if (schema.oneOf) {
    const validCount = schema.oneOf.filter((candidate) => {
      const nestedErrors = [];
      validateSchema(value, candidate, path, nestedErrors);
      return nestedErrors.length === 0;
    }).length;
    if (validCount !== 1) errors.push(`${path} must match exactly one renderer operation`);
    return;
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    errors.push(`${path} must equal ${schema.const}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
    return;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key))
        validateSchema(value[key], childSchema, `${path}.${key}`, errors);
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path} has too many items`);
    if (schema.items)
      value.forEach((entry, index) =>
        validateSchema(entry, schema.items, `${path}[${index}]`, errors),
      );
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') errors.push(`${path} must be a string`);
    else {
      if (schema.minLength !== undefined && value.length < schema.minLength)
        errors.push(`${path} is too short`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        errors.push(`${path} is too long`);
    }
    return;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${path} must be an integer`);
    else if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path} is below the renderer minimum`);
  }
}

export async function loadRendererProposalContract() {
  const [hostToolText, loopText, registryText, planText, planTestText] = await Promise.all([
    readFile(new URL('apps/editor-web/src/joy-agent/host-tool-contract.ts', REPO_ROOT), 'utf8'),
    readFile(new URL('apps/editor-web/src/joy-agent/bounded-tool-loop.ts', REPO_ROOT), 'utf8'),
    readFile(new URL('packages/agent-tools/src/editor-operation-registry.ts', REPO_ROOT), 'utf8'),
    readFile(new URL('packages/agent-tools/src/joy-code-plan.ts', REPO_ROOT), 'utf8'),
    readFile(new URL('apps/editor-web/src/joy-agent/bounded-tool-loop.test.ts', REPO_ROOT), 'utf8'),
  ]);
  const hostToolsFile = parseFile(hostToolText, 'host-tool-contract.ts');
  const loopFile = parseFile(loopText, 'bounded-tool-loop.ts');
  const registryFile = parseFile(registryText, 'editor-operation-registry.ts');
  const planFile = parseFile(planText, 'joy-code-plan.ts');

  const hostToolNames = stringArray(
    findVariableInitializer(hostToolsFile, 'JOY_AGENT_HOST_TOOL_NAMES'),
  );
  const readProjectContextTool = objectValue(
    findVariableInitializer(loopFile, 'READ_PROJECT_CONTEXT_TOOL'),
  );
  const proposalToolFunction = propertyValue(
    findReturnObject(findFunction(loopFile, 'createValidateProposalTool')),
    'function',
  );
  const proposalToolName = literalValue(propertyValue(proposalToolFunction, 'name'));
  const proposalToolDescription = literalValue(propertyValue(proposalToolFunction, 'description'));
  if (!hostToolNames.includes(proposalToolName)) {
    throw new Error(`renderer proposal tool ${proposalToolName} is absent from its host allowlist`);
  }

  const operationSchemasNode = findVariableInitializer(registryFile, 'OPERATION_INPUT_SCHEMAS');
  const operationProperty = findProperty(operationSchemasNode, INSERT_KIND);
  if (!operationProperty) throw new Error(`renderer schema is missing ${INSERT_KIND}`);
  const operationCall = unwrap(operationProperty.initializer);
  if (!ts.isCallExpression(operationCall))
    throw new Error(`${INSERT_KIND} has no renderer schema call`);
  const operationKind = literalValue(operationCall.arguments[0]);
  const operationProperties = objectValue(operationCall.arguments[1]);
  const operationRequired = stringArray(operationCall.arguments[2]);
  const evidenceNode = findVariableInitializer(registryFile, 'OPERATION_EVIDENCE');
  const evidence = objectValue(propertyValue(evidenceNode, INSERT_KIND));
  if (evidence.status !== 'verified' || evidence.tests.length === 0) {
    throw new Error(`${INSERT_KIND} is not a verified model-visible renderer operation`);
  }
  const operationSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      dependsOn: { type: 'array', items: { type: 'string' } },
      kind: { const: operationKind },
      ...operationProperties,
    },
    required: ['id', 'dependsOn', 'kind', ...operationRequired],
    additionalProperties: false,
  };

  const planLimitsNode = findVariableInitializer(planFile, 'JOY_CODE_PLAN_LIMITS');
  const limitsObject = findDescendant(planLimitsNode, ts.isObjectLiteralExpression);
  if (!limitsObject) throw new Error('renderer plan limits are missing');
  const maxOperations = literalValue(propertyValue(limitsObject, 'operations'));
  const proposalSchemaFunction = findFunction(
    registryFile,
    'createModelVisibleJoyCodeProposalParameters',
  );
  const proposalSchemaNode = findReturnObject(proposalSchemaFunction);
  const topProperties = propertyValue(proposalSchemaNode, 'properties');
  const topRequired = stringArray(propertyValue(proposalSchemaNode, 'required'));
  const proposalParameters = {
    type: literalValue(propertyValue(proposalSchemaNode, 'type')),
    properties: {
      summary: objectValue(propertyValue(topProperties, 'summary')),
      operations: {
        type: literalValue(propertyValue(propertyValue(topProperties, 'operations'), 'type')),
        items: { oneOf: [operationSchema] },
        maxItems: maxOperations,
      },
    },
    required: topRequired,
    additionalProperties: literalValue(propertyValue(proposalSchemaNode, 'additionalProperties')),
  };

  const readId = findFunction(planFile, 'readId');
  const idRegexNode = findDescendant(readId, ts.isRegularExpressionLiteral);
  if (!idRegexNode) throw new Error('renderer ID validation pattern is missing');
  const idPatternText = idRegexNode.text;
  const lastSlash = idPatternText.lastIndexOf('/');
  const idPattern = new RegExp(
    idPatternText.slice(1, lastSlash),
    idPatternText.slice(lastSlash + 1),
  );
  const rendererFixtureAssetId = /\bassetId:\s*'([^']+)'/u.exec(planTestText)?.[1];
  if (!rendererFixtureAssetId) throw new Error('renderer test asset ID fixture is missing');

  const validateProposalTool = {
    type: literalValue(
      propertyValue(findReturnObject(findFunction(loopFile, 'createValidateProposalTool')), 'type'),
    ),
    function: {
      name: proposalToolName,
      description: proposalToolDescription,
      parameters: proposalParameters,
    },
  };
  return {
    hostToolNames,
    proposalToolName,
    readProjectContextTool,
    validateProposalTool,
    proposalParameters,
    operationKind,
    idPattern,
    rendererFixtureAssetId,
  };
}

export function assertRendererProposalArguments(contract, value) {
  const errors = [];
  validateSchema(value, contract.proposalParameters, 'arguments', errors);
  const operation = value?.operations?.[0];
  if (operation && operation.id !== undefined && !contract.idPattern.test(operation.id)) {
    errors.push('arguments.operations[0].id contains unsupported renderer ID characters');
  }
  if (operation && Array.isArray(operation.dependsOn)) {
    for (const [index, id] of operation.dependsOn.entries()) {
      if (!contract.idPattern.test(id)) {
        errors.push(
          `arguments.operations[0].dependsOn[${index}] contains unsupported renderer ID characters`,
        );
      }
    }
  }
  for (const key of ['compositionId', 'targetTrackId', 'assetId']) {
    if (
      operation &&
      typeof operation[key] === 'string' &&
      !contract.idPattern.test(operation[key])
    ) {
      errors.push(`arguments.operations[0].${key} contains unsupported renderer ID characters`);
    }
  }
  if (errors.length > 0)
    throw new Error(`renderer proposal arguments are invalid: ${errors.join('; ')}`);
}
