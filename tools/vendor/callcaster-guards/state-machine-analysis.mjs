import ts from "typescript";

const LIFECYCLE_FIELD =
  /^(?:state|status|phase|stage|step|queue_state|provider_status|current_step)$/;
const LIFECYCLE_BINDING =
  /(?:^|_)(?:state|status|phase|stage|step|lifecycle|wizard|progress)$|(?:State|Status|Phase|Stage|Step|Lifecycle|Wizard|Progress)$/;

function unwrap(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node))
  )
    node = node.expression;
  return node;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (
    ts.isComputedPropertyName(node) &&
    ts.isStringLiteralLike(node.expression)
  )
    return node.expression.text;
  return null;
}

function memberPath(node) {
  node = unwrap(node);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node))
    return `${memberPath(node.expression)}.${node.name.text}`;
  if (ts.isElementAccessExpression(node))
    return `${memberPath(node.expression)}.${propertyName(node.argumentExpression) ?? "[]"}`;
  if (ts.isCallExpression(node)) return `${memberPath(node.expression)}()`;
  return "expression";
}

function containingSymbol(node) {
  const names = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      let name = parent.name ? propertyName(parent.name) : null;
      for (
        let owner = parent.parent;
        !name && owner && !ts.isFunctionLike(owner);
        owner = owner.parent
      ) {
        if (ts.isVariableDeclaration(owner)) {
          name = owner.name.getText();
          break;
        }
        if (ts.isPropertyAssignment(owner)) {
          name = propertyName(owner.name);
          break;
        }
        if (ts.isExpressionStatement(owner)) break;
      }
      names.unshift(
        name ??
          (ts.isCallExpression(parent.parent)
            ? `callback:${memberPath(parent.parent.expression)}`
            : "anonymous"),
      );
    } else if (ts.isClassDeclaration(parent) && parent.name)
      names.unshift(parent.name.text);
  }
  return names.join("/") || "module";
}

function parseSource(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  // Binding identity, without loading the app graph, distinguishes imported hooks
  // and setters from equally named parameters in another scope.
  const program = ts.createProgram(
    [file],
    { noResolve: true, noLib: true, allowJs: true },
    {
      getSourceFile: (name) => (name === file ? source : undefined),
      getDefaultLibFileName: () => "",
      writeFile: () => {},
      getCurrentDirectory: () => "/",
      getDirectories: () => [],
      fileExists: (name) => name === file,
      readFile: (name) => (name === file ? text : undefined),
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
    },
  );
  return { source, checker: program.getTypeChecker() };
}

function isFilterState(declaration, stateName) {
  if (/^(?:filter|filters)$/.test(stateName)) return true;
  let filterInput = false;
  function visit(node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /filters?$/i.test(node.expression.text)
    )
      filterInput = true;
    ts.forEachChild(node, visit);
  }
  if (declaration.initializer) visit(declaration.initializer);
  return filterInput;
}

function returnedExpressions(node) {
  if (!ts.isBlock(node.body)) return [node.body];
  const expressions = [];
  function visit(child) {
    if (ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child) && child.expression)
      expressions.push(child.expression);
    else ts.forEachChild(child, visit);
  }
  ts.forEachChild(node.body, visit);
  return expressions;
}

export function lifecycleWrites(text, file) {
  const { source, checker } = parseSource(text, file);
  if (source.parseDiagnostics.length)
    throw new Error(`${file}: cannot parse source for check:state-machines`);
  const findings = [];
  const setters = new Map();

  function symbolOf(node, seen = new Set()) {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || seen.has(symbol)) return symbol;
    const declaration = symbol?.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      declaration.parent.flags & ts.NodeFlags.Const &&
      ts.isIdentifier(unwrap(declaration.initializer))
    ) {
      return symbolOf(
        unwrap(declaration.initializer),
        new Set([...seen, symbol]),
      );
    }
    return symbol;
  }

  function resolveValue(node, seen = new Set()) {
    node = unwrap(node);
    if (!node || !ts.isIdentifier(node)) return node;
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    if (
      !symbol ||
      seen.has(symbol) ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      !declaration.initializer
    )
      return node;
    return resolveValue(declaration.initializer, new Set([...seen, symbol]));
  }

  function literalValues(node) {
    node = resolveValue(node);
    if (!node) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node))
      return [
        ...literalValues(node.whenTrue),
        ...literalValues(node.whenFalse),
      ];
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      return returnedExpressions(node).flatMap(literalValues);
    return [];
  }

  function add(node, rule, target, value) {
    findings.push({
      symbol: containingSymbol(node),
      rule,
      target,
      value,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  }

  function recordFields(
    node,
    rule,
    target,
    location = node,
    seen = new Set(),
    includeKind = false,
  ) {
    node = resolveValue(node);
    if (!node || seen.has(node)) return;
    seen = new Set([...seen, node]);
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements)
        recordFields(element, rule, target, location, seen, includeKind);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const field of node.properties) {
        if (ts.isSpreadAssignment(field))
          recordFields(
            field.expression,
            rule,
            target,
            location,
            seen,
            includeKind,
          );
        else if (
          ts.isPropertyAssignment(field) &&
          (LIFECYCLE_FIELD.test(propertyName(field.name) ?? "") ||
            (includeKind && propertyName(field.name) === "kind"))
        ) {
          for (const value of literalValues(field.initializer))
            add(location, rule, `${target}.${propertyName(field.name)}`, value);
        }
      }
    } else if (ts.isConditionalExpression(node)) {
      recordFields(node.whenTrue, rule, target, location, seen, includeKind);
      recordFields(node.whenFalse, rule, target, location, seen, includeKind);
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      for (const expression of returnedExpressions(node))
        recordFields(expression, rule, target, location, seen, includeKind);
    }
  }

  function importedFromReact(declaration) {
    for (let node = declaration; node; node = node.parent) {
      if (ts.isImportDeclaration(node))
        return node.moduleSpecifier.text === "react";
    }
    return false;
  }

  function isUseState(node) {
    node = unwrap(node);
    if (ts.isIdentifier(node)) {
      return symbolOf(node)?.declarations?.some(
        (declaration) =>
          ts.isImportSpecifier(declaration) &&
          (declaration.propertyName ?? declaration.name).text === "useState" &&
          importedFromReact(declaration),
      );
    }
    if (
      !ts.isPropertyAccessExpression(node) ||
      node.name.text !== "useState" ||
      !ts.isIdentifier(node.expression)
    )
      return false;
    return symbolOf(node.expression)?.declarations?.some(
      (declaration) =>
        (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) &&
        importedFromReact(declaration),
    );
  }

  function collectHooks(node) {
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)) {
      const call = unwrap(node.initializer);
      const [state, setter] = node.name.elements;
      if (
        call &&
        ts.isCallExpression(call) &&
        isUseState(call.expression) &&
        state &&
        setter &&
        ts.isBindingElement(state) &&
        ts.isBindingElement(setter) &&
        ts.isIdentifier(state.name) &&
        ts.isIdentifier(setter.name)
      ) {
        if (isFilterState(node, state.name.text)) return;
        const before = findings.length;
        if (LIFECYCLE_BINDING.test(state.name.text)) {
          for (const value of literalValues(call.arguments[0]))
            add(call, "react-initial-state", state.name.text, value);
        }
        recordFields(
          call.arguments[0],
          "react-initial-state",
          state.name.text,
          call,
          new Set(),
          true,
        );
        if (findings.length > before || LIFECYCLE_BINDING.test(state.name.text))
          setters.set(
            checker.getSymbolAtLocation(setter.name),
            state.name.text,
          );
      }
    }
    ts.forEachChild(node, collectHooks);
  }
  collectHooks(source);

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const state = ts.isIdentifier(callee)
        ? setters.get(symbolOf(callee))
        : undefined;
      if (state) {
        for (const value of literalValues(node.arguments[0]))
          add(node, "react-literal-transition", state, value);
        recordFields(
          node.arguments[0],
          "react-literal-transition",
          state,
          node,
          new Set(),
          true,
        );
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (
          ["set", "insert", "insertMany", "values", "update"].includes(method)
        ) {
          let payload = resolveValue(node.arguments[0]);
          if (
            method === "update" &&
            payload &&
            ts.isObjectLiteralExpression(payload)
          ) {
            const set = payload.properties.find(
              (property) =>
                ts.isPropertyAssignment(property) &&
                propertyName(property.name) === "set",
            );
            if (set) payload = set.initializer;
          }
          recordFields(
            payload,
            "literal-state-write",
            memberPath(callee),
            node,
          );
        }
        if (
          method === "assign" &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "Object" &&
          !checker.getSymbolAtLocation(callee.expression)
        ) {
          for (const payload of node.arguments.slice(1))
            recordFields(
              payload,
              "literal-state-write",
              memberPath(node.arguments[0]),
              node,
            );
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = unwrap(node.left);
      const field = ts.isPropertyAccessExpression(left)
        ? left.name.text
        : ts.isElementAccessExpression(left)
          ? propertyName(left.argumentExpression)
          : null;
      if (field && LIFECYCLE_FIELD.test(field)) {
        for (const value of literalValues(node.right))
          add(node, "literal-state-assignment", memberPath(left), value);
      }
    }
    if (
      ts.isPropertyDeclaration(node) &&
      LIFECYCLE_FIELD.test(propertyName(node.name) ?? "")
    ) {
      for (const value of literalValues(node.initializer))
        add(node, "literal-state-assignment", propertyName(node.name), value);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}
