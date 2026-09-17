import { defineRule } from "@oxlint/plugins";

import { resolveVariable } from "../shared/scope.ts";

import type { ESTree, SourceCode } from "@oxlint/plugins";

const moduleMockMethods = new Set(["doMock", "mock", "unstable_mockModule"]);
const bunMockMethods = new Set(["module"]);

const ambientNamespaces = new Set(["vi", "jest"]);
const importedNamespaces = new Map([
  ["vitest\0vi", moduleMockMethods],
  ["@jest/globals\0jest", moduleMockMethods],
  ["bun:test\0jest", moduleMockMethods],
  ["bun:test\0mock", bunMockMethods],
]);

function importedName(node: ESTree.Node): string | null {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

/** Resolve the mocking methods banned on a namespace object, or null when it is not one. */
function bannedMethodsOn(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): ReadonlySet<string> | null {
  if (expression.type !== "Identifier") return null;
  const isAmbient = ambientNamespaces.has(expression.name);
  if (isAmbient && sourceCode.isGlobalReference(expression)) return moduleMockMethods;

  const variable = resolveVariable(sourceCode, expression);
  if (variable === null || variable.defs.length === 0) {
    return isAmbient ? moduleMockMethods : null;
  }

  for (const definition of variable.defs) {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") {
      continue;
    }
    const name = importedName(definition.node);
    if (name === null) continue;
    const methods = importedNamespaces.get(`${definition.parent.source.value}\0${name}`);
    if (methods !== undefined) return methods;
  }
  return null;
}

function computedMethodName(
  property: ESTree.Node,
  methods: ReadonlySet<string>,
): string | null {
  if (property.type !== "Literal") return null;
  for (const method of methods) {
    if (property.value === method) return method;
  }
  return null;
}

function moduleMockCall(sourceCode: SourceCode, callee: ESTree.Expression): boolean {
  if (!("property" in callee) || !("object" in callee) || !("computed" in callee)) return false;
  const methods = bannedMethodsOn(sourceCode, callee.object);
  if (methods === null) return false;
  const property = callee.property;
  const method = callee.computed
    ? computedMethodName(property, methods)
    : property.type === "Identifier"
      ? property.name
      : null;
  return method !== null && methods.has(method);
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Vitest, Jest, and Bun module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        if (moduleMockCall(context.sourceCode, node.callee)) {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
});
