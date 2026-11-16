import ts from "typescript";

function calleeName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node))
    return `${calleeName(node.expression)}.${node.name.text}`;
  if (ts.isCallExpression(node)) return `${calleeName(node.expression)}()`;
  if (ts.isElementAccessExpression(node))
    return `${calleeName(node.expression)}[]`;
  return "callback";
}

function functionName(node, source) {
  if (node.name) return node.name.getText(source);
  const parent = node.parent;
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent)
  ) {
    return parent.name.getText(source);
  }
  if (ts.isCallExpression(parent)) {
    return `${calleeName(parent.expression)}:arg${parent.arguments.indexOf(node)}`;
  }
  return "anonymous";
}

function symbolFor(node, source) {
  const names = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) names.unshift(functionName(parent, source));
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))
      names.unshift(functionName(parent, source));
    if (
      (ts.isVariableDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent)) &&
      parent.initializer &&
      (ts.isObjectLiteralExpression(parent.initializer) ||
        ts.isCallExpression(parent.initializer))
    )
      names.unshift(parent.name.getText(source));
  }
  return names.join("/") || "module";
}

function ownAwaits(node, found = []) {
  if (ts.isFunctionLike(node)) return found;
  if (ts.isAwaitExpression(node)) found.push(node);
  ts.forEachChild(node, (child) => {
    if (!ts.isFunctionLike(child)) ownAwaits(child, found);
  });
  return found;
}

function bindingNames(node) {
  if (ts.isIdentifier(node)) return [node.text];
  return node.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  );
}

function references(node, names) {
  if (ts.isIdentifier(node) && names.has(node.text)) {
    const parent = node.parent;
    const propertyName =
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node);
    if (!propertyName) return true;
  }
  return ts.forEachChild(node, (child) => references(child, names)) || false;
}

function innermostLoop(node) {
  let child = node;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return null;
    if (ts.isIterationStatement(parent, false)) {
      const once =
        (ts.isForStatement(parent) && parent.initializer === child) ||
        ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
          (parent.initializer === child || parent.expression === child));
      if (!once) return parent;
    }
    child = parent;
  }
  return null;
}

/** Review candidates, not a proof that the operations can run concurrently. */
export function asyncWaterfalls(sourceText, fileName) {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  if (source.parseDiagnostics.length) {
    const diagnostic = source.parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      " ",
    );
    throw new Error(`${fileName}: cannot scan invalid syntax: ${message}`);
  }
  const hits = [];
  function report(rule, node) {
    hits.push({
      rule,
      symbol: symbolFor(node, source),
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  }
  function scanBlock(block) {
    let pending = null;
    for (const statement of block.statements) {
      // Branches, validation, writes, returns and other statements are barriers.
      if (!ts.isVariableStatement(statement)) {
        pending = null;
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) {
          pending = null;
          continue;
        }
        const awaits = ownAwaits(declaration.initializer);
        const names = bindingNames(declaration.name);
        if (awaits.length === 1) {
          if (pending && !references(declaration.initializer, pending)) {
            report("independent-awaits", awaits[0]);
          }
          pending = new Set(names);
        } else if (awaits.length > 1) {
          pending = null;
        } else if (pending && references(declaration.initializer, pending)) {
          for (const name of names) pending.add(name);
        }
      }
    }
  }
  function visit(node) {
    if (ts.isBlock(node) || ts.isSourceFile(node)) scanBlock(node);
    if (ts.isAwaitExpression(node)) {
      const loop = innermostLoop(node);
      // for-await streams already express the required input order.
      if (loop && !(ts.isForOfStatement(loop) && loop.awaitModifier)) {
        report("await-in-loop", node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return hits.sort(
    (left, right) =>
      left.line - right.line || left.rule.localeCompare(right.rule),
  );
}
