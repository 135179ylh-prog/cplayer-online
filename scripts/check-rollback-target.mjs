import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'acorn';
import { parse as parseHtml } from 'parse5';
import { PAGE_DIRECTORIES, PAGE_FILES } from './build-pages-artifact.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const UNKNOWN = Symbol('unknown constant');
const MISSING = Symbol('missing destructured value');
const GLOBAL_OBJECT_REFERENCE = Symbol('global object reference');
const DOCUMENT_REFERENCE = Symbol('document reference');
const LOCATION_REFERENCE = Symbol('location reference');
const INDEXED_DB_REFERENCE = Symbol('IndexedDB reference');
const CALLABLE_REFERENCE = Symbol('callable reference');
const EVAL_REFERENCE = Symbol('eval reference');
const FUNCTION_REFERENCE = Symbol('Function reference');
const SET_TIMEOUT_REFERENCE = Symbol('setTimeout reference');
const SET_INTERVAL_REFERENCE = Symbol('setInterval reference');
const DOCUMENT_WRITE_REFERENCE = Symbol('document.write reference');
const DOCUMENT_WRITELN_REFERENCE = Symbol('document.writeln reference');
const IMPORT_SCRIPTS_REFERENCE = Symbol('importScripts reference');
const WINDOW_OPEN_REFERENCE = Symbol('window.open reference');
const LOCATION_ASSIGN_REFERENCE = Symbol('location.assign reference');
const LOCATION_REPLACE_REFERENCE = Symbol('location.replace reference');
const DYNAMIC_CAPABILITY_REFERENCE = Symbol('dynamic code capability');
const CLASSIC_SCRIPT_TYPES = new Set([
    '', 'application/ecmascript', 'application/javascript', 'application/x-javascript',
    'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1',
    'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5',
    'text/jscript', 'text/livescript'
]);
const DYNAMIC_CAPABILITY_PROPERTIES = new Set([
    'indexedDB', 'eval', 'Function', 'setTimeout', 'setInterval', 'importScripts',
    'write', 'writeln', 'open', 'location'
]);

function scriptMode(rawType) {
    const type = String(rawType || '').trim().toLowerCase().split(';', 1)[0].trim();
    if (type === 'module') return 'module';
    return CLASSIC_SCRIPT_TYPES.has(type) ? 'script' : null;
}

function javascriptUrlSource(value) {
    const normalized = String(value)
        .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
        .replace(/[\t\n\r]/g, '');
    const scheme = /^javascript:/i.exec(normalized);
    return scheme ? normalized.slice(scheme[0].length) : null;
}

function collectHtmlScripts(source) {
    const records = [];
    const childDocuments = [];
    let baseHref = null;
    const visit = (node) => {
        const attributes = node.attrs || [];
        attributes.forEach((attribute) => {
            const value = String(attribute.value || '');
            const trimmedValue = value.trim();
            if (attribute.name === 'srcdoc' && trimmedValue) {
                const nestedHtml = collectHtmlScripts(value);
                childDocuments.push(nestedHtml);
            } else if (/^on[a-z][a-z0-9_-]*$/i.test(attribute.name) && trimmedValue) {
                records.push({ mode: 'handler', body: value });
            } else if (['href', 'src', 'action', 'formaction'].includes(attribute.name) ||
                (attribute.name === 'data' && node.tagName === 'object')) {
                const body = javascriptUrlSource(value);
                if (body != null) records.push({ mode: 'handler', body });
            }
        });
        if (node.tagName === 'base' && baseHref == null) {
            const href = attributes.find((attribute) => attribute.name === 'href')?.value;
            if (href != null) baseHref = href;
        }
        if (node.tagName === 'script') {
            const scriptAttributes = new Map(attributes.map((attribute) => [attribute.name, attribute.value]));
            const mode = scriptMode(scriptAttributes.get('type'));
            if (mode) {
                const src = scriptAttributes.get('src') || null;
                records.push({
                    mode,
                    src,
                    execution: mode === 'script' && src && scriptAttributes.has('async')
                        ? 'async'
                        : mode === 'script' && src && scriptAttributes.has('defer')
                            ? 'defer'
                            : 'blocking',
                    body: (node.childNodes || [])
                        .filter((child) => child.nodeName === '#text')
                        .map((child) => child.value)
                        .join('')
                });
            }
            return;
        }
        (node.childNodes || []).forEach(visit);
    };
    visit(parseHtml(source));
    return { records, childDocuments, baseHref };
}

function parseJavaScript(source, preferredSourceType = null) {
    const errors = [];
    const sourceTypes = preferredSourceType ? [preferredSourceType] : ['module', 'script'];
    for (const sourceType of sourceTypes) {
        try {
            return parse(source, { ecmaVersion: 'latest', sourceType, allowHashBang: true });
        } catch (error) {
            errors.push(error);
        }
    }
    throw new Error(`Rollback target JavaScript could not be parsed: ${errors[0].message}`);
}

function createScope(parent = null, options = {}) {
    return {
        parent,
        bindings: new Map(),
        bindingKinds: new Map(),
        functionBoundary: Boolean(options.functionBoundary),
        varBoundary: Boolean(options.varBoundary),
        globalObjectScope: Boolean(options.globalObjectScope),
        unstableBindings: options.unstableBindings || new Set(),
        uncertain: Boolean(options.uncertain)
    };
}

function findBinding(scope, name) {
    let crossedFunction = false;
    for (let current = scope; current; current = current.parent) {
        if (current.bindings.has(name)) {
            const kind = current.bindingKinds.get(name) || 'unknown';
            const immutable = kind === 'const' || kind === 'function' || kind === 'import' ||
                kind === 'function-expression-name';
            return {
                found: true,
                value: crossedFunction && !immutable ? UNKNOWN : current.bindings.get(name),
                kind,
                scope: current
            };
        }
        if (current.functionBoundary) crossedFunction = true;
    }
    return { found: false, value: UNKNOWN, kind: null, scope: null };
}

function nearestVarScope(scope) {
    for (let current = scope; current; current = current.parent) {
        if (current.functionBoundary || current.varBoundary || !current.parent) return current;
    }
    return scope;
}

function crossesUncertainScope(scope, target) {
    for (let current = scope; current && current !== target; current = current.parent) {
        if (current.uncertain) return true;
    }
    return false;
}

function findGlobalObjectVarBinding(scope, name) {
    for (let current = scope; current; current = current.parent) {
        if (!current.globalObjectScope) continue;
        if (current.bindings.has(name) &&
            ['var', 'function'].includes(current.bindingKinds.get(name))) {
            return { found: true, scope: current };
        }
        return { found: false, scope: current };
    }
    return { found: false, scope: null };
}

function bindingWriteIsUncertain(origin, target) {
    for (let current = origin; current && current !== target; current = current.parent) {
        if (current.functionBoundary || current.uncertain) return true;
    }
    return false;
}

function updateResolvedBinding(origin, target, name, value) {
    target.bindings.set(
        name,
        target.unstableBindings.has(name) || bindingWriteIsUncertain(origin, target)
            ? UNKNOWN
            : value
    );
}

function noteUncertainGlobalBindingWrite(scope, state, name) {
    const binding = findBinding(scope, name);
    const immutable = binding.kind === 'const' || binding.kind === 'import' ||
        binding.kind === 'function-expression-name';
    if (binding.found && binding.scope.globalObjectScope && !immutable &&
        bindingWriteIsUncertain(scope, binding.scope)) {
        state.uncertainGlobalBindingWrites.add(name);
    } else if (!binding.found && bindingWriteIsUncertain(scope, null)) {
        state.uncertainGlobalBindingWrites.add(name);
    }
}

function patternBindingNames(pattern, names = []) {
    if (!pattern) return names;
    if (pattern.type === 'Identifier') names.push(pattern.name);
    else if (pattern.type === 'RestElement') patternBindingNames(pattern.argument, names);
    else if (pattern.type === 'AssignmentPattern') patternBindingNames(pattern.left, names);
    else if (pattern.type === 'ArrayPattern') {
        pattern.elements.forEach((element) => patternBindingNames(element, names));
    } else if (pattern.type === 'ObjectPattern') {
        pattern.properties.forEach((property) => patternBindingNames(
            property.type === 'RestElement' ? property.argument : property.value,
            names
        ));
    }
    return names;
}

function updateBinding(scope, name, value) {
    let uncertain = false;
    for (let current = scope; current; current = current.parent) {
        if (current.bindings.has(name)) {
            current.bindings.set(
                name,
                uncertain || current.unstableBindings.has(name) ? UNKNOWN : value
            );
            return;
        }
        if (current.functionBoundary || current.uncertain) uncertain = true;
    }
}

function invalidatePatternBindings(pattern, scope, state) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
        noteUncertainGlobalBindingWrite(scope, state, pattern.name);
        updateBinding(scope, pattern.name, UNKNOWN);
        return;
    }
    if (pattern.type === 'MemberExpression') {
        const globalProperty = globalObjectPropertyName(pattern, scope);
        if (globalProperty) {
            updateGlobalObjectBinding(scope, state, globalProperty, UNKNOWN);
        } else if (evaluateConstant(pattern.object, scope) === GLOBAL_OBJECT_REFERENCE) {
            state.unsupported.add('dynamic global property write');
        }
        return;
    }
    if (pattern.type === 'RestElement') {
        invalidatePatternBindings(pattern.argument, scope, state);
        return;
    }
    if (pattern.type === 'AssignmentPattern') {
        invalidatePatternBindings(pattern.left, scope, state);
        return;
    }
    if (pattern.type === 'ArrayPattern') {
        pattern.elements.forEach((element) => invalidatePatternBindings(element, scope, state));
        return;
    }
    if (pattern.type === 'ObjectPattern') {
        pattern.properties.forEach((property) => {
            invalidatePatternBindings(
                property.type === 'RestElement' ? property.argument : property.value,
                scope,
                state
            );
        });
    }
}

function globalPropertyReference(name) {
    if (name === 'indexedDB') return INDEXED_DB_REFERENCE;
    if (name === 'globalThis' || name === 'window' || name === 'self') return GLOBAL_OBJECT_REFERENCE;
    if (name === 'document') return DOCUMENT_REFERENCE;
    if (name === 'location') return LOCATION_REFERENCE;
    if (name === 'eval') return EVAL_REFERENCE;
    if (name === 'Function') return FUNCTION_REFERENCE;
    if (name === 'setTimeout') return SET_TIMEOUT_REFERENCE;
    if (name === 'setInterval') return SET_INTERVAL_REFERENCE;
    if (name === 'importScripts') return IMPORT_SCRIPTS_REFERENCE;
    if (name === 'open') return WINDOW_OPEN_REFERENCE;
    return UNKNOWN;
}

function documentPropertyReference(name) {
    if (name === 'write') return DOCUMENT_WRITE_REFERENCE;
    if (name === 'writeln') return DOCUMENT_WRITELN_REFERENCE;
    if (name === 'location') return LOCATION_REFERENCE;
    return UNKNOWN;
}

function locationPropertyReference(name) {
    if (name === 'assign') return LOCATION_ASSIGN_REFERENCE;
    if (name === 'replace') return LOCATION_REPLACE_REFERENCE;
    return UNKNOWN;
}

function propertyReferenceForOwner(owner, name) {
    if (owner === GLOBAL_OBJECT_REFERENCE) return globalPropertyReference(name);
    if (owner === DOCUMENT_REFERENCE) return documentPropertyReference(name);
    if (owner === LOCATION_REFERENCE) return locationPropertyReference(name);
    if (owner === CALLABLE_REFERENCE && name === 'constructor') return FUNCTION_REFERENCE;
    if (owner === DYNAMIC_CAPABILITY_REFERENCE) return DYNAMIC_CAPABILITY_REFERENCE;
    return UNKNOWN;
}

function evaluatePrimitiveConstant(node) {
    if (!node) return UNKNOWN;
    if (node.type === 'Literal') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis[0].value.cooked;
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
        const left = evaluatePrimitiveConstant(node.left);
        const right = evaluatePrimitiveConstant(node.right);
        if (left !== UNKNOWN && right !== UNKNOWN &&
            (typeof left === 'string' || typeof right === 'string')) {
            return String(left) + String(right);
        }
    }
    if (node.type === 'UnaryExpression' && (node.operator === '+' || node.operator === '-')) {
        const value = evaluatePrimitiveConstant(node.argument);
        return typeof value === 'number' ? (node.operator === '-' ? -value : value) : UNKNOWN;
    }
    return UNKNOWN;
}

function evaluateConstant(node, scope) {
    if (!node) return UNKNOWN;
    const primitive = evaluatePrimitiveConstant(node);
    if (primitive !== UNKNOWN) return primitive;
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
        return CALLABLE_REFERENCE;
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
        return evaluateConstant(node.right, scope);
    }
    if (node.type === 'Identifier') {
        const binding = findBinding(scope, node.name);
        if (binding.found) return binding.value;
        return globalPropertyReference(node.name);
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' &&
        node.callee.object?.type === 'Identifier' && node.callee.object.name === 'Reflect' &&
        !findBinding(scope, 'Reflect').found && staticPropertyName(node.callee, scope) === 'get') {
        const owner = evaluateConstant(node.arguments[0], scope);
        const property = evaluateConstant(node.arguments[1], scope);
        if ([GLOBAL_OBJECT_REFERENCE, DOCUMENT_REFERENCE, LOCATION_REFERENCE,
            CALLABLE_REFERENCE, DYNAMIC_CAPABILITY_REFERENCE].includes(owner)) {
            return typeof property === 'string'
                ? propertyReferenceForOwner(owner, property)
                : DYNAMIC_CAPABILITY_REFERENCE;
        }
    }
    if (node.type === 'MemberExpression') {
        const owner = evaluateConstant(node.object, scope);
        const property = staticPropertyName(node, scope);
        if ([GLOBAL_OBJECT_REFERENCE, DOCUMENT_REFERENCE, LOCATION_REFERENCE,
            CALLABLE_REFERENCE, DYNAMIC_CAPABILITY_REFERENCE].includes(owner)) {
            return typeof property === 'string'
                ? propertyReferenceForOwner(owner, property)
                : DYNAMIC_CAPABILITY_REFERENCE;
        }
    }
    return UNKNOWN;
}

function walkPatternExpressions(pattern, scope, walk) {
    if (!pattern) return;
    if (pattern.type === 'MemberExpression') {
        walk(pattern.object, scope);
        if (pattern.computed) walk(pattern.property, scope);
        return;
    }
    if (pattern.type === 'AssignmentPattern') {
        walk(pattern.right, scope);
        walkPatternExpressions(pattern.left, scope, walk);
        return;
    }
    if (pattern.type === 'RestElement') {
        walkPatternExpressions(pattern.argument, scope, walk);
        return;
    }
    if (pattern.type === 'ArrayPattern') {
        pattern.elements.forEach((element) => walkPatternExpressions(element, scope, walk));
        return;
    }
    if (pattern.type === 'ObjectPattern') {
        pattern.properties.forEach((property) => {
            if (property.computed || DYNAMIC_CAPABILITY_PROPERTIES.has(staticObjectPropertyName(property))) {
                walk(property.key, scope);
            }
            walkPatternExpressions(property.type === 'RestElement' ? property.argument : property.value, scope, walk);
        });
    }
}

function declarePattern(pattern, scope, value = UNKNOWN, kind = null) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
        scope.bindings.set(
            pattern.name,
            scope.unstableBindings.has(pattern.name) ? UNKNOWN : value
        );
        if (kind) scope.bindingKinds.set(pattern.name, kind);
        return;
    }
    if (pattern.type === 'RestElement') {
        declarePattern(pattern.argument, scope, value, kind);
        return;
    }
    if (pattern.type === 'AssignmentPattern') {
        declarePattern(pattern.left, scope, value, kind);
        return;
    }
    if (pattern.type === 'ArrayPattern') {
        pattern.elements.forEach((element) => declarePattern(element, scope, UNKNOWN, kind));
        return;
    }
    if (pattern.type === 'ObjectPattern') {
        if ([GLOBAL_OBJECT_REFERENCE, DOCUMENT_REFERENCE, LOCATION_REFERENCE,
            DYNAMIC_CAPABILITY_REFERENCE].includes(value)) {
            pattern.properties.forEach((property) => {
                if (property.type === 'RestElement') {
                    declarePattern(property.argument, scope, DYNAMIC_CAPABILITY_REFERENCE, kind);
                    return;
                }
                const key = staticObjectPropertyName(property, scope);
                const childValue = typeof key === 'string'
                    ? propertyReferenceForOwner(value, key)
                    : DYNAMIC_CAPABILITY_REFERENCE;
                declarePattern(property.value, scope, childValue, kind);
            });
            return;
        }
        pattern.properties.forEach((property) => {
            declarePattern(
                property.type === 'RestElement' ? property.argument : property.value,
                scope,
                UNKNOWN,
                kind
            );
        });
    }
}

function declarePatternWithInitializer(pattern, initializer, scope, kind = null, evaluationScope = scope) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
        scope.bindings.set(
            pattern.name,
            scope.unstableBindings.has(pattern.name)
                ? UNKNOWN
                : initializer && initializer !== MISSING
                    ? evaluateConstant(initializer, evaluationScope)
                    : UNKNOWN
        );
        if (kind) scope.bindingKinds.set(pattern.name, kind);
        return;
    }
    if (pattern.type === 'AssignmentPattern') {
        if (initializer === MISSING) {
            declarePattern(pattern.left, scope, UNKNOWN, kind);
        } else if (!initializer || evaluateConstant(initializer, evaluationScope) === UNKNOWN) {
            declarePattern(pattern.left, scope, UNKNOWN, kind);
        } else {
            declarePatternWithInitializer(pattern.left, initializer, scope, kind, evaluationScope);
        }
        return;
    }
    if (pattern.type === 'ArrayPattern') {
        const values = initializer?.type === 'ArrayExpression' &&
            initializer.elements.every((element) => element?.type !== 'SpreadElement')
            ? initializer.elements
            : null;
        pattern.elements.forEach((element, index) => {
            declarePatternWithInitializer(
                element,
                values ? (values[index] || MISSING) : null,
                scope,
                kind,
                evaluationScope
            );
        });
        return;
    }
    if (pattern.type === 'ObjectPattern') {
        const owner = evaluateConstant(initializer, evaluationScope);
        if ([GLOBAL_OBJECT_REFERENCE, DOCUMENT_REFERENCE, LOCATION_REFERENCE,
            DYNAMIC_CAPABILITY_REFERENCE].includes(owner)) {
            declarePattern(pattern, scope, owner, kind);
            return;
        }
        const properties = initializer?.type === 'ObjectExpression' &&
            initializer.properties.every((property) =>
                property.type === 'Property' &&
                staticObjectPropertyName(property, evaluationScope) != null &&
                staticObjectPropertyName(property, evaluationScope) !== '__proto__'
            )
            ? initializer.properties
            : null;
        pattern.properties.forEach((property) => {
            if (property.type === 'RestElement') {
                declarePattern(property.argument, scope, UNKNOWN, kind);
                return;
            }
            const key = staticObjectPropertyName(property, evaluationScope);
            const matches = properties
                ? properties.filter((candidate) =>
                    staticObjectPropertyName(candidate, evaluationScope) === key)
                : null;
            const source = matches
                ? (matches.at(-1)?.value || MISSING)
                : null;
            declarePatternWithInitializer(property.value, source, scope, kind, evaluationScope);
        });
    }
}

function staticPropertyName(member, scope = null) {
    if (!member?.computed && member?.property?.type === 'Identifier') return member.property.name;
    if (member?.computed) {
        return scope ? evaluateConstant(member.property, scope) : evaluatePrimitiveConstant(member.property);
    }
    return null;
}

function staticObjectPropertyName(property, scope = null) {
    if (!property?.computed && property?.key?.type === 'Identifier') return property.key.name;
    if (property?.computed) {
        return scope ? evaluateConstant(property.key, scope) : evaluatePrimitiveConstant(property.key);
    }
    if (property?.key?.type === 'Literal') return property.key.value;
    return null;
}

function isGlobalIndexedDbReference(node, scope) {
    return evaluateConstant(node, scope) === INDEXED_DB_REFERENCE;
}

function isIndexedDbOpenCall(node, scope) {
    if (node?.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') return false;
    return staticPropertyName(node.callee, scope) === 'open' &&
        isGlobalIndexedDbReference(node.callee.object, scope);
}

function isPotentialIndexedDbOpenCall(node, scope) {
    if (node?.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') return false;
    if (staticPropertyName(node.callee, scope) !== 'open') return false;
    if (isGlobalIndexedDbReference(node.callee.object, scope)) return true;
    if (node.callee.object?.type === 'MemberExpression' &&
        staticPropertyName(node.callee.object, scope) === 'indexedDB') return true;
    const owner = evaluateConstant(node.callee.object, scope);
    if (owner === GLOBAL_OBJECT_REFERENCE) return false;
    const databaseName = evaluateConstant(node.arguments[0], scope);
    if (databaseName === 'CPlayer5DB') return true;
    if (databaseName !== UNKNOWN) return false;
    if (node.arguments.some((argument) => argument?.type === 'SpreadElement')) return true;
    return node.arguments.length >= 2;
}

function globalCodeEntryName(node, scope) {
    const value = evaluateConstant(node, scope);
    if (value === EVAL_REFERENCE) return 'eval';
    if (value === FUNCTION_REFERENCE) return 'Function';
    if (value === SET_TIMEOUT_REFERENCE) return 'setTimeout';
    if (value === SET_INTERVAL_REFERENCE) return 'setInterval';
    if (value === IMPORT_SCRIPTS_REFERENCE) return 'importScripts';
    if (value === WINDOW_OPEN_REFERENCE) return 'window.open';
    if (value === LOCATION_ASSIGN_REFERENCE) return 'location.assign';
    if (value === LOCATION_REPLACE_REFERENCE) return 'location.replace';
    if (value === DYNAMIC_CAPABILITY_REFERENCE) return 'dynamic capability';
    return null;
}

function documentCodeEntryName(node, scope) {
    const value = evaluateConstant(node, scope);
    if (value === DOCUMENT_WRITE_REFERENCE) return 'document.write';
    if (value === DOCUMENT_WRITELN_REFERENCE) return 'document.writeln';
    return null;
}

function isJavaScriptUrl(node, scope) {
    const value = evaluateConstant(node, scope);
    return typeof value === 'string' && javascriptUrlSource(value) != null;
}

function isLocationNavigationTarget(node, scope) {
    if (evaluateConstant(node, scope) === LOCATION_REFERENCE) return true;
    return node?.type === 'MemberExpression' &&
        evaluateConstant(node.object, scope) === LOCATION_REFERENCE &&
        ['href', 'protocol'].includes(staticPropertyName(node, scope));
}

function globalObjectPropertyName(node, scope) {
    if (node?.type !== 'MemberExpression' ||
        evaluateConstant(node.object, scope) !== GLOBAL_OBJECT_REFERENCE) {
        return null;
    }
    const name = staticPropertyName(node, scope);
    return typeof name === 'string' ? name : null;
}

function updateGlobalObjectBinding(scope, state, name, value) {
    const binding = findGlobalObjectVarBinding(scope, name);
    const uncertain = binding.found
        ? bindingWriteIsUncertain(scope, binding.scope)
        : bindingWriteIsUncertain(scope, null);
    if (uncertain) state.uncertainGlobalPropertyWrites.add(name);
    if (binding.found) updateResolvedBinding(scope, binding.scope, name, value);
}

function isLocalModuleSpecifier(node, scope) {
    const value = evaluateConstant(node, scope);
    return typeof value === 'string' &&
        (value.startsWith('./') || value.startsWith('../') || value.startsWith('/'));
}

function globalObjectMutationEntryName(node, scope) {
    if (node?.callee?.type !== 'MemberExpression' ||
        node.callee.object?.type !== 'Identifier' ||
        findBinding(scope, node.callee.object.name).found ||
        evaluateConstant(node.arguments[0], scope) !== GLOBAL_OBJECT_REFERENCE) {
        return null;
    }
    const method = staticPropertyName(node.callee, scope);
    const owner = node.callee.object.name;
    const supportedMethods = owner === 'Reflect'
        ? new Set(['set', 'defineProperty', 'deleteProperty'])
        : owner === 'Object'
            ? new Set(['assign', 'defineProperty', 'defineProperties'])
            : null;
    return supportedMethods?.has(method) ? `${owner}.${method}` : null;
}

function inspectProgram(program, state, rootScope = createScope()) {
    const promiseExecutors = new WeakSet();

    const getVariableDeclaration = (statement) => {
        if (statement.type === 'VariableDeclaration') return statement;
        if (statement.type === 'ExportNamedDeclaration' &&
            statement.declaration?.type === 'VariableDeclaration') {
            return statement.declaration;
        }
        return null;
    };

    const predeclareConstants = (statements, scope) => {
        const variableDeclarations = statements
            .map(getVariableDeclaration)
            .filter(Boolean);
        const constants = variableDeclarations
            .filter((declaration) => declaration.kind === 'const')
            .flatMap((declaration) => declaration.declarations);
        variableDeclarations.forEach((declaration) => {
            const targetScope = declaration.kind === 'var' ? nearestVarScope(scope) : scope;
            declaration.declarations.forEach((item) => {
                declarePattern(item.id, targetScope, UNKNOWN, declaration.kind);
            });
        });
        statements
            .filter((statement) => statement.type === 'ImportDeclaration')
            .flatMap((statement) => statement.specifiers)
            .forEach((specifier) => declarePattern(specifier.local, scope, UNKNOWN, 'import'));
        statements
            .filter((statement) => statement.type === 'FunctionDeclaration' && statement.id)
            .forEach((statement) =>
                declarePattern(statement.id, scope, CALLABLE_REFERENCE, 'function')
            );
        for (let pass = 0; pass <= constants.length; pass += 1) {
            constants.forEach((declaration) => {
                declarePatternWithInitializer(declaration.id, declaration.init, scope, 'const');
            });
        }
    };

    const walk = (node, scope) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'Program') {
            predeclareConstants(node.body, scope);
            node.body.forEach((child) => walk(child, scope));
            return;
        }
        if (node.type === 'BlockStatement') {
            const blockScope = createScope(scope);
            predeclareConstants(node.body, blockScope);
            node.body.forEach((child) => walk(child, blockScope));
            return;
        }
        if (node.type === 'StaticBlock') {
            const staticScope = createScope(scope, { varBoundary: true });
            predeclareConstants(node.body, staticScope);
            node.body.forEach((child) => walk(child, staticScope));
            return;
        }
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
            node.type === 'ArrowFunctionExpression') {
            if (node.type === 'FunctionDeclaration' && node.id) {
                declarePattern(node.id, scope, CALLABLE_REFERENCE, 'function');
            }
            const functionScope = createScope(scope, { functionBoundary: true });
            if (node.type === 'FunctionExpression' && node.id) {
                declarePattern(
                    node.id,
                    functionScope,
                    CALLABLE_REFERENCE,
                    'function-expression-name'
                );
            }
            node.params.forEach((parameter, index) => {
                walkPatternExpressions(parameter, functionScope, walk);
                declarePattern(
                    parameter,
                    functionScope,
                    promiseExecutors.has(node) && index < 2 ? CALLABLE_REFERENCE : UNKNOWN,
                    'param'
                );
            });
            walk(node.body, functionScope);
            return;
        }
        if (node.type === 'CatchClause') {
            const catchScope = createScope(scope);
            walkPatternExpressions(node.param, catchScope, walk);
            declarePattern(node.param, catchScope, UNKNOWN, 'catch');
            walk(node.body, catchScope);
            return;
        }
        if (node.type === 'VariableDeclaration') {
            for (const declaration of node.declarations) {
                const value = evaluateConstant(declaration.init, scope);
                const isSimpleIndexedDbAlias = declaration.id.type === 'Identifier' &&
                    value === INDEXED_DB_REFERENCE;
                if (!isSimpleIndexedDbAlias) walk(declaration.init, scope);
                walkPatternExpressions(declaration.id, scope, walk);
                const targetScope = node.kind === 'var' ? nearestVarScope(scope) : scope;
                if (declaration.init && targetScope.globalObjectScope &&
                    bindingWriteIsUncertain(scope, targetScope)) {
                    patternBindingNames(declaration.id).forEach((name) => {
                        state.uncertainGlobalBindingWrites.add(name);
                    });
                }
                if (crossesUncertainScope(scope, targetScope)) {
                    declarePattern(declaration.id, targetScope, UNKNOWN, node.kind);
                } else {
                    declarePatternWithInitializer(
                        declaration.id,
                        declaration.init,
                        targetScope,
                        node.kind,
                        scope
                    );
                }
            }
            return;
        }
        if (node.type === 'AssignmentExpression') {
            if (isLocationNavigationTarget(node.left, scope) &&
                (isJavaScriptUrl(node.right, scope) || evaluateConstant(node.right, scope) === UNKNOWN)) {
                state.unsupported.add('dynamic location navigation');
            }
            const sourceOwner = evaluateConstant(node.right, scope);
            if ((node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') &&
                [GLOBAL_OBJECT_REFERENCE, DOCUMENT_REFERENCE, LOCATION_REFERENCE,
                    DYNAMIC_CAPABILITY_REFERENCE].includes(sourceOwner)) {
                state.unsupported.add('dynamic capability destructuring assignment');
            }
            walk(node.right, scope);
            const globalProperty = globalObjectPropertyName(node.left, scope);
            if (globalProperty) {
                updateGlobalObjectBinding(
                    scope,
                    state,
                    globalProperty,
                    node.operator === '=' ? evaluateConstant(node.right, scope) : UNKNOWN
                );
            }
            if (node.left.type === 'Identifier') {
                noteUncertainGlobalBindingWrite(scope, state, node.left.name);
                updateBinding(
                    scope,
                    node.left.name,
                    node.operator === '=' ? evaluateConstant(node.right, scope) : UNKNOWN
                );
            } else if (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') {
                invalidatePatternBindings(node.left, scope, state);
                walkPatternExpressions(node.left, scope, walk);
            } else {
                walk(node.left, scope);
            }
            return;
        }
        if (node.type === 'UpdateExpression') {
            if (node.argument?.type === 'Identifier') {
                noteUncertainGlobalBindingWrite(scope, state, node.argument.name);
                updateBinding(scope, node.argument.name, UNKNOWN);
            } else {
                const globalProperty = globalObjectPropertyName(node.argument, scope);
                if (globalProperty) {
                    updateGlobalObjectBinding(scope, state, globalProperty, UNKNOWN);
                }
                walk(node.argument, scope);
            }
            return;
        }
        if (node.type === 'IfStatement') {
            walk(node.test, scope);
            walk(node.consequent, createScope(scope, { uncertain: true }));
            if (node.alternate) walk(node.alternate, createScope(scope, { uncertain: true }));
            return;
        }
        if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
            const loopScope = createScope(scope, { uncertain: true });
            if (node.type === 'ForStatement') {
                walk(node.init, loopScope);
                walk(node.test, loopScope);
                walk(node.update, loopScope);
            } else {
                walk(node.right, scope);
                if (node.left.type === 'VariableDeclaration') {
                    walk(node.left, loopScope);
                    if (node.left.kind === 'var') {
                        const targetScope = nearestVarScope(loopScope);
                        if (targetScope.globalObjectScope &&
                            bindingWriteIsUncertain(loopScope, targetScope)) {
                            node.left.declarations.forEach((declaration) => {
                                patternBindingNames(declaration.id).forEach((name) => {
                                    state.uncertainGlobalBindingWrites.add(name);
                                });
                            });
                        }
                    }
                } else {
                    invalidatePatternBindings(node.left, scope, state);
                    walkPatternExpressions(node.left, scope, walk);
                }
            }
            walk(node.body, loopScope);
            return;
        }
        if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
            if (node.type === 'WhileStatement') walk(node.test, scope);
            walk(node.body, createScope(scope, { uncertain: true }));
            if (node.type === 'DoWhileStatement') walk(node.test, scope);
            return;
        }
        if (node.type === 'SwitchStatement') {
            const switchScope = createScope(scope, { uncertain: true });
            predeclareConstants(node.cases.flatMap((item) => item.consequent), switchScope);
            walk(node.discriminant, scope);
            node.cases.forEach((item) => {
                walk(item.test, switchScope);
                item.consequent.forEach((child) => walk(child, switchScope));
            });
            return;
        }
        if (node.type === 'ConditionalExpression') {
            walk(node.test, scope);
            walk(node.consequent, createScope(scope, { uncertain: true }));
            walk(node.alternate, createScope(scope, { uncertain: true }));
            return;
        }
        if (node.type === 'LogicalExpression') {
            walk(node.left, scope);
            walk(node.right, createScope(scope, { uncertain: true }));
            return;
        }
        if (node.type === 'TryStatement') {
            walk(node.block, createScope(scope, { uncertain: true }));
            if (node.handler) walk(node.handler, createScope(scope, { uncertain: true }));
            if (node.finalizer) walk(node.finalizer, createScope(scope, { uncertain: true }));
            return;
        }
        if (node.type === 'WithStatement') {
            state.unsupported.add('with statement');
            walk(node.object, scope);
            walk(node.body, createScope(scope, { uncertain: true }));
            return;
        }
        if (node.type === 'NewExpression' && node.callee?.type === 'Identifier' &&
            node.callee.name === 'Promise' && !findBinding(scope, 'Promise').found &&
            (node.arguments[0]?.type === 'FunctionExpression' ||
                node.arguments[0]?.type === 'ArrowFunctionExpression')) {
            promiseExecutors.add(node.arguments[0]);
            node.arguments.forEach((argument) => walk(argument, scope));
            return;
        }
        if (node.type === 'ImportExpression') {
            state.unsupported.add('dynamic import');
            walk(node.source, scope);
            return;
        }
        if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
            node.type === 'ExportNamedDeclaration') && node.source &&
            !isLocalModuleSpecifier(node.source, scope)) {
            state.unsupported.add('external or bare module import');
        }
        if (node.type === 'CallExpression' || node.type === 'NewExpression') {
            const globalMutationEntry = globalObjectMutationEntryName(node, scope);
            if (globalMutationEntry) {
                state.unsupported.add(`${globalMutationEntry} global mutation`);
                node.arguments.forEach((argument) => walk(argument, scope));
                return;
            }
            if (node.callee?.type === 'MemberExpression' &&
                staticPropertyName(node.callee, scope) === 'constructor' &&
                node.arguments.length > 0) {
                state.unsupported.add('constructor code execution');
                node.arguments.forEach((argument) => walk(argument, scope));
                return;
            }
            const entryName = globalCodeEntryName(node.callee, scope);
            if (entryName === 'eval' || entryName === 'Function' ||
                entryName === 'importScripts' || entryName === 'dynamic capability') {
                state.unsupported.add(entryName);
                node.arguments.forEach((argument) => walk(argument, scope));
                return;
            }
            const documentEntry = documentCodeEntryName(node.callee, scope);
            if (documentEntry) {
                state.unsupported.add(documentEntry);
                node.arguments.forEach((argument) => walk(argument, scope));
                return;
            }
            if (entryName === 'setTimeout' || entryName === 'setInterval') {
                if (evaluateConstant(node.arguments[0], scope) !== CALLABLE_REFERENCE) {
                    state.unsupported.add(`unresolved ${entryName} callback`);
                }
                node.arguments.forEach((argument) => walk(argument, scope));
                return;
            }
            if (entryName === 'window.open' || entryName === 'location.assign' ||
                entryName === 'location.replace') {
                const url = evaluateConstant(node.arguments[0], scope);
                if (typeof url !== 'string' || isJavaScriptUrl(node.arguments[0], scope)) {
                    state.unsupported.add(`dynamic ${entryName} URL`);
                }
                node.arguments.forEach((argument) => walk(argument, scope));
                return;
            }
        }
        if (isIndexedDbOpenCall(node, scope)) {
            const databaseName = evaluateConstant(node.arguments[0], scope);
            if (databaseName === UNKNOWN) {
                state.unresolved = true;
            } else if (databaseName === 'CPlayer5DB') {
                const version = evaluateConstant(node.arguments[1], scope);
                const versionBinding = node.arguments[1]?.type === 'Identifier'
                    ? findBinding(scope, node.arguments[1].name)
                    : null;
                if (versionBinding?.scope?.globalObjectScope) {
                    state.globalVersionBindings.add(node.arguments[1].name);
                }
                const declaredVersion = findBinding(scope, 'DB_VERSION');
                const usesDeclaredVersion = node.arguments[1]?.type === 'Identifier' &&
                    node.arguments[1].name === 'DB_VERSION';
                if (declaredVersion.found && !usesDeclaredVersion) state.unwired = true;
                if (!Number.isSafeInteger(version) || version < 1) state.unresolved = true;
                else state.versions.push(version);
            }
            node.arguments.forEach((argument) => walk(argument, scope));
            return;
        }
        if (isPotentialIndexedDbOpenCall(node, scope)) {
            state.unresolved = true;
            node.arguments.forEach((argument) => walk(argument, scope));
            return;
        }
        if (node.type === 'Identifier' &&
            evaluateConstant(node, scope) === INDEXED_DB_REFERENCE) {
            state.unresolved = true;
            return;
        }
        if (node.type === 'MemberExpression' &&
            evaluateConstant(node, scope) === INDEXED_DB_REFERENCE) {
            state.unresolved = true;
            return;
        }
        if ((node.type === 'Identifier' || node.type === 'MemberExpression')) {
            const entryName = globalCodeEntryName(node, scope);
            if (entryName === 'eval' || entryName === 'Function' ||
                entryName === 'setTimeout' || entryName === 'setInterval' ||
                entryName === 'importScripts' || entryName === 'window.open' ||
                entryName === 'location.assign' || entryName === 'location.replace' ||
                entryName === 'dynamic capability') {
                state.unsupported.add(`${entryName} capability escape`);
                return;
            }
            const documentEntry = documentCodeEntryName(node, scope);
            if (documentEntry) {
                state.unsupported.add(`${documentEntry} capability escape`);
                return;
            }
        }

        for (const [key, value] of Object.entries(node)) {
            if (key === 'type' || key === 'start' || key === 'end') continue;
            if (node.type === 'MemberExpression' && key === 'property' && !node.computed) continue;
            if ((node.type === 'Property' || node.type === 'MethodDefinition' ||
                node.type === 'PropertyDefinition') && key === 'key' && !node.computed) continue;
            if (Array.isArray(value)) value.forEach((child) => walk(child, scope));
            else if (value?.type) walk(value, scope);
        }
    };

    walk(program, rootScope);
}

function finalizeDatabaseVersion(state) {
    if (state.unsupported.size) {
        throw new Error(
            `Rollback target uses unsupported dynamic code execution: ${[...state.unsupported].join(', ')}.`
        );
    }
    if (state.unwired) {
        throw new Error('Rollback target DB_VERSION is not wired to CPlayer5DB open.');
    }
    if (state.unresolved) {
        throw new Error('Rollback target has an unresolved indexedDB.open call.');
    }
    const versions = [...new Set(state.versions)];
    if (versions.length > 1) {
        throw new Error(`Rollback target has ambiguous CPlayer5DB versions: ${versions.join(', ')}.`);
    }
    return versions[0] ?? null;
}

function createInspectionState() {
    return {
        versions: [],
        unresolved: false,
        unwired: false,
        unsupported: new Set(),
        uncertainGlobalPropertyWrites: new Set(),
        uncertainGlobalBindingWrites: new Set(),
        globalVersionBindings: new Set()
    };
}

function discoverUnstableGlobalBindings(records) {
    const state = createInspectionState();
    const classicRecords = records.filter((record) => record.mode === 'script');
    const globalScope = createScope(null, { globalObjectScope: true });
    classicRecords.filter((record) => record.execution === 'blocking').forEach((record) => {
        inspectProgram(parseJavaScript(record.body, 'script'), state, globalScope);
    });
    classicRecords.filter((record) => record.execution === 'defer').forEach((record) => {
        inspectProgram(parseJavaScript(record.body, 'script'), state, globalScope);
    });
    globalScope.bindings.forEach((value, name) => globalScope.bindings.set(name, UNKNOWN));
    classicRecords.filter((record) => record.execution === 'async').forEach((record) => {
        inspectProgram(
            parseJavaScript(record.body, 'script'),
            state,
            createScope(globalScope, { uncertain: true })
        );
    });
    records
        .filter((record) => record.mode === 'module')
        .forEach((record) => inspectProgram(
            parseJavaScript(record.body, 'module'),
            state,
            createScope(globalScope, { uncertain: true, varBoundary: true })
        ));
    records
        .filter((record) => record.mode === 'handler')
        .forEach((record) => {
            const wrapped = `function __rollback_inline_handler__() {\n${record.body}\n}`;
            inspectProgram(parseJavaScript(wrapped, 'script'), state, globalScope);
        });

    const unstableBindings = new Set();
    for (const name of state.uncertainGlobalBindingWrites) {
        const kind = globalScope.bindingKinds.get(name);
        if (kind && !['const', 'import', 'function-expression-name'].includes(kind)) {
            unstableBindings.add(name);
        }
    }
    for (const name of state.uncertainGlobalPropertyWrites) {
        if (['var', 'function'].includes(globalScope.bindingKinds.get(name))) {
            unstableBindings.add(name);
        }
    }
    return unstableBindings;
}

function inspectScriptRecords(records) {
    const state = createInspectionState();
    const classicRecords = records.filter((record) => record.mode === 'script');
    const classicScope = createScope(null, {
        globalObjectScope: true,
        unstableBindings: discoverUnstableGlobalBindings(records)
    });
    classicRecords.filter((record) => record.execution === 'blocking').forEach((record) => {
        inspectProgram(parseJavaScript(record.body, 'script'), state, classicScope);
    });
    classicRecords.filter((record) => record.execution === 'defer').forEach((record) => {
        inspectProgram(parseJavaScript(record.body, 'script'), state, classicScope);
    });
    classicRecords.filter((record) => record.execution === 'async').forEach((record) => {
        inspectProgram(
            parseJavaScript(record.body, 'script'),
            state,
            createScope(classicScope, { uncertain: true })
        );
    });
    records
        .filter((record) => record.mode === 'module')
        .forEach((record) => inspectProgram(
            parseJavaScript(record.body, 'module'),
            state,
            createScope(classicScope, { uncertain: true, varBoundary: true })
        ));
    records
        .filter((record) => record.mode === 'auto')
        .forEach((record) => inspectProgram(parseJavaScript(record.body), state));
    records
        .filter((record) => record.mode === 'handler')
        .forEach((record) => {
            const wrapped = `function __rollback_inline_handler__() {\n${record.body}\n}`;
            inspectProgram(parseJavaScript(wrapped, 'script'), state, classicScope);
        });
    for (const name of state.uncertainGlobalPropertyWrites) {
        if (state.globalVersionBindings.has(name) &&
            ['var', 'function'].includes(classicScope.bindingKinds.get(name))) {
            state.unresolved = true;
        }
    }
    for (const name of state.uncertainGlobalBindingWrites) {
        if (state.globalVersionBindings.has(name)) state.unresolved = true;
    }
    return finalizeDatabaseVersion(state);
}

function inspectHtmlDocument(html, options) {
    if (html.baseHref != null) {
        throw new Error(`Rollback target uses <base href>, which is not supported by the version preflight: ${html.baseHref}`);
    }
    for (const record of html.records) {
        if (record.src) {
            if (typeof options.loadScript !== 'function') {
                throw new Error(`Rollback target has an external script that cannot be inspected: ${record.src}`);
            }
            record.body = options.loadScript(record.src);
        }
    }
    return mergeDatabaseVersions([
        inspectScriptRecords(html.records),
        ...html.childDocuments.map((child) => inspectHtmlDocument(child, options))
    ]);
}

export function extractDatabaseVersion(source, options = {}) {
    if (typeof source !== 'string') return null;
    const sourceKind = options.sourceKind || 'javascript';
    if (sourceKind !== 'javascript' && sourceKind !== 'html') {
        throw new Error(`Unsupported rollback source kind: ${sourceKind}`);
    }
    if (sourceKind === 'javascript') {
        const executionMode = options.executionMode || 'auto';
        if (!['auto', 'script', 'module'].includes(executionMode)) {
            throw new Error(`Unsupported rollback JavaScript execution mode: ${executionMode}`);
        }
        return inspectScriptRecords([{
            mode: executionMode,
            execution: 'blocking',
            body: source
        }]);
    }

    return inspectHtmlDocument(collectHtmlScripts(source), options);
}

export function assertRollbackVersion(currentVersion, targetVersion) {
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
        throw new Error('Current CPlayer5DB version could not be determined.');
    }
    if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) {
        throw new Error('Rollback target CPlayer5DB version could not be determined.');
    }
    if (targetVersion < currentVersion) {
        throw new Error(
            `Unsafe rollback: target opens CPlayer5DB v${targetVersion}, but user data may already be v${currentVersion}. ` +
            `Create a forward revert that keeps DB_VERSION >= ${currentVersion}.`
        );
    }
    return { currentVersion, targetVersion };
}

function runGit(args, cwd = ROOT) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
}

function normalizeLocalScriptPath(value, documentPath = 'index.html') {
    let url;
    try {
        const normalizedDocumentPath = posix.normalize(
            String(documentPath).replace(/\\/g, '/').replace(/^\/+/, '')
        );
        const documentDirectory = posix.dirname(`/${normalizedDocumentPath}`);
        const documentBasePath = documentDirectory === '/' ? '/' : `${documentDirectory}/`;
        url = new URL(value, `https://cplayer.invalid${documentBasePath}`);
    } catch (error) {
        throw new Error(`Rollback target has an invalid script URL: ${value}`);
    }
    if (url.origin !== 'https://cplayer.invalid') {
        throw new Error(`Rollback target uses an external script that cannot be inspected: ${value}`);
    }
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(url.pathname);
    } catch (error) {
        throw new Error(`Rollback target has an invalid script URL: ${value}`);
    }
    if (decodedPath.includes('\\')) {
        throw new Error(`Rollback target script path escapes the repository: ${value}`);
    }
    const path = posix.normalize(decodedPath.replace(/^\/+/, ''));
    if (!path || path === '.' || path.startsWith('../') || path.includes('/../')) {
        throw new Error(`Rollback target script path escapes the repository: ${value}`);
    }
    return path;
}

function mergeDatabaseVersions(values) {
    const versions = [...new Set(values.filter((version) => version != null))];
    if (versions.length > 1) {
        throw new Error(`Rollback target has ambiguous CPlayer5DB versions: ${versions.join(', ')}.`);
    }
    return versions[0] ?? null;
}

function extractDeployableJavaScriptVersion(source, path) {
    const modes = /\.mjs$/i.test(path) ? ['module'] : ['script', 'module'];
    const versions = [];
    const parseErrors = [];
    for (const executionMode of modes) {
        try {
            versions.push(extractDatabaseVersion(source, {
                sourceKind: 'javascript',
                executionMode
            }));
        } catch (error) {
            if (/JavaScript could not be parsed/.test(error.message)) {
                parseErrors.push(error);
                continue;
            }
            throw new Error(`${path}: ${error.message}`);
        }
    }
    if (!versions.length) throw new Error(`${path}: ${parseErrors[0].message}`);
    return mergeDatabaseVersions(versions);
}

function isDeployableArtifactPath(path) {
    return PAGE_FILES.includes(path) ||
        PAGE_DIRECTORIES.some((directory) => path.startsWith(`${directory}/`));
}

function listCurrentDeployablePaths(root) {
    const paths = [];
    const visit = (directory, prefix) => {
        if (!existsSync(directory)) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const relativePath = `${prefix}/${entry.name}`;
            const absolutePath = resolve(directory, entry.name);
            if (entry.isDirectory()) visit(absolutePath, relativePath);
            else if (entry.isFile()) paths.push(relativePath);
        }
    };
    PAGE_DIRECTORIES.forEach((directory) => {
        visit(resolve(root, directory), directory);
    });
    for (const path of PAGE_FILES) {
        if (existsSync(resolve(root, path))) paths.push(path);
    }
    return [...new Set(paths)].sort();
}

function isDeployableRuntimePath(path) {
    return /\.(?:js|mjs)$/i.test(path) && isDeployableArtifactPath(path);
}

export function readCurrentDatabaseVersion(root = ROOT) {
    const deployablePaths = listCurrentDeployablePaths(root);
    if (!deployablePaths.includes('index.html')) {
        throw new Error('Current tree does not expose index.html.');
    }
    const loadedScripts = new Set();
    const versions = [];
    const htmlPaths = deployablePaths.filter((path) => /\.html$/i.test(path));
    for (const htmlPath of htmlPaths) {
        const loadScript = (src) => {
            const path = normalizeLocalScriptPath(src, htmlPath);
            if (!isDeployableArtifactPath(path)) {
                throw new Error(`Current tree script is outside the Pages artifact: ${path}.`);
            }
            loadedScripts.add(path);
            const absolutePath = resolve(root, path);
            if (!existsSync(absolutePath)) throw new Error(`Current tree is missing script ${path}.`);
            return readFileSync(absolutePath, 'utf8');
        };
        versions.push(extractDatabaseVersion(readFileSync(resolve(root, htmlPath), 'utf8'), {
            sourceKind: 'html',
            loadScript
        }));
    }
    for (const path of deployablePaths.filter(isDeployableRuntimePath)) {
        if (loadedScripts.has(path)) continue;
        versions.push(extractDeployableJavaScriptVersion(
            readFileSync(resolve(root, path), 'utf8'),
            path
        ));
    }
    const version = mergeDatabaseVersions(versions);
    if (version == null) throw new Error('Current tree does not expose a recognizable CPlayer5DB version.');
    return version;
}

export function readTargetDatabaseVersion(ref, cwd = ROOT) {
    const tree = runGit(['ls-tree', '-r', '--name-only', '-z', ref], cwd);
    if (tree.status !== 0) throw new Error(`Rollback target ${ref} file tree could not be read.`);
    const deployablePaths = tree.stdout.split('\0').filter(isDeployableArtifactPath);
    if (!deployablePaths.includes('index.html')) {
        throw new Error(`Rollback target ${ref} does not expose index.html.`);
    }
    const loadedScripts = new Set();
    const versions = [];
    const htmlPaths = deployablePaths.filter((path) => /\.html$/i.test(path));
    for (const htmlPath of htmlPaths) {
        const entry = runGit(['show', `${ref}:${htmlPath}`], cwd);
        if (entry.status !== 0) throw new Error(`Rollback target is missing HTML ${htmlPath}.`);
        const loadScript = (src) => {
            const path = normalizeLocalScriptPath(src, htmlPath);
            if (!deployablePaths.includes(path)) {
                throw new Error(`Rollback target is missing deployed script ${path}.`);
            }
            loadedScripts.add(path);
            const result = runGit(['show', `${ref}:${path}`], cwd);
            if (result.status !== 0) throw new Error(`Rollback target is missing script ${path}.`);
            return result.stdout;
        };
        versions.push(extractDatabaseVersion(entry.stdout, { sourceKind: 'html', loadScript }));
    }
    const runtimePaths = deployablePaths.filter(isDeployableRuntimePath);
    for (const path of runtimePaths) {
        if (loadedScripts.has(path)) continue;
        const result = runGit(['show', `${ref}:${path}`], cwd);
        if (result.status !== 0) continue;
        versions.push(extractDeployableJavaScriptVersion(result.stdout, path));
    }
    const version = mergeDatabaseVersions(versions);
    if (version == null) {
        throw new Error(`Rollback target ${ref} does not expose a recognizable CPlayer5DB version.`);
    }
    return version;
}

export async function checkRollbackTarget(ref) {
    if (!ref || /[\r\n]/.test(ref)) throw new Error('Usage: npm run check:rollback -- <git-ref>');
    const verified = runGit(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    if (verified.status !== 0) throw new Error(`Unknown rollback Git ref: ${ref}`);

    const commit = verified.stdout.trim();
    const targetVersion = readTargetDatabaseVersion(commit);
    const result = assertRollbackVersion(
        readCurrentDatabaseVersion(),
        targetVersion
    );
    return { ...result, commit };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        const result = await checkRollbackTarget(process.argv[2]);
        console.log(`rollback target: ${result.commit}`);
        console.log(`database compatibility: current v${result.currentVersion}, target v${result.targetVersion}`);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
