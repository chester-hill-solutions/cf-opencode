import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const SOURCE_ROOTS = [
  "app",
  "server",
  "worker",
  "services",
  "shared",
  "config",
  "packages",
];
const SIGNAL_METHODS = new Set([
  "startActiveSpan",
  "startSpan",
  "emit",
  "add",
  "record",
  "observe",
  "startBrowserSdk",
  "addEvent",
  "recordException",
]);
const IO_METHODS = new Set([
  "create",
  "connect",
  "createConnection",
  "retrieve",
  "update",
  "delete",
  "remove",
  "fetch",
  "list",
  "page",
  "each",
  "request",
  "send",
  "get",
  "post",
  "put",
  "patch",
  "cancel",
  "stream",
  "parse",
  "findMany",
  "findFirst",
  "execute",
  "transaction",
  "begin",
  "savepoint",
  "reserve",
  "listen",
  "notify",
]);
const IO_PACKAGES =
  /\/node_modules\/(?:@aws-sdk|@smithy|twilio|stripe|resend|openai|postgres|drizzle-orm|ws|@types\/ws|@chester-hill-solutions\/media-library)\//;
const RUNTIME_CALLBACKS = new Set([
  "fetch",
  "error",
  "open",
  "message",
  "close",
  "drain",
]);
const COMPONENT_LIFECYCLES = new Set([
  "componentDidMount",
  "componentDidUpdate",
  "componentWillUnmount",
  "componentDidCatch",
]);
const ROUTE_EXPORTS = new Set([
  "loader",
  "action",
  "middleware",
  "handleError",
]);

function productionFiles(root, sourceRoots, skipPaths) {
  const files = [];
  const manifests = [path.join(root, "package.json")];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const rel = path.relative(root, file).replaceAll(path.sep, "/");
      if (
        skipPaths.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`)) ||
        /^(?:app\/lib\/api-generated|app\/routes\/archive)(?:\/|$)/.test(rel) ||
        /(?:^|\/)(?:node_modules|__tests__)(?:\/|$)/.test(rel)
      )
        continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.name === "package.json") manifests.push(file);
      else if (
        /\.[cm]?[jt]sx?$/.test(file) &&
        !/\.(?:d\.[cm]?ts|test\.[cm]?[jt]sx?|spec\.[cm]?[jt]sx?)$/.test(file) &&
        !/^app\/routes\/old[./]/.test(rel)
      )
        files.push(file);
    }
  }
  sourceRoots.forEach((dir) => walk(path.join(root, dir)));
  return { files: files.sort(), manifests };
}

function functionNode(node) {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
    !!node.body
  );
}

function assignedName(node) {
  if (node.name) return node.name.text ?? node.name.getText();
  let parent = node.parent;
  while (parent && !ts.isSourceFile(parent) && !functionNode(parent)) {
    if (
      ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)
    )
      return parent.name.text ?? parent.name.getText();
    if (ts.isExportAssignment(parent)) return "<default>";
    parent = parent.parent;
  }
  if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
    return "<default>";
  return "<callback>";
}

function declarationName(node) {
  return node.parent && "name" in node.parent && node.parent.name === node;
}

function packagePath(declaration) {
  return declaration.getSourceFile().fileName.replaceAll(path.sep, "/");
}

function moduleLiteral(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  )
    return node.moduleSpecifier.text;
  if (
    ts.isExternalModuleReference(node) &&
    node.expression &&
    ts.isStringLiteralLike(node.expression)
  )
    return node.expression.text;
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) &&
        node.expression.text === "require")) &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0])
  )
    return node.arguments[0].text;
  return undefined;
}

function isSentryPath(value) {
  return /(?:^@sentry\/|^@\/lib\/sentry\.server(?:\.[cm]?[jt]s)?$|\/node_modules\/@sentry\/|(?:^|\/)app\/lib\/sentry\.server(?:\.[cm]?[jt]s)?$)/.test(
    value,
  );
}

function symbolDeclarations(checker, node, seen = new Set()) {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol || seen.has(symbol)) return [];
  seen.add(symbol);
  const resolved =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const declarations = resolved.declarations ?? [];
  return declarations.flatMap((decl) => {
    if (ts.isShorthandPropertyAssignment(decl)) {
      const value = checker.getShorthandAssignmentValueSymbol(decl);
      const original =
        value?.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(value)
          : value;
      return original?.declarations ?? [decl];
    }
    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isCallExpression(decl.initializer) &&
      ts.isPropertyAccessExpression(decl.initializer.expression) &&
      decl.initializer.expression.name.text === "bind"
    ) {
      return [
        decl,
        ...symbolDeclarations(
          checker,
          decl.initializer.expression.expression,
          seen,
        ),
      ];
    }
    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      (ts.isIdentifier(decl.initializer) ||
        ts.isPropertyAccessExpression(decl.initializer))
    )
      return [
        decl,
        ...symbolDeclarations(
          checker,
          ts.isPropertyAccessExpression(decl.initializer)
            ? decl.initializer.name
            : decl.initializer,
          seen,
        ),
      ];
    return [decl];
  });
}

function callees(checker, call) {
  const expression = call.expression;
  const name = ts.isPropertyAccessExpression(expression)
    ? expression.name
    : expression;
  return symbolDeclarations(checker, name);
}

function wrappingName(node) {
  for (
    let p = node.parent;
    p && !ts.isSourceFile(p) && !functionNode(p);
    p = p.parent
  ) {
    if (ts.isVariableDeclaration(p)) return p.name.getText();
  }
  return undefined;
}

function boundaryKind(record) {
  const { node, name, file } = record;
  if (record.route) return "route";
  if (record.component) return "component";
  if (name === "<module>") return undefined;
  if (
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
    node.asteriskToken
  )
    return "async";
  if (
    (ROUTE_EXPORTS.has(name) || ROUTE_EXPORTS.has(wrappingName(node))) &&
    file.startsWith("app/routes/")
  )
    return "route";
  if (/Handler$/.test(name) || /Handler$/.test(wrappingName(node) ?? ""))
    return "job";
  if (/^\p{Lu}/u.test(name)) return "component";
  if (
    (name === "<default>" ||
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) &&
    /\.[jt]sx$/.test(file)
  )
    return "component";
  const parent = ts.isPropertyDeclaration(node.parent)
    ? node.parent.parent
    : node.parent;
  if (
    name === "render" &&
    (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))
  )
    return "component";
  if (record.reactElement) return "component";
  if (/^(?:server|worker|services)\//.test(file) && RUNTIME_CALLBACKS.has(name))
    return "runtime";
  return undefined;
}

function createRecords(sources, root) {
  const records = [];
  const owners = new Map();
  for (const source of sources) {
    const file = path.relative(root, source.fileName).replaceAll(path.sep, "/");
    const module = {
      node: source,
      file,
      name: "<module>",
      symbol: "<module>",
      calls: new Set(),
      sites: [],
      covered: false,
    };
    records.push(module);
    function visit(node, owner) {
      let next = owner;
      if (functionNode(node)) {
        const name = assignedName(node);
        const classParent = ts.isPropertyDeclaration(node.parent)
          ? node.parent.parent
          : node.parent;
        const className =
          ts.isClassDeclaration(classParent) ||
          ts.isClassExpression(classParent)
            ? (classParent.name?.text ?? "<class>")
            : undefined;
        const prefix = [
          owner.name === "<module>" ? undefined : owner.symbol,
          className,
        ]
          .filter(Boolean)
          .join(".");
        next = {
          node,
          classNode:
            ts.isClassDeclaration(classParent) ||
            ts.isClassExpression(classParent)
              ? classParent
              : undefined,
          file,
          name,
          symbol: prefix ? `${prefix}.${name}` : name,
          calls: new Set(),
          sites: [],
          covered: false,
        };
        records.push(next);
      }
      owners.set(node, next);
      ts.forEachChild(node, (child) => visit(child, next));
    }
    visit(source, module);
  }
  return { records, owners };
}

function declarationRecord(declaration, owners) {
  if (functionNode(declaration)) return owners.get(declaration);
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const visit = (node) => {
      if (functionNode(node)) return owners.get(node);
      return ts.forEachChild(node, visit);
    };
    return visit(declaration.initializer);
  }
  return undefined;
}

function sentryDeclaration(declaration) {
  if (isSentryPath(packagePath(declaration))) return true;
  let parent = declaration;
  while (
    parent &&
    !ts.isSourceFile(parent) &&
    !ts.isVariableDeclaration(parent)
  )
    parent = parent.parent;
  let value = parent?.initializer;
  while (
    value &&
    (ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value))
  )
    value = value.expression;
  const literal = value && moduleLiteral(value);
  return !!literal && isSentryPath(literal);
}

function insideImport(node) {
  for (
    let parent = node.parent;
    parent && !ts.isSourceFile(parent);
    parent = parent.parent
  ) {
    if (
      ts.isImportDeclaration(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isExportDeclaration(parent)
    )
      return true;
  }
  return false;
}

function analyzeReferences(source, checker, owners, hit) {
  function visit(node) {
    const owner = owners.get(node);
    const literal = moduleLiteral(node);
    if (
      literal &&
      (isSentryPath(literal) ||
        isSentryPath(
          path
            .resolve(path.dirname(source.fileName), literal)
            .replaceAll(path.sep, "/"),
        ))
    )
      hit(owner, "sentry.module", node);
    if (
      (ts.isIdentifier(node) ||
        (ts.isStringLiteralLike(node) && declarationName(node))) &&
      node.text === "SENTRY_DSN"
    )
      hit(owner, "sentry.config", node);
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "SENTRY_DSN"
    )
      hit(owner, "sentry.config", node);
    const parent = node.parent;
    const valueUse =
      parent &&
      ((ts.isVariableDeclaration(parent) && parent.initializer === node) ||
        (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
        (ts.isCallExpression(parent) && parent.arguments.includes(node)) ||
        ts.isReturnStatement(parent) ||
        ts.isArrayLiteralExpression(parent) ||
        ts.isShorthandPropertyAssignment(parent));
    if (
      valueUse &&
      (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
      !declarationName(node) &&
      !insideImport(node)
    ) {
      const value = ts.isPropertyAccessExpression(node) ? node.name : node;
      if (symbolDeclarations(checker, value).some(sentryDeclaration))
        hit(owner, "sentry.reference", node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function ioSite(node, declarations) {
  const expression = ts.isTaggedTemplateExpression(node)
    ? node.tag
    : node.expression;
  const name = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : ts.isIdentifier(expression)
      ? expression.text
      : "";
  const names = new Set([
    name,
    ...declarations.map((d) => d.name?.getText()).filter(Boolean),
  ]);
  const standard = declarations.some((d) =>
    /(?:lib\.dom\.d\.ts|bun.*\.d\.ts)$/.test(packagePath(d)),
  );
  if (
    standard &&
    ["fetch", "WebSocket", "EventSource"].some((candidate) =>
      names.has(candidate),
    )
  )
    return true;
  if (
    declarations.some((d) =>
      /\/@types\/node\/child_process\.d\.ts$/.test(packagePath(d)),
    ) &&
    [
      "spawn",
      "exec",
      "execFile",
      "fork",
      "execSync",
      "spawnSync",
      "execFileSync",
    ].some((candidate) => names.has(candidate))
  )
    return true;
  if (
    standard &&
    ["spawn", "spawnSync"].some((candidate) => names.has(candidate))
  )
    return true;
  const sdk = declarations.some(
    (d) =>
      IO_PACKAGES.test(packagePath(d)) ||
      /\/@types\/node\/(?:http|https|net|tls)\.d\.ts$/.test(packagePath(d)),
  );
  if (
    ts.isNewExpression(node) &&
    declarations.some(
      (d) =>
        /\/node_modules\/@types\/ws\//.test(packagePath(d)) &&
        ["WebSocket", "WebSocketServer", "Server"].includes(d.name?.getText()),
    )
  )
    return true;
  if (!sdk || ts.isNewExpression(node)) return false;
  if ([...names].some((candidate) => IO_METHODS.has(candidate))) return true;
  return ts.isAwaitExpression(node.parent);
}

function callbackRecords(node, checker, owners, seen = new Set()) {
  if (seen.has(node)) return [];
  seen.add(node);
  if (functionNode(node)) return [owners.get(node)].filter(Boolean);
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
    return node.members
      .flatMap((member) =>
        functionNode(member)
          ? [owners.get(member)]
          : ts.isPropertyDeclaration(member) && member.initializer
            ? callbackRecords(member.initializer, checker, owners, seen)
            : [],
      )
      .filter(Boolean);
  if (ts.isObjectLiteralExpression(node))
    return node.properties.flatMap((entry) =>
      callbackRecords(entry, checker, owners, seen),
    );
  if (ts.isArrayLiteralExpression(node))
    return node.elements.flatMap((entry) =>
      callbackRecords(entry, checker, owners, seen),
    );
  if (ts.isPropertyAssignment(node) || ts.isSpreadAssignment(node))
    return callbackRecords(
      node.initializer ?? node.expression,
      checker,
      owners,
      seen,
    );
  if (ts.isIdentifier(node))
    return symbolDeclarations(checker, node).flatMap((d) => {
      if (functionNode(d)) return [owners.get(d)].filter(Boolean);
      return ts.isVariableDeclaration(d) && d.initializer
        ? callbackRecords(d.initializer, checker, owners, seen)
        : [];
    });
  return [];
}

function analyzeCalls(source, checker, owners, wrappers, hit) {
  function visit(node) {
    if (ts.isReturnStatement(node) && node.expression)
      callbackRecords(node.expression, checker, owners).forEach((returned) =>
        owners.get(node).calls.add(returned),
      );
    if (ts.isArrowFunction(node) && functionNode(node.body))
      owners.get(node).calls.add(owners.get(node.body));
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node)
    ) {
      const call = ts.isTaggedTemplateExpression(node)
        ? { expression: node.tag }
        : node;
      const declarations = callees(checker, call);
      const owner = owners.get(node);
      const expressionForSentry = call.expression;
      const sentryDeclarations = ts.isPropertyAccessExpression(
        expressionForSentry,
      )
        ? [
            ...declarations,
            ...symbolDeclarations(checker, expressionForSentry.expression),
          ]
        : declarations;
      if (sentryDeclarations.some(sentryDeclaration))
        hit(owner, "sentry.reference", node);
      const targets = declarations
        .map((d) => declarationRecord(d, owners))
        .filter(Boolean);
      targets.forEach((target) => owner.calls.add(target));
      const expression = call.expression;
      const method = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ts.isIdentifier(expression)
          ? expression.text
          : "";
      const reactMethod = declarations.some((d) =>
        /\/node_modules\/(?:@types\/react|react)\//.test(packagePath(d)),
      )
        ? declarations.find((d) => d.name)?.name?.getText()
        : undefined;
      if (reactMethod === "createElement") owner.reactElement = true;
      const signal = declarations.some(
        (d) =>
          /\/node_modules\/@opentelemetry\//.test(packagePath(d)) &&
          SIGNAL_METHODS.has(d.name?.getText() ?? method),
      );
      if (signal) owner.covered = true;
      if (ioSite(node, declarations)) owner.sites.push(node);
      const native = declarations.some((d) =>
        /\/typescript\/lib\/lib\..*\.d\.ts$/.test(packagePath(d)),
      );
      const synchronousCallbacks =
        native &&
        ((ts.isNewExpression(node) && method === "Promise") ||
          [
            "map",
            "flatMap",
            "forEach",
            "filter",
            "some",
            "every",
            "find",
            "findIndex",
            "reduce",
            "reduceRight",
            "sort",
          ].includes(method));
      if (synchronousCallbacks) {
        for (const arg of node.arguments ?? [])
          for (const callback of callbackRecords(arg, checker, owners)) {
            owner.calls.add(callback);
            callback.calls.add(owner);
          }
      }

      if (ts.isCallExpression(node)) {
        for (const arg of node.arguments) {
          for (const direct of callbackRecords(arg, checker, owners)) {
            wrappers.push({ callback: direct, targets, signal });
            if (
              [
                "useEffect",
                "useLayoutEffect",
                "useInsertionEffect",
                "useMemo",
              ].includes(reactMethod)
            )
              owner.calls.add(direct);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function markExportsAndElements(sources, checker, owners) {
  for (const source of sources) {
    if (source.fileName.replaceAll(path.sep, "/").includes("/app/routes/")) {
      const module = checker.getSymbolAtLocation(source);
      for (const exported of module ? checker.getExportsOfModule(module) : []) {
        if (!ROUTE_EXPORTS.has(exported.name)) continue;
        const symbol =
          exported.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(exported)
            : exported;
        const targets = (symbol.declarations ?? [])
          .flatMap((d) => (d.name ? symbolDeclarations(checker, d.name) : [d]))
          .map((d) => declarationRecord(d, owners))
          .filter(Boolean);
        if (targets.length)
          targets.forEach((target) => {
            target.route = true;
          });
        else owners.get(source).route = true;
      }
    }
    function visit(node) {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        (!ts.isIdentifier(node.tagName) || !/^[a-z]/.test(node.tagName.text))
      ) {
        for (const declaration of symbolDeclarations(checker, node.tagName)) {
          const target = declarationRecord(declaration, owners);
          if (target) target.component = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}

function propagateCoverage(records, wrappers) {
  const lifecycles = new Map();
  for (const record of records) {
    if (record.classNode && COMPONENT_LIFECYCLES.has(record.name)) {
      const siblings = lifecycles.get(record.classNode) ?? [];
      siblings.push(record);
      lifecycles.set(record.classNode, siblings);
    }
  }
  for (const record of records) {
    if (record.name === "render")
      for (const lifecycle of lifecycles.get(record.classNode) ?? [])
        record.calls.add(lifecycle);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (
        !record.covered &&
        [...record.calls].some((target) => target.covered)
      ) {
        record.covered = true;
        changed = true;
      }
    }
    for (const wrapper of wrappers) {
      if (
        !wrapper.callback.covered &&
        (wrapper.signal || wrapper.targets.some((t) => t.covered))
      ) {
        wrapper.callback.covered = true;
        changed = true;
      }
    }
  }
}

export function collectTelemetryDebt(root, { sourceRoots = SOURCE_ROOTS, skipPaths = [] } = {}) {
  const { files, manifests } = productionFiles(root, sourceRoots, skipPaths);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    skipLibCheck: true,
    baseUrl: root,
    paths: { "@/*": ["app/*"] },
  });
  const checker = program.getTypeChecker();
  const sources = files.map((file) => program.getSourceFile(file));
  const { records, owners } = createRecords(sources, root);
  const hits = [];
  const hit = (owner, rule, node) =>
    hits.push({
      key: `${owner.file}::${owner.symbol}::${rule}`,
      file: owner.file,
      line:
        node.getSourceFile().getLineAndCharacterOfPosition(node.getStart())
          .line + 1,
    });
  const wrappers = [];
  for (const source of sources) {
    if (source.parseDiagnostics.length)
      throw new Error(
        `Cannot parse ${source.fileName}; fix syntax before running the telemetry guard.`,
      );
    analyzeReferences(source, checker, owners, hit);
    analyzeCalls(source, checker, owners, wrappers, hit);
  }
  markExportsAndElements(sources, checker, owners);
  propagateCoverage(records, wrappers);
  for (const record of records) {
    if (record.covered) continue;
    const kind = boundaryKind(record);
    if (kind) hit(record, `otel.${kind}`, record.node);
    for (const site of record.sites) hit(record, "otel.io", site);
  }
  for (const manifest of manifests) {
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const file = path.relative(root, manifest).replaceAll(path.sep, "/");
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, version] of Object.entries(pkg[section] ?? {})) {
        if (name.startsWith("@sentry/") || /^npm:@sentry\//.test(version))
          hits.push({
            key: `${file}::${section}.${name}::sentry.dependency`,
            file,
            line: 1,
          });
      }
    }
  }
  const allowed = {};
  for (const entry of hits) allowed[entry.key] = (allowed[entry.key] ?? 0) + 1;
  return {
    allowed: Object.fromEntries(
      Object.entries(allowed).sort(([a], [b]) => a.localeCompare(b)),
    ),
    hits,
    files: files.length,
  };
}
