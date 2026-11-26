// scriptLexer.js is a shared compiler utility (it also serves the parser's
// prop extraction); it lives at the compiler root rather than in a stage.
const { tokenizeScript, matchTemplateTokens } = require('../scriptLexer');

const ASSIGNMENT_OPERATORS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '&&=', '||=', '??=',
  '&=', '|=', '^=', '<<=', '>>=', '>>>='
]);

// Update operators may follow a property chain (`user.age++`), which mutates
// the root reactive object just like an assignment to it.
const UPDATE_OPERATORS = new Set(['++', '--']);

// Keywords that continue an expression after a completed operand.
const CONTINUING_KEYWORDS = new Set(['instanceof', 'in']);

// Keywords that can never name a function, so a `)` before `{` belongs to a
// control-flow header rather than a parameter list.
const RESERVED_WORDS = new Set([
  'let', 'const', 'var', 'function', 'class', 'return', 'if', 'else', 'for',
  'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'try',
  'catch', 'finally', 'throw', 'new', 'delete', 'typeof', 'void', 'in',
  'instanceof', 'of', 'this', 'super', 'yield', 'await', 'extends', 'static',
  'get', 'set', 'async', 'with'
]);

// Keywords after which `{` opens a statement block rather than an object literal.
const BLOCK_INTRODUCER_KEYWORDS = new Set(['else', 'do', 'try', 'finally']);

const isPunctuator = (token, value) => token && token.type === 'punctuator' && token.value === value;

function nextSignificantIndex(tokens, index) {
  let current = index;
  while (current < tokens.length && tokens[current].type === 'comment') current += 1;
  return current;
}

function previousSignificantIndex(tokens, index) {
  let current = index;
  while (current >= 0 && tokens[current] && tokens[current].type === 'comment') current -= 1;
  return current;
}

function findMatchingParen(tokens, closeIndex) {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token || token.type !== 'punctuator' || token.interpolationClose) continue;
    if (token.value === ')') depth += 1;
    else if (token.value === '(') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findMatchingCloseParen(tokens, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'punctuator') continue;
    if (token.value === '(') depth += 1;
    else if (token.value === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Walks a `.x` / `[...]` property chain starting after an identifier.
 * @returns {{ endIndex: number, sawChain: boolean } | null} The token index of
 *   the first token after the chain, or null when the structure is unbounded.
 */
function findPropertyChainEnd(tokens, startIndex) {
  let index = nextSignificantIndex(tokens, startIndex);
  let sawChain = false;

  for (;;) {
    const token = tokens[index];
    if (!token) return { endIndex: index, sawChain };
    if (token.type === 'comment') { index += 1; continue; }

    if (isPunctuator(token, '.') || isPunctuator(token, '?.')) {
      const propertyIndex = nextSignificantIndex(tokens, index + 1);
      const property = tokens[propertyIndex];
      if (!property || property.type !== 'identifier') return null;
      index = propertyIndex + 1;
      sawChain = true;
      continue;
    }

    if (isPunctuator(token, '[')) {
      let depth = 0;
      let scan = index;
      while (scan < tokens.length) {
        const candidate = tokens[scan];
        if (candidate.type === 'punctuator' && !candidate.interpolationClose) {
          if ('([{'.includes(candidate.value)) depth += 1;
          else if (')]}'.includes(candidate.value)) {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        scan += 1;
      }
      if (scan >= tokens.length) return null;
      index = scan + 1;
      sawChain = true;
      continue;
    }

    return { endIndex: index, sawChain };
  }
}

/**
 * Finds where the statement containing an assignment expression ends, starting
 * just after the assignment operator. Tracks nesting, ternaries, and template
 * literals, and bails out (returns null) whenever the extent cannot be
 * established confidently so valid source is never mis-spliced.
 * @returns {{ insertAt: number, semicolonTerminated: boolean, nextIndex: number } | null}
 *   `insertAt` is the character offset for the notification, `nextIndex` the
 *   token index where the next statement begins (-1 when semicolon-terminated
 *   or at the end of the script).
 */
// Keywords that expect an operand after them, so an identifier that follows
// continues the same expression instead of starting a new statement.
const OPERATOR_KEYWORDS = new Set([
  'typeof', 'new', 'delete', 'void', 'await', 'yield', 'in', 'instanceof',
  'throw', 'case', 'return', 'do', 'else'
]);

/**
 * Finds where the statement containing an assignment expression ends, starting
 * just after the assignment operator. Tracks nesting, ternaries, template
 * literals, and whether the next token is expected to continue the expression
 * or begin a new statement; bails out (returns null) whenever the extent
 * cannot be established confidently so valid source is never mis-spliced.
 * @returns {{ insertAt: number, semicolonTerminated: boolean, nextIndex: number } | null}
 *   `insertAt` is the character offset for the notification, `nextIndex` the
 *   token index where the next statement begins (-1 when semicolon-terminated
 *   or at the end of the script).
 */
function findStatementExtent(tokens, startIndex, templatePairs) {
  let depth = 0;
  let ternaryDepth = 0;
  let expectOperand = true;
  let lastSignificantEnd = -1;
  let index = startIndex;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.type === 'comment') { index += 1; continue; }

    if (token.type === 'punctuator') {
      const value = token.value;

      if (depth === 0 && value === ';') {
        return { insertAt: token.end, semicolonTerminated: true, nextIndex: -1 };
      }
      if (depth === 0 && (value === '}' || value === ')' || value === ']')) {
        return {
          insertAt: lastSignificantEnd === -1 ? token.start : lastSignificantEnd,
          semicolonTerminated: false,
          nextIndex: index
        };
      }
      if (value === '`') {
        const close = templatePairs.get(index);
        if (close === undefined) return null;
        lastSignificantEnd = tokens[close].end;
        expectOperand = false;
        index = close + 1;
        continue;
      }
      if ('([{'.includes(value)) { depth += 1; expectOperand = true; lastSignificantEnd = token.end; index += 1; continue; }
      if (')]}'.includes(value)) { depth -= 1; expectOperand = false; lastSignificantEnd = token.end; index += 1; continue; }
      if (depth === 0 && value === '?') { ternaryDepth += 1; expectOperand = true; lastSignificantEnd = token.end; index += 1; continue; }
      if (depth === 0 && value === ':') {
        if (ternaryDepth === 0) return null;
        ternaryDepth -= 1;
        expectOperand = true;
        lastSignificantEnd = token.end;
        index += 1;
        continue;
      }
      if (depth === 0 && !expectOperand && (value === '++' || value === '--') && token.newlineBefore) {
        // A newline before ++/-- ends the statement (restricted production).
        return { insertAt: lastSignificantEnd, semicolonTerminated: false, nextIndex: index };
      }

      // Every remaining punctuator is an operator: an operand follows - except
      // a postfix update, which completes its operand.
      expectOperand = !(!expectOperand && (value === '++' || value === '--'));
      lastSignificantEnd = token.end;
      index += 1;
      continue;
    }

    if (token.type === 'identifier') {
      if (depth === 0 && !expectOperand && !CONTINUING_KEYWORDS.has(token.value)) {
        // An identifier after a completed operand begins a new statement
        // through automatic semicolon insertion.
        return { insertAt: lastSignificantEnd, semicolonTerminated: false, nextIndex: index };
      }
      expectOperand = OPERATOR_KEYWORDS.has(token.value);
      lastSignificantEnd = token.end;
      index += 1;
      continue;
    }

    // number, string, regex, and templateText literals
    if (depth === 0 && !expectOperand && token.newlineBefore) {
      return { insertAt: lastSignificantEnd, semicolonTerminated: false, nextIndex: index };
    }
    expectOperand = false;
    lastSignificantEnd = token.end;
    index += 1;
  }

  return { insertAt: lastSignificantEnd === -1 ? 0 : lastSignificantEnd, semicolonTerminated: false, nextIndex: -1 };
}

function collectIdentifierNames(tokens, openIndex, closeIndex) {
  const names = new Set();
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    if (tokens[index].type === 'identifier') names.add(tokens[index].value);
  }
  return [...names];
}

/**
 * Collects parameter names bound by an arrow body `{`: either the single
 * identifier immediately before `=>` (`count => { ... }`) or the identifiers
 * inside the parameter group before it (`(a, b) => { ... }`).
 */
function collectArrowParameters(tokens, braceIndex) {
  const arrowIndex = previousSignificantIndex(tokens, braceIndex - 1);
  const beforeParams = previousSignificantIndex(tokens, arrowIndex - 1);
  const beforeToken = tokens[beforeParams];

  if (beforeToken && beforeToken.type === 'identifier') return [beforeToken.value];
  if (isPunctuator(beforeToken, ')')) {
    const openIndex = findMatchingParen(tokens, beforeParams);
    if (openIndex === -1) return [];
    return collectIdentifierNames(tokens, openIndex, beforeParams);
  }
  return [];
}

/**
 * Collects parameter names for a `) {` function body: the identifiers in the
 * closing parameter group, but only when the token before its `(` can
 * introduce a function - a `function` or `catch` keyword, or a non-reserved
 * name (function declaration, method shorthand, getter, setter). Control-flow
 * headers such as `if (...) {` and `while (...) {` bind no parameters.
 */
function collectCallBodyParameters(tokens, braceIndex) {
  const closeIndex = previousSignificantIndex(tokens, braceIndex - 1);
  if (closeIndex < 0 || !isPunctuator(tokens[closeIndex], ')')) return [];

  const openIndex = findMatchingParen(tokens, closeIndex);
  if (openIndex === -1) return [];

  const introducer = tokens[previousSignificantIndex(tokens, openIndex - 1)];
  if (!introducer || introducer.type !== 'identifier') return [];
  const introducesFunction = !RESERVED_WORDS.has(introducer.value)
    || introducer.value === 'function'
    || introducer.value === 'catch';
  if (!introducesFunction) return [];

  return collectIdentifierNames(tokens, openIndex, closeIndex);
}

/**
 * True when the `{` at `braceIndex` opens a function body: an arrow body, a
 * `function`/method/getter/setter body, or any `(...) {` directly inside an
 * object literal or class body (only a method can stand there). Control-flow
 * headers (`if (...) {`) and `catch` clauses are not functions.
 */
function opensFunctionBody(tokens, braceIndex, parentType) {
  const previous = tokens[previousSignificantIndex(tokens, braceIndex - 1)];
  if (isPunctuator(previous, '=>')) return true;
  if (!isPunctuator(previous, ')')) return false;
  if (parentType === 'objectLiteral' || parentType === 'classBody') return true;
  const openIndex = findMatchingParen(tokens, previousSignificantIndex(tokens, braceIndex - 1));
  if (openIndex === -1) return false;
  const introducer = tokens[previousSignificantIndex(tokens, openIndex - 1)];
  if (isPunctuator(introducer, '*')) return true;
  return Boolean(introducer) && introducer.type === 'identifier'
    && introducer.value !== 'catch'
    && (!RESERVED_WORDS.has(introducer.value) || introducer.value === 'function');
}

// Array methods that change the receiver in place (milestone 26). A
// statement-level call of one on a reactive name changes state without
// scheduling an update, unless the name is reassigned afterwards.
const MUTATING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);

// Keywords that open a variable declaration and shadow component state for
// their scope, so mutations of the declared name are left alone.
const DECLARATION_KEYWORDS = new Set(['let', 'const', 'var']);

/**
 * Collects the binding names declared by a `let`/`const`/`var` statement,
 * including destructuring patterns (`let { a, b } = obj;`) and comma-separated
 * declarators, stopping at the statement's terminating `;` or a for-loop
 * `of`/`in` keyword. Initializer expressions are skipped so their identifiers
 * are never mistaken for bindings.
 * @returns {{ names: string[], indices: number[], endIndex: number }} The
 *   declared names, the token index of each, and the token index where
 *   scanning stopped.
 */
function collectDeclaredNames(tokens, keywordIndex) {
  const names = [];
  const indices = [];
  let phase = 'pattern';
  let depth = 0;
  // Depth of a destructuring default (`{ a = fallback }`), which reads names
  // rather than binding them.
  let defaultDepth = null;
  let index = keywordIndex + 1;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.type === 'comment') { index += 1; continue; }

    if (token.type === 'punctuator') {
      const value = token.value;
      if ('([{'.includes(value)) { depth += 1; index += 1; continue; }
      if (')]}'.includes(value)) {
        depth -= 1;
        if (depth < 0) break;
        if (defaultDepth !== null && depth < defaultDepth) defaultDepth = null;
        index += 1;
        continue;
      }
      if (value === ',' && depth === defaultDepth) defaultDepth = null;
      if (value === '=' && depth > 0 && phase === 'pattern' && defaultDepth === null) defaultDepth = depth;
      if (depth === 0 && value === ';') break;
      if (depth === 0 && value === ',') {
        if (phase === 'initializer') phase = 'pattern'; // Next declarator in `let a = 1, b = 2;`.
        index += 1;
        continue;
      }
      if (depth === 0 && value === '=' && phase === 'pattern') phase = 'initializer';
      index += 1;
      continue;
    }

    if (token.type === 'identifier' && depth === 0 && phase === 'pattern'
      && (token.value === 'of' || token.value === 'in')) break;

    // A name before `:` is a destructuring key, not a binding.
    if (token.type === 'identifier' && phase === 'pattern' && defaultDepth === null
      && !isPunctuator(tokens[nextSignificantIndex(tokens, index + 1)], ':')) {
      names.push(token.value);
      indices.push(index);
    }
    index += 1;
  }

  return { names, indices, endIndex: index };
}

/**
 * Rewrites reactive mutations in component script source so they notify the
 * component update dispatcher.
 *
 * The transformation is syntax-aware: scriptLexer.js tokenizes the script, and
 * rewrites are decided on the token stream with a context stack. A mutation of
 * a reactive name is rewritten when it begins a statement inside the component
 * top level, a block, a function or arrow body, or a switch body - including
 * arrow-function callbacks such as `onMount(() => { count = 1 })`. Function
 * and arrow parameters shadow component state, so mutations of parameter
 * names inside their own body are left alone.
 *
 * Assignments are not rewritten in expression position: inside parentheses
 * that are not function bodies (`if (count = 1)`, call arguments), inside
 * object literals and class field initializers, inside template `${}`
 * interpolations, in unbraced `if`/`else`/`while`/`do` statement bodies, or as
 * a chained assignment beyond the first target. Property chains such as
 * `user.name = "Ada"` rewrite with the root reactive name, matching how
 * reactive objects are re-read on update.
 *
 * Whenever the extent of a statement cannot be established confidently, the
 * source passes through untransformed; this scanner never risks corrupting
 * valid JavaScript.
 * @param {string} rawScript - The raw JavaScript string from the <script> block.
 * @param {Array<string>} reactiveVars - Reactive variable names.
 * @returns {string} The rewritten JavaScript string.
 */
/**
 * Scans component script for statement-level mutations of the given reactive
 * names and returns them without rewriting anything. Shared by the rewrite
 * pass (interceptAssignments) and the read-only prop check (the component
 * generator treats any mutation of a prop name as a compile-time error).
 *
 * Block-scoped `let`/`const`/`var` declarations shadow reactive names for
 * their scope, exactly like function and arrow parameters already do, so a
 * locally-declared name can be mutated without notifying the dispatcher.
 * Component-scope declarations are the reactive state itself and never
 * shadow. For-loop header declarations (`for (let item of items)`) shadow the
 * braced body that immediately follows; a header whose body is a bare
 * statement, and computed destructuring keys, pass through untracked.
 *
 * With a `skipped` array (issue #73), the scan also records every mutation
 * of a reactive name it did not rewrite — an assignment in expression
 * position, an unbraced control-flow body, a chained target, or a statement
 * whose extent could not be established — as `{ name, at }`. Parameter
 * defaults, declaration bindings (destructuring defaults included), class
 * fields, property writes on other objects (`obj.count = 1`), and names
 * shadowed by a parameter or a block-scoped declaration are not mutations of
 * component state and are never recorded. Rewriting is unaffected.
 * @param {string} rawScript - The raw JavaScript string from the <script> block.
 * @param {Set<string>} reactiveNames - Reactive variable names.
 *
 * With a `methodCalls` array (milestone 26; requires `skipped`, whose
 * shadowing analysis it shares), the scan also records every statement-level
 * call of a MUTATING_METHODS member on an unshadowed reactive name
 * (`items.push(x);`, `items?.sort();`) made inside a function body, as
 * `{ name, method, at, scope }` where `scope.end` is the offset at which the
 * outermost function enclosing the call closes. Calls outside every function
 * run while the script initializes, before the first render reads state, so
 * they are not recorded.
 * @param {string} rawScript - The raw JavaScript string from the <script> block.
 * @param {Set<string>} reactiveNames - Reactive variable names.
 * @param {Array<{ name: string, at: number }> | null} [skipped] - Collector
 *   for untracked mutations, or null to skip that analysis.
 * @param {Array<{ name: string, method: string, at: number, scope: { end: number } }> | null} [methodCalls]
 *   Collector for in-place method calls, or null.
 * @returns {Array<{ name: string, at: number, insertAt: number, semicolonTerminated: boolean, nextIndex: number }>}
 *   One record per detected mutation; `at` is the offset of the mutating
 *   token, the rest describe where a notification insertion would go.
 */
function scanReactiveMutations(rawScript, reactiveNames, skipped = null, methodCalls = null) {
  const tokens = tokenizeScript(rawScript);
  const templatePairs = matchTemplateTokens(tokens);
  const mutations = [];
  const contexts = [{ type: 'top' }];
  const shadowedDepths = new Map();
  const pendingDeclared = [];
  let atStatementStart = true;
  let switchPending = false;
  let classPending = false;
  let resumeStatementStartAt = -1;
  // Untracked-mutation analysis only: binding-name token indices, and the
  // parameters of expression-bodied arrows (`x => count = x`), which shadow
  // for the rest of the arrow's expression. Kept apart from shadowedDepths
  // so the rewrite decisions cannot change.
  const bindingIndices = new Set();
  const arrowScopes = [];
  const arrowShadowed = new Map();

  const topContext = () => contexts[contexts.length - 1];
  const isStatementContext = () => ['top', 'block', 'switchBody'].includes(topContext().type);
  const isShadowed = (name) => (shadowedDepths.get(name) ?? 0) > 0;

  const pushShadowed = (names) => {
    for (const name of names) shadowedDepths.set(name, (shadowedDepths.get(name) ?? 0) + 1);
  };
  const popShadowed = (names) => {
    for (const name of names) {
      const depth = (shadowedDepths.get(name) ?? 0) - 1;
      if (depth > 0) shadowedDepths.set(name, depth);
      else shadowedDepths.delete(name);
    }
  };

  const buildMutation = (extent, name, at) => ({
    name,
    at,
    insertAt: extent.insertAt,
    semicolonTerminated: extent.semicolonTerminated,
    nextIndex: extent.semicolonTerminated ? -1 : extent.nextIndex
  });

  const detectMutation = (index) => {
    const token = tokens[index];

    // Prefix update: ++count; --count;
    if (token.type === 'punctuator' && UPDATE_OPERATORS.has(token.value)) {
      const targetIndex = nextSignificantIndex(tokens, index + 1);
      const target = tokens[targetIndex];
      if (!target || target.type !== 'identifier' || !reactiveNames.has(target.value) || isShadowed(target.value)) return null;
      const extent = findStatementExtent(tokens, targetIndex, templatePairs);
      return extent ? buildMutation(extent, target.value, token.start) : null;
    }

    if (token.type !== 'identifier' || !reactiveNames.has(token.value) || isShadowed(token.value)) return null;

    const operatorIndex = nextSignificantIndex(tokens, index + 1);
    const operatorToken = tokens[operatorIndex];

    // Direct assignment: count = 1; count += 1;
    if (operatorToken && operatorToken.type === 'punctuator' && ASSIGNMENT_OPERATORS.has(operatorToken.value)) {
      const extent = findStatementExtent(tokens, operatorIndex + 1, templatePairs);
      return extent ? buildMutation(extent, token.value, token.start) : null;
    }

    // Property or element chain: user.name = "Ada"; items[0] = 1; user.age++;
    if (operatorToken && operatorToken.type === 'punctuator'
      && (isPunctuator(operatorToken, '.') || isPunctuator(operatorToken, '?.') || isPunctuator(operatorToken, '['))) {
      const chain = findPropertyChainEnd(tokens, index + 1);
      if (!chain || !chain.sawChain) return null;
      const operator = tokens[chain.endIndex];
      if (!operator || operator.type !== 'punctuator'
        || (!ASSIGNMENT_OPERATORS.has(operator.value) && !UPDATE_OPERATORS.has(operator.value))) return null;
      const extent = findStatementExtent(tokens, chain.endIndex + 1, templatePairs);
      return extent ? buildMutation(extent, token.value, token.start) : null;
    }

    // Postfix update: count++; --total;
    if (operatorToken && operatorToken.type === 'punctuator' && UPDATE_OPERATORS.has(operatorToken.value)
      && !operatorToken.newlineBefore) {
      const extent = findStatementExtent(tokens, index, templatePairs);
      return extent ? buildMutation(extent, token.value, token.start) : null;
    }

    return null;
  };

  // True when the innermost enclosing groups include a parameter list:
  // `(count = 1) => ...`, `function f(count = 1) {`, a method, or a catch
  // clause. Defaults there declare a parameter rather than mutate state.
  // Directly inside an object literal or class body a `(...) {` can only be
  // a method — computed (`[k](...)`) or named by a reserved word
  // (`delete(...)`, `get(...)`, `async get(...)`) — since control-flow
  // headers cannot appear there; after `*` it is a generator.
  const isParameterList = (context) => {
    if (context.parameterList === undefined) {
      const closeIndex = findMatchingCloseParen(tokens, context.openIndex);
      const after = closeIndex === -1 ? null : tokens[nextSignificantIndex(tokens, closeIndex + 1)];
      const introducer = tokens[previousSignificantIndex(tokens, context.openIndex - 1)];
      const methodPosition = context.parentType === 'objectLiteral' || context.parentType === 'classBody';
      context.parameterList = isPunctuator(after, '=>')
        || (isPunctuator(after, '{') && Boolean(introducer) && (
          methodPosition
          || isPunctuator(introducer, '*')
          || (introducer.type === 'identifier'
            && (!RESERVED_WORDS.has(introducer.value) || introducer.value === 'function' || introducer.value === 'catch'))
        ));
    }
    return context.parameterList;
  };
  const inParameterList = () => {
    for (let depth = contexts.length - 1; depth > 0; depth -= 1) {
      const context = contexts[depth];
      if (context.type === 'paren' && isParameterList(context)) return true;
      if (!['paren', 'bracket', 'objectLiteral'].includes(context.type)) return false;
    }
    return false;
  };

  const untrackedSite = (index) => {
    const token = tokens[index];
    let name;
    let nameIndex;
    if (token.type === 'punctuator' && UPDATE_OPERATORS.has(token.value)) {
      // A postfix operator belongs to the operand before it, which its own
      // iteration reports.
      const before = tokens[previousSignificantIndex(tokens, index - 1)];
      const postfix = before && !token.newlineBefore && (
        (before.type === 'identifier' && !OPERATOR_KEYWORDS.has(before.value))
        || ['number', 'string', 'templateText'].includes(before.type)
        || (before.type === 'punctuator' && (before.value === ')' || before.value === ']'))
      );
      if (postfix) return null;
      nameIndex = nextSignificantIndex(tokens, index + 1);
      const target = tokens[nameIndex];
      if (!target || target.type !== 'identifier') return null;
      name = target.value;
    } else if (token.type === 'identifier') {
      const operator = tokens[nextSignificantIndex(tokens, index + 1)];
      if (!operator || operator.type !== 'punctuator') return null;
      let mutates = ASSIGNMENT_OPERATORS.has(operator.value)
        || (UPDATE_OPERATORS.has(operator.value) && !operator.newlineBefore);
      if (!mutates && (operator.value === '.' || operator.value === '?.' || operator.value === '[')) {
        const chain = findPropertyChainEnd(tokens, index + 1);
        const end = chain && chain.sawChain ? tokens[chain.endIndex] : null;
        mutates = Boolean(end && end.type === 'punctuator'
          && (ASSIGNMENT_OPERATORS.has(end.value) || UPDATE_OPERATORS.has(end.value)));
      }
      if (!mutates) return null;
      name = token.value;
      nameIndex = index;
    } else {
      return null;
    }
    if (!reactiveNames.has(name) || isShadowed(name) || (arrowShadowed.get(name) ?? 0) > 0) return null;
    // A for-header declaration (`for (let count = 0; ...; count++)`) shadows
    // the rest of its own header before the body opens.
    if (pendingDeclared.includes(name)) return null;
    const before = tokens[previousSignificantIndex(tokens, nameIndex - 1)];
    if (isPunctuator(before, '.') || isPunctuator(before, '?.')) return null;
    if (bindingIndices.has(nameIndex)) return null;
    if (topContext().type === 'classBody') return null;
    if (inParameterList()) return null;
    return { name, at: token.start };
  };

  // `items.push(` / `items?.push(` at a statement start, inside a function.
  const methodCallSite = (index) => {
    const token = tokens[index];
    if (token.type !== 'identifier' || !reactiveNames.has(token.value)) return null;
    if (isShadowed(token.value) || (arrowShadowed.get(token.value) ?? 0) > 0 || pendingDeclared.includes(token.value)) return null;
    const dotIndex = nextSignificantIndex(tokens, index + 1);
    if (!isPunctuator(tokens[dotIndex], '.') && !isPunctuator(tokens[dotIndex], '?.')) return null;
    const methodIndex = nextSignificantIndex(tokens, dotIndex + 1);
    const method = tokens[methodIndex];
    if (!method || method.type !== 'identifier' || !MUTATING_METHODS.has(method.value)) return null;
    if (!isPunctuator(tokens[nextSignificantIndex(tokens, methodIndex + 1)], '(')) return null;
    const outermost = contexts.find((context) => context.functionBody);
    return outermost ? { name: token.value, method: method.value, at: token.start, scope: outermost.functionBody } : null;
  };

  // A scope of untracked-analysis-only shadowing: the parameters of an
  // expression-bodied arrow, or a for-header declaration over an unbraced
  // body. It lasts until its expression or statement ends at its own depth:
  // `,`, `;`, a new statement through ASI, a ternary `:` it did not open, or
  // a closing bracket that leaves its depth.
  // `bodyPending` marks a for-header scope whose body statement has not
  // started yet: the statement start that begins the body must not end it.
  const pushAnalysisScope = (names, bodyPending = false) => {
    arrowScopes.push({ names, depth: contexts.length, ternaries: 0, bodyPending });
    for (const name of names) arrowShadowed.set(name, (arrowShadowed.get(name) ?? 0) + 1);
  };
  const trackArrowScopes = (index, startsStatement) => {
    const token = tokens[index];
    while (arrowScopes.length > 0) {
      const scope = arrowScopes[arrowScopes.length - 1];
      const atDepth = contexts.length === scope.depth;
      if (atDepth && startsStatement && scope.bodyPending) {
        scope.bodyPending = false;
        break;
      }
      if (atDepth && scope.bodyPending) scope.bodyPending = false;
      let ends = contexts.length < scope.depth
        || (atDepth && token.type === 'punctuator' && (token.value === ',' || token.value === ';'))
        || (atDepth && startsStatement);
      if (!ends && atDepth && isPunctuator(token, ':')) {
        if (scope.ternaries > 0) {
          scope.ternaries -= 1;
          break;
        }
        ends = true;
      }
      if (!ends) break;
      arrowScopes.pop();
      for (const name of scope.names) {
        const depth = (arrowShadowed.get(name) ?? 0) - 1;
        if (depth > 0) arrowShadowed.set(name, depth);
        else arrowShadowed.delete(name);
      }
    }
    if (isPunctuator(token, '?') && arrowScopes.length > 0 && arrowScopes[arrowScopes.length - 1].depth === contexts.length) {
      arrowScopes[arrowScopes.length - 1].ternaries += 1;
    }
    if (isPunctuator(token, '=>') && !isPunctuator(tokens[nextSignificantIndex(tokens, index + 1)], '{')) {
      pushAnalysisScope(collectArrowParameters(tokens, index + 1));
    }
  };

  let previousToken = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'comment') continue;

    if (index === resumeStatementStartAt) {
      atStatementStart = true;
      resumeStatementStartAt = -1;
    }

    // A newline after a completed operand begins a new statement through
    // automatic semicolon insertion. A `)` is excluded on purpose: it may
    // close an unbraced `if`/`while` header, whose body statement must stay
    // unrewritten (inserting after it would break `else` chains).
    const completesOperand = previousToken && (
      (previousToken.type === 'identifier' && !OPERATOR_KEYWORDS.has(previousToken.value))
      || ['number', 'string', 'regex', 'templateText'].includes(previousToken.type)
      || (previousToken.type === 'punctuator' && ['++', '--', ']'].includes(previousToken.value))
    );
    const detectionAllowed = atStatementStart || (token.newlineBefore && completesOperand);

    let recorded = false;
    if (detectionAllowed && isStatementContext()) {
      const mutation = detectMutation(index);
      if (mutation) {
        recorded = true;
        mutations.push(mutation);
        if (mutation.nextIndex > index) resumeStatementStartAt = mutation.nextIndex;
      }
    }
    // In-place calls also begin a statement on a new line after a `)`
    // (`load()\nitems.push(x)`): reporting a call, unlike rewriting, cannot
    // break an `else` chain, so the rewriter's exclusion does not apply.
    if (methodCalls && skipped && !recorded && isStatementContext()
      && (detectionAllowed || (token.newlineBefore && isPunctuator(previousToken, ')')))) {
      const call = methodCallSite(index);
      if (call) methodCalls.push(call);
    }

    if (skipped) {
      // A new statement begins at a statement start or, through ASI, at an
      // identifier on a new line after a completed operand (a continuation
      // such as a leading `.` or `(` keeps the expression going).
      // A `)` counts here too, unlike the rewriter's own rule: ending an
      // analysis scope early can only cost a spurious warning, never a rewrite.
      trackArrowScopes(index, atStatementStart || (token.newlineBefore && token.type === 'identifier'
        && (completesOperand || isPunctuator(previousToken, ')'))));
      if (!recorded) {
        const site = untrackedSite(index);
        if (site) skipped.push(site);
      }
    }

    previousToken = token;

    if (token.type !== 'punctuator') {
      if (token.type === 'identifier') {
        if (token.value === 'switch') switchPending = true;
        if (token.value === 'class') classPending = true;

        // A declaration keyword shadows the names it binds for its scope, so
        // mutations of the local name never notify the dispatcher. Nested
        // block and switch bodies shadow immediately; for-loop headers carry
        // their bindings into the braced body that follows. Component-scope
        // declarations are the reactive state itself and never shadow.
        if (DECLARATION_KEYWORDS.has(token.value)
          && !isPunctuator(tokens[previousSignificantIndex(tokens, index - 1)], '.')) {
          const { names, indices } = collectDeclaredNames(tokens, index);
          if (skipped) for (const bindingIndex of indices) bindingIndices.add(bindingIndex);
          if (names.length > 0) {
            const contextType = topContext().type;
            if (contextType === 'block' || contextType === 'switchBody') {
              const context = topContext();
              context.declared = [...(context.declared || []), ...names];
              pushShadowed(names);
            } else if (contextType === 'paren') {
              pendingDeclared.push(...names);
            }
          }
        }
      }
      atStatementStart = false;
      continue;
    }

    if (token.interpolationClose) {
      if (contexts.length > 1) contexts.pop();
      atStatementStart = false;
      continue;
    }

    if (token.value === '(' || token.value === '[') {
      contexts.push(token.value === '(' ? { type: 'paren', openIndex: index, parentType: topContext().type } : { type: 'bracket' });
      atStatementStart = false;
      continue;
    }

    if (token.value === ')' || token.value === ']') {
      const closing = contexts.length > 1 ? contexts.pop() : null;
      // A for header whose body is not braced: its declarations shadow that
      // one statement only (for the untracked analysis; nothing is rewritten
      // in an unbraced body). Moving them out here keeps them from reaching
      // the next block that opens.
      if (closing && closing.type === 'paren' && pendingDeclared.length > 0
        && !isPunctuator(tokens[nextSignificantIndex(tokens, index + 1)], '{')) {
        const names = pendingDeclared.splice(0);
        if (skipped) pushAnalysisScope(names, true);
      }
      atStatementStart = false;
      continue;
    }

    if (token.value === '{') {
      const previous = tokens[previousSignificantIndex(tokens, index - 1)];
      const previousValue = previous ? previous.value : null;
      let context;

      if (previousValue === '=>') {
        context = { type: 'block', parameters: collectArrowParameters(tokens, index) };
      } else if (switchPending) {
        context = { type: 'switchBody' };
        switchPending = false;
      } else if (classPending) {
        context = { type: 'classBody' };
        classPending = false;
      } else if (BLOCK_INTRODUCER_KEYWORDS.has(previousValue)) {
        context = { type: 'block' };
      } else if (isPunctuator(previous, ')')) {
        context = { type: 'block', parameters: collectCallBodyParameters(tokens, index) };
      } else if (atStatementStart) {
        context = { type: 'block' };
      } else {
        context = { type: 'objectLiteral' };
      }

      if (methodCalls && context.type === 'block' && opensFunctionBody(tokens, index, topContext().type)) {
        context.functionBody = { end: Infinity };
      }
      contexts.push(context);
      if (context.parameters) pushShadowed(context.parameters);
      if (pendingDeclared.length > 0 && ['block', 'switchBody'].includes(context.type)) {
        context.declared = pendingDeclared.splice(0);
        pushShadowed(context.declared);
      }
      atStatementStart = true;
      continue;
    }

    if (token.value === '}') {
      if (contexts.length > 1) {
        const closing = contexts.pop();
        if (closing.parameters) popShadowed(closing.parameters);
        if (closing.declared) popShadowed(closing.declared);
        if (closing.functionBody) closing.functionBody.end = token.start;
        atStatementStart = ['block', 'switchBody'].includes(closing.type);
      } else {
        atStatementStart = false;
      }
      continue;
    }

    if (token.value === '${') {
      contexts.push({ type: 'interpolation' });
      atStatementStart = false;
      continue;
    }

    if (token.value === ':') {
      atStatementStart = topContext().type === 'switchBody';
      continue;
    }

    if (token.value === ';') {
      atStatementStart = true;
      switchPending = false;
      classPending = false;
      // The `;`s inside a for header separate its clauses; the header's
      // declarations must survive them to reach the loop body.
      if (topContext().type !== 'paren') pendingDeclared.length = 0;
      continue;
    }

    atStatementStart = false;
  }

  return mutations;
}

function lineAndColumn(source, offset) {
  let line = 1;
  let lastNewline = -1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      lastNewline = index;
    }
  }
  return { line, column: offset - lastNewline };
}

/**
 * Rewrites reactive mutations in component script source so they notify the
 * component update dispatcher, inserting `queueUpdate({ name: true })` after
 * each detected statement. Persistent state additionally writes its new
 * value through the runtime persistence helper at the same moment, so the
 * storage write and cross-tab broadcast ride exactly the mutations that
 * already rerender. See scanReactiveMutations() for the detection contract;
 * valid source is never corrupted because unconfident extents pass through
 * untransformed.
 * @param {string} rawScript - The raw JavaScript string from the <script> block.
 * @param {Array<string>} reactiveVars - Reactive variable names.
 * @param {Array<{ name: string, storageKey: string }>} [persistentVars] -
 *   Persistent declarations, mapping the variable name to its storage key.
 * @returns {string} The rewritten JavaScript string.
 */
function interceptAssignments(rawScript, reactiveVars, persistentVars) {
  if (!rawScript || !Array.isArray(reactiveVars) || reactiveVars.length === 0) return rawScript;

  const persistentKeys = new Map();
  for (const persistent of persistentVars || []) {
    persistentKeys.set(persistent.name, persistent.storageKey);
  }

  const mutations = scanReactiveMutations(rawScript, new Set(reactiveVars));
  if (mutations.length === 0) return rawScript;

  let output = rawScript;
  const insertions = mutations.map((mutation) => {
    const storageKey = persistentKeys.get(mutation.name);
    const persistWrite = storageKey === undefined
      ? ''
      : ` __wizzPersistWrite(${JSON.stringify(storageKey)}, ${mutation.name});`;
    return {
      at: mutation.insertAt,
      text: mutation.semicolonTerminated
        ? ` __wizzQueueUpdate({ ${mutation.name}: true });${persistWrite}`
        : `; __wizzQueueUpdate({ ${mutation.name}: true });${persistWrite}`
    };
  });
  insertions.sort((left, right) => right.at - left.at);
  for (const insertion of insertions) {
    output = output.slice(0, insertion.at) + insertion.text + output.slice(insertion.at);
  }
  return output;
}

/**
 * Reports statement-level mutations of the given names without rewriting
 * anything. The component generator uses this to enforce read-only props:
 * any detected mutation of a prop name is a compile-time error.
 * @param {string} rawScript - The raw JavaScript string from the <script> block.
 * @param {Iterable<string>} names - Names whose mutation is an error.
 * @returns {Array<{ name: string, line: number, column: number }>} One entry
 *   per detected mutation, located in the script source.
 */
function findReactiveMutations(rawScript, names) {
  if (!rawScript) return [];
  const nameSet = names instanceof Set ? names : new Set(names || []);
  if (nameSet.size === 0) return [];

  return scanReactiveMutations(rawScript, nameSet).map((mutation) => ({
    name: mutation.name,
    ...lineAndColumn(rawScript, mutation.at)
  }));
}

// Expression-body starts that would change meaning, or stop parsing, once
// the body is moved into statement position: `function`/`class` become
// declarations, and `let [` / `let {` begin a lexical declaration.
// `async function` is a hazard too (checked as a pair where these are used):
// an anonymous one is a SyntaxError in statement position, and a named one
// would become a declaration.
const STATEMENT_HAZARD_STARTS = new Set(['function', 'class', 'let']);

/**
 * Normalizes an inline `on:` directive handler into a form the statement
 * scanner can instrument, or returns null when the handler is not a
 * function literal spanning the whole directive value.
 *
 * - `function (...) { ... }` and block-bodied arrows pass through as-is:
 *   their bodies are already statement contexts, and arrow/function
 *   parameters shadow reactive names exactly as they do in the script.
 * - Expression-bodied arrows (`(e) => name = e.target.value`) are rewritten
 *   to a block body (`(e) => { name = e.target.value }`), turning the body
 *   expression into a statement. The listener's return value is dropped,
 *   which is unobservable: addEventListener ignores listener return values.
 *
 * Anything else — a handler reference (`increment`), a call, a sequence
 * whose first element is an arrow (`(e) => a = 1, b`), or a body that would
 * mean something different as a statement — returns null and is emitted
 * untouched, preserving the scanner's rule of never risking valid source.
 * @param {string} expression - The raw directive value.
 * @returns {string | null} The normalized handler source, or null.
 */
function normalizeHandlerExpression(expression) {
  if (typeof expression !== 'string') return null;
  const tokens = tokenizeScript(expression);
  const significant = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'comment') significant.push(index);
  }
  if (significant.length === 0) return null;
  const at = (position) => tokens[significant[position]];
  const lastToken = at(significant.length - 1);

  // Returns the significant position of the token that closes the bracket
  // opened at `position`, or -1. Template interpolation closes are tracked
  // as `}` so `${ ... }` nests correctly.
  const matchForward = (position) => {
    let depth = 0;
    for (let cursor = position; cursor < significant.length; cursor += 1) {
      const token = at(cursor);
      if (token.type !== 'punctuator') continue;
      if ('([{'.includes(token.value) || token.value === '${') depth += 1;
      else if (')]}'.includes(token.value)) {
        depth -= 1;
        if (depth === 0) return cursor;
      }
    }
    return -1;
  };

  let position = 0;
  const first = at(0);

  if (first.type === 'identifier' && first.value === 'function') {
    // Function expression: the body brace must close at the very end.
    const openParen = significant.findIndex((index, cursor) => cursor > 0 && isPunctuator(tokens[index], '('));
    if (openParen === -1) return null;
    const closeParen = matchForward(openParen);
    if (closeParen === -1 || !isPunctuator(at(closeParen + 1), '{')) return null;
    return matchForward(closeParen + 1) === significant.length - 1 ? expression : null;
  }

  // `async` prefixes an arrow only when it is not itself the parameter.
  if (first.type === 'identifier' && first.value === 'async' && !isPunctuator(at(1), '=>')) position = 1;

  const head = at(position);
  if (!head) return null;
  if (head.type === 'identifier' && (!RESERVED_WORDS.has(head.value) || head.value === 'async')) {
    position += 1;
  } else if (isPunctuator(head, '(')) {
    const close = matchForward(position);
    if (close === -1) return null;
    position = close + 1;
  } else {
    return null;
  }
  if (!isPunctuator(at(position), '=>')) return null;
  position += 1;

  const bodyStart = at(position);
  if (!bodyStart) return null;
  if (isPunctuator(bodyStart, '{')) {
    return matchForward(position) === significant.length - 1 ? expression : null;
  }
  // True when the body starting at `cursor` would change meaning, or stop
  // parsing, as a statement. `async` alone stays an ordinary expression
  // start: `async () => ...` and an identifier named async.
  const statementHazardAt = (cursor) => {
    const token = at(cursor);
    if (!token || token.type !== 'identifier') return false;
    if (STATEMENT_HAZARD_STARTS.has(token.value)) return true;
    const next = at(cursor + 1);
    return token.value === 'async' && Boolean(next) && next.type === 'identifier' && next.value === 'function';
  };
  if (statementHazardAt(position)) return null;

  // Issue #73: `(e) => (name = e.target.value)` is the common way to write
  // an assignment-bodied arrow, and the parentheses put the assignment in
  // expression position, where the scanner (correctly) never rewrites. When
  // parentheses wrap the entire body, the body is their content: unwrap
  // every such pair and use the content as the block's statement. The value
  // of the parenthesized expression is the listener's return value, which
  // addEventListener ignores, so dropping the parentheses is unobservable.
  // Content that would change meaning as a statement stays wrapped: `({`
  // is an object literal (a block or label as a statement), and the
  // statement hazards above would become declarations.
  if (isPunctuator(bodyStart, '(') && matchForward(position) === significant.length - 1) {
    let open = position;
    let closing = significant.length - 1;
    while (isPunctuator(at(open + 1), '(') && matchForward(open + 1) === closing - 1) {
      open += 1;
      closing -= 1;
    }
    const contentFirst = at(open + 1);
    const unwrappable = open + 1 < closing
      && !isPunctuator(contentFirst, '{')
      && !statementHazardAt(open + 1);
    if (unwrappable) {
      const content = expression.slice(at(open).end, at(closing).start);
      const after = expression.slice(lastToken.end);
      const trailingToken = tokens[tokens.length - 1];
      const ending = trailingToken.type === 'comment' && trailingToken.value.startsWith('//') ? '\n}' : ' }';
      return `${expression.slice(0, bodyStart.start)}{ ${content}${after}${ending}`;
    }
  }

  // An arrow's expression body ends at the first top-level comma; anything
  // after it belongs to an enclosing sequence, which a block cannot hold.
  let depth = 0;
  for (let cursor = position; cursor < significant.length; cursor += 1) {
    const token = at(cursor);
    if (token.type !== 'punctuator') continue;
    if ('([{'.includes(token.value) || token.value === '${') depth += 1;
    else if (')]}'.includes(token.value)) depth -= 1;
    else if (depth === 0 && token.value === ',') return null;
  }

  // A trailing line comment would swallow a closing brace on the same line.
  const trailing = tokens[tokens.length - 1];
  const close = trailing.type === 'comment' && trailing.value.startsWith('//') ? '\n}' : ' }';
  return `${expression.slice(0, bodyStart.start)}{ ${expression.slice(bodyStart.start, lastToken.end)}${expression.slice(lastToken.end)}${close}`;
}

/**
 * Instruments an inline `on:` directive handler so mutations inside it
 * notify the update dispatcher, exactly like mutations in script functions.
 * Handlers without a statement-level reactive mutation are returned
 * byte-identical, so existing generated output does not change.
 * @param {string} expression - The raw directive value.
 * @param {Array<string>} reactiveVars - Reactive variable names.
 * @param {Array<{ name: string, storageKey: string }>} [persistentVars]
 * @returns {string} The handler source to emit.
 */
function interceptHandlerExpression(expression, reactiveVars, persistentVars) {
  const normalized = normalizeHandlerExpression(expression);
  if (normalized === null) return expression;
  const intercepted = interceptAssignments(normalized, reactiveVars, persistentVars);
  return intercepted === normalized ? expression : intercepted;
}

/**
 * The inline-handler counterpart of findReactiveMutations(): reports the
 * statement-level mutations of `names` an instrumented handler would carry.
 * Locations are relative to the handler source.
 */
function findHandlerMutations(expression, names) {
  const normalized = normalizeHandlerExpression(expression);
  return normalized === null ? [] : findReactiveMutations(normalized, names);
}

/**
 * Reports mutations of reactive names that the rewriter leaves untracked
 * (issue #73): assignments in expression position, unbraced control-flow
 * bodies, chained targets. Each one changes state without scheduling an
 * update, so the DOM silently goes stale.
 * @param {string} source - Script or handler source.
 * @param {Iterable<string>} names - Reactive names.
 * @returns {Array<{ name: string, line: number, column: number }>} Located
 *   relative to `source`.
 */
function findUntrackedMutations(source, names) {
  if (!source) return [];
  const nameSet = names instanceof Set ? names : new Set(names || []);
  if (nameSet.size === 0) return [];
  const skipped = [];
  scanReactiveMutations(source, nameSet, skipped);
  const locations = locateAscending(source, skipped);
  return skipped.map((site, index) => ({ name: site.name, ...locations[index] }));
}

/**
 * The inline-handler counterpart of findUntrackedMutations(): scans the
 * handler in the form the rewriter instruments (an expression-bodied arrow
 * becomes a block), so it reports exactly what interception leaves behind.
 */
function findUntrackedHandlerMutations(expression, names) {
  if (typeof expression !== 'string') return [];
  const normalized = normalizeHandlerExpression(expression);
  if (normalized !== null) return findUntrackedMutations(normalized, names).map(({ name }) => ({ name }));
  // A value that is not a function literal (`on:click={count = 1}`) is
  // emitted untouched: even its statement-level mutations are untracked, and
  // they run once, when the listener value is evaluated at mount.
  return [...findReactiveMutations(expression, names), ...findUntrackedMutations(expression, names)]
    .map(({ name }) => ({ name }));
}

/**
 * Reports statement-level calls of in-place array methods (`push`, `pop`,
 * `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, `copyWithin`) on
 * reactive names that no update follows (milestone 26): no mutation of the
 * same name — a reassignment such as `items = items`, a member write, or an
 * update operator, tracked or not — appears after the call before the
 * outermost function enclosing it closes. Later code in a nested callback
 * counts, so `items.push(x); setTimeout(() => { items = items; })` is quiet.
 * The analysis is syntactic and conservative: aliases (`const a = items;
 * a.push(x)`), computed member names (`items['push'](x)`), calls in
 * expression position or unbraced control-flow bodies, and Map/Set methods
 * are not reported.
 * @param {string} source - Script or handler source.
 * @param {Iterable<string>} names - Reactive names.
 * @returns {Array<{ name: string, method: string, line: number, column: number }>}
 *   Located relative to `source`, in source order.
 */
function findInPlaceMutations(source, names) {
  return findUnscheduledChanges(source, names).inPlace;
}

// Line/column for ascending offsets in one pass (lineAndColumn() per site
// would rescan the source from the start each time).
function locateAscending(source, sites) {
  let line = 1;
  let lastNewline = -1;
  let cursor = 0;
  return sites.map((site) => {
    for (; cursor < site.at; cursor += 1) {
      if (source[cursor] === '\n') {
        line += 1;
        lastNewline = cursor;
      }
    }
    return { line, column: site.at - lastNewline };
  });
}

/**
 * One scan serving both warnings: the untracked mutations of
 * findUntrackedMutations() and the in-place calls of findInPlaceMutations(),
 * each located relative to `source` and in source order.
 * @param {string} source - Script or handler source.
 * @param {Iterable<string>} names - Reactive names.
 * @returns {{ untracked: Array<{ name, line, column }>, inPlace: Array<{ name, method, line, column }> }}
 */
function findUnscheduledChanges(source, names) {
  const none = { untracked: [], inPlace: [] };
  if (!source) return none;
  const nameSet = names instanceof Set ? names : new Set(names || []);
  if (nameSet.size === 0) return none;
  const skipped = [];
  const calls = [];
  const mutations = scanReactiveMutations(source, nameSet, skipped, calls);

  let reported = calls;
  if (calls.length > 0) {
    // Per-name ascending mutation offsets, so each call needs one binary
    // search for the first mutation after it (linear in calls and
    // mutations, never their product).
    const offsets = new Map();
    for (const mutation of [...mutations, ...skipped]) {
      if (!offsets.has(mutation.name)) offsets.set(mutation.name, []);
      offsets.get(mutation.name).push(mutation.at);
    }
    for (const list of offsets.values()) list.sort((left, right) => left - right);
    reported = calls.filter((call) => {
      const list = offsets.get(call.name);
      if (!list) return true;
      let low = 0;
      let high = list.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (list[middle] <= call.at) low = middle + 1;
        else high = middle;
      }
      return low === list.length || list[low] >= call.scope.end;
    });
  }

  const untrackedLocations = locateAscending(source, skipped);
  const inPlaceLocations = locateAscending(source, reported);
  return {
    untracked: skipped.map((site, index) => ({ name: site.name, ...untrackedLocations[index] })),
    inPlace: reported.map((call, index) => ({ name: call.name, method: call.method, ...inPlaceLocations[index] }))
  };
}

/**
 * The inline-handler counterpart of findInPlaceMutations(), scanning the
 * handler in its instrumented (block-bodied) form. A handler value that is
 * not a function literal is skipped.
 */
function findInPlaceHandlerMutations(expression, names) {
  const normalized = normalizeHandlerExpression(expression);
  if (normalized === null) return [];
  return findInPlaceMutations(normalized, names).map(({ name, method }) => ({ name, method }));
}

module.exports = {
  findUnscheduledChanges,
  findInPlaceMutations,
  findInPlaceHandlerMutations,
  findUntrackedMutations,
  findUntrackedHandlerMutations,
  collectDeclaredNames,
  interceptAssignments,
  findReactiveMutations,
  interceptHandlerExpression,
  findHandlerMutations,
  normalizeHandlerExpression
};
