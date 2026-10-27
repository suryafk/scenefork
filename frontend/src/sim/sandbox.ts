// Plugin loader (design: Plugin confinement, eng review D6). The PhysicsWorker is the trust
// boundary: no DOM, network APIs stubbed, postMessage captured by runtime code. These parser
// checks are a speed bump that turns most model mistakes into a clear error for the repair
// round, not the wall.
import { parse } from 'acorn';

export const ALLOWED_GLOBALS = new Set(['ctx', 'Math', 'Number', 'Infinity', 'NaN', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'JSON']);
const FORBIDDEN_PROPS = new Set(['constructor', '__proto__', 'prototype']);
export const HOOK_NAMES = ['onInit', 'onStep', 'onCollision', 'onGrab', 'onRelease'] as const;
export type HookName = (typeof HOOK_NAMES)[number];
export type Hooks = Partial<Record<HookName, (...args: unknown[]) => void>>;
export const MAX_SOURCE_CHARS = 6000;

type Node = { type: string; start: number; [k: string]: unknown };

const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && typeof (v as Node).type === 'string';

function children(node: Node): [string, Node][] {
  const out: [string, Node][] = [];
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => isNode(c) && out.push([key, c]));
    else if (isNode(v)) out.push([key, v]);
  }
  return out;
}

/** Names bound by a declaration pattern (`a`, `{a, b: c}`, `[d, ...e]`, `f = 1`). */
function patternNames(p: Node | null | undefined, into: Set<string>): void {
  if (!p) return;
  switch (p.type) {
    case 'Identifier':
      into.add(p.name as string);
      return;
    case 'ObjectPattern':
      for (const prop of p.properties as Node[]) patternNames(prop.type === 'RestElement' ? (prop.argument as Node) : (prop.value as Node), into);
      return;
    case 'ArrayPattern':
      for (const el of p.elements as (Node | null)[]) patternNames(el, into);
      return;
    case 'RestElement':
      patternNames(p.argument as Node, into);
      return;
    case 'AssignmentPattern':
      patternNames(p.left as Node, into);
      return;
  }
}

/** Every problem with a plugin's source, as short sentences the MutatorAgent can act on. Empty means OK. */
export function checkPluginSource(source: string): string[] {
  if (source.length > MAX_SOURCE_CHARS) return [`source is ${source.length} chars; the limit is ${MAX_SOURCE_CHARS}`];
  let ast: Node;
  try {
    ast = parse(source, { ecmaVersion: 2022, sourceType: 'script', allowReturnOutsideFunction: true }) as unknown as Node;
  } catch (e) {
    return [`syntax error: ${(e as Error).message}`];
  }

  // Pass 1: every name the plugin declares anywhere is local (block scoping is not modeled:
  // this is a speed bump, the worker is the wall).
  const declared = new Set<string>();
  const collect = (node: Node) => {
    switch (node.type) {
      case 'VariableDeclarator':
        patternNames(node.id as Node, declared);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) patternNames(node.id as Node, declared);
        for (const p of node.params as Node[]) patternNames(p, declared);
        break;
      case 'CatchClause':
        patternNames(node.param as Node, declared);
        break;
    }
    for (const [, c] of children(node)) collect(c);
  };
  collect(ast);

  const problems = new Set<string>();
  const add = (msg: string) => problems.add(msg);
  const propName = (key: Node) => (key.type === 'Identifier' ? (key.name as string) : key.type === 'Literal' ? String(key.value) : '');
  const isNumberLiteral = (n: Node) => n.type === 'Literal' && typeof n.value === 'number';

  const visit = (node: Node, parent: Node | null, key: string) => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ImportExpression':
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        add('import/export is not allowed');
        break;
      case 'AwaitExpression':
        add('async/await is not allowed');
        break;
      case 'WithStatement':
        add('`with` is not allowed');
        break;
      case 'ThisExpression':
        add('`this` is not allowed; use closure variables');
        break;
      case 'Super':
      case 'ClassDeclaration':
      case 'ClassExpression':
        add('classes are not allowed; use plain objects and functions');
        break;
      case 'MetaProperty':
        add(`\`${(node.meta as Node).name}.${(node.property as Node).name}\` is not allowed`);
        break;
      case 'DebuggerStatement':
        add('`debugger` is not allowed');
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.async) add('async functions are not allowed');
        break;
      case 'MemberExpression': {
        const prop = node.property as Node;
        if (node.computed) {
          if (!isNumberLiteral(prop)) add('computed member access like a[i] is not allowed; use a numeric literal index, for...of, or array methods');
        } else if (FORBIDDEN_PROPS.has(propName(prop))) {
          add(`property \`${propName(prop)}\` is not allowed`);
        }
        break;
      }
      case 'Property':
      case 'MethodDefinition':
      case 'PropertyDefinition': {
        const k = node.key as Node;
        if (node.computed && !isNumberLiteral(k)) add('computed object keys are not allowed');
        else if (FORBIDDEN_PROPS.has(propName(k))) add(`property \`${propName(k)}\` is not allowed`);
        break;
      }
      case 'Identifier': {
        const name = node.name as string;
        const isPropKey =
          (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
          ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && key === 'key' && !parent.computed);
        const isLabel = key === 'label';
        if (isPropKey || isLabel) break;
        if (name === 'arguments') add('`arguments` is not allowed; use named or rest parameters');
        else if (name === 'undefined') add('`undefined` is not allowed; compare with `== null` or use `void 0`');
        else if (!declared.has(name) && !ALLOWED_GLOBALS.has(name)) add(`\`${name}\` is not available to plugins (allowed: ${[...ALLOWED_GLOBALS].join(', ')})`);
        break;
      }
    }
    for (const [k, c] of children(node)) visit(c, node, k);
  };
  visit(ast, null, '');
  return [...problems];
}

/** Math with a seeded `random`, so verification runs and their baselines are repeatable. */
function seededMath(random: () => number): Math {
  const m = Object.create(null) as Record<string, unknown>;
  for (const k of Object.getOwnPropertyNames(Math)) m[k] = (Math as unknown as Record<string, unknown>)[k];
  m.random = random;
  return Object.freeze(m) as unknown as Math;
}

/**
 * Check, compile and run the plugin factory. Throws with a readable message on any problem.
 * The body runs in strict mode, so `this` inside it is undefined, not the worker global.
 */
export function compilePlugin(source: string, ctx: object, random: () => number): Hooks {
  const problems = checkPluginSource(source);
  if (problems.length) throw new Error(problems.join('; '));
  let factory: (ctx: object, math: Math) => unknown;
  try {
    factory = new Function('ctx', 'Math', `"use strict";\n${source}`) as typeof factory;
  } catch (e) {
    throw new Error(`syntax error: ${(e as Error).message}`);
  }
  const out = factory.call(undefined, ctx, seededMath(random));
  if (!out || typeof out !== 'object') throw new Error('the plugin must `return { onInit() {...}, onStep(dt) {...}, ... }`');
  const hooks: Hooks = {};
  for (const k of Object.keys(out)) {
    const fn = (out as Record<string, unknown>)[k];
    if (!(HOOK_NAMES as readonly string[]).includes(k)) throw new Error(`unknown hook \`${k}\` (allowed: ${HOOK_NAMES.join(', ')})`);
    if (typeof fn !== 'function') throw new Error(`hook \`${k}\` is not a function`);
    hooks[k as HookName] = fn as (...args: unknown[]) => void;
  }
  return hooks;
}
