/** Syntax guarantees; flow-sensitive auth and projection behavior stays covered by request-path tests. */
export const structuralRules = {
  'type-escape': {
    meta: { schema: [], messages: { escape: 'Avoid {{kind}}; narrow the value or model the boundary type.' } },
    create(context) {
      return { TSAsExpression(node) {
        const type = node.typeAnnotation.type;
        if (type === 'TSNeverKeyword' || (type === 'TSUnknownKeyword' && node.parent.type === 'TSAsExpression')) {
          context.report({ node, messageId: 'escape', data: { kind: type === 'TSNeverKeyword' ? 'as never' : 'as unknown as' } });
        }
      } };
    },
  },
  'body-once': {
    meta: { schema: [], messages: { twice: '{{receiver}} body read again in {{symbol}}; parse once and pass the result.' } },
    create(context) {
      const frames = [];
      const binding = (node) => {
        if (node.type !== 'Identifier') return context.sourceCode.getText(node);
        for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
          if (scope.set.has(node.name)) return scope.set.get(node.name);
        }
        return node.name;
      };
      return {
        onCodePathStart(_path, node) {
          frames.push({ name: node.id?.name ?? 'callback', active: new Set(), reads: new Map() });
        },
        onCodePathEnd() { frames.pop(); },
        onCodePathSegmentStart(segment) {
          const frame = frames.at(-1);
          const reads = new Set(segment.prevSegments.flatMap((prior) => [...(frame.reads.get(prior) ?? [])]));
          frame.reads.set(segment, reads);
          frame.active.add(segment);
        },
        onCodePathSegmentEnd(segment) { frames.at(-1).active.delete(segment); },
        CallExpression(node) {
          const callee = node.callee;
          if (callee.type !== 'MemberExpression' || callee.computed ||
            !['json', 'text', 'formData', 'arrayBuffer', 'blob', 'bytes'].includes(callee.property.name)) return;
          const receiver = context.sourceCode.getText(callee.object);
          // Response.json is a static constructor, not a stream consumption.
          if (receiver === 'Response' || receiver.endsWith('.Response') ||
              !/(?:request|response|req|res)$/i.test(receiver)) return;
          const frame = frames.at(-1);
          const key = binding(callee.object);
          if ([...frame.active].some((segment) => frame.reads.get(segment).has(key))) {
            context.report({ node, messageId: 'twice', data: { receiver, symbol: frame.name } });
          }
          for (const segment of frame.active) frame.reads.get(segment).add(key);
        },
      };
    },
  },
  'mock-passthrough': {
    meta: { schema: [], messages: { surface: 'Shared module mocks must spread the real module exports (importOriginal/requireActual or a captured real import).' } },
    create(context) {
      return { CallExpression(node) {
        const callee = context.sourceCode.getText(node.callee);
        if (!['mock.module', 'vi.mock', 'jest.mock'].includes(callee)) return;
        const name = node.arguments[0]?.value;
        if (typeof name !== 'string' || !name.startsWith('.')) return;
        const factory = node.arguments[1];
        if (!factory) return;
        function isActual(expr, seen = new Set()) {
          if (!expr || seen.has(expr)) return false;
          seen.add(expr);
          if (expr.type === 'AwaitExpression') return isActual(expr.argument, seen);
          if (expr.type === 'ImportExpression') return expr.source.value === name;
          if (expr.type === 'CallExpression') {
            const called = context.sourceCode.getText(expr.callee);
            return (['importOriginal', 'vi.importActual', 'jest.requireActual'].includes(called) ||
              (factory.params?.[0]?.type === 'Identifier' && called === factory.params[0].name));
          }
          if (expr.type !== 'Identifier') return false;
          for (let scope = context.sourceCode.getScope(expr); scope; scope = scope.upper) {
            const variable = scope.set.get(expr.name);
            if (variable) return variable.defs.some((def) => isActual(def.node.init, seen));
          }
          return false;
        }
        let passthrough = false;
        function visit(child) {
          if (child.type === 'SpreadElement' && isActual(child.argument)) passthrough = true;
          for (const key of context.sourceCode.visitorKeys[child.type] ?? []) {
            const value = child[key];
            for (const next of Array.isArray(value) ? value : [value]) if (next?.type) visit(next);
          }
        }
        visit(factory);
        if (!passthrough) context.report({ node, messageId: 'surface' });
      } };
    },
  },
};
