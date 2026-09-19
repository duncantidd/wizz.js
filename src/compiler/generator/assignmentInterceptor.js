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

// Keywords that open a variable declaration and shadow component state for
// their scope, so mutations of the declared name are left alone.
const DECLARATION_KEYWORDS = new Set(['let', 'const', 'var']);

/**
 * Collects the binding names declared by a `let`/`const`/`var` statement,
 * including destructuring patterns (`let { a, b } = obj;`) and comma-separated
 * declarators, stopping at the statement's terminating `;` or a for-loop
 * `of`/`in` keyword. Initializer expressions are skipped so their identifiers
 * are never mistaken for bindings.
 * @returns {{ names: string[], endIndex: number }} The declared names and the
 *   token index where scanning stopped.
 */
function collectDeclaredNames(tokens, keywordIndex) {
  const names = [];
  let phase = 'pattern';
  let depth = 0;
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
        index += 1;
        continue;
      }
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

    if (token.type === 'identifier' && phase === 'pattern') names.push(token.value);
    index += 1;
  }

  return { names, endIndex: index };
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
 * @param {string} rawScript - The raw JavaScript string from the <script> block.
 * @param {Set<string>} reactiveNames - Reactive variable names.
 * @returns {Array<{ name: string, at: number, insertAt: number, semicolonTerminated: boolean, nextIndex: number }>}
 *   One record per detected mutation; `at` is the offset of the mutating
 *   token, the rest describe where a notification insertion would go.
 */
function scanReactiveMutations(rawScript, reactiveNames) {
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

    if (detectionAllowed && isStatementContext()) {
      const mutation = detectMutation(index);
      if (mutation) {
        mutations.push(mutation);
        if (mutation.nextIndex > index) resumeStatementStartAt = mutation.nextIndex;
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
          const { names } = collectDeclaredNames(tokens, index);
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
      contexts.push({ type: token.value === '(' ? 'paren' : 'bracket' });
      atStatementStart = false;
      continue;
    }

    if (token.value === ')' || token.value === ']') {
      if (contexts.length > 1) contexts.pop();
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
      pendingDeclared.length = 0;
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
        ? ` queueUpdate({ ${mutation.name}: true });${persistWrite}`
        : `; queueUpdate({ ${mutation.name}: true });${persistWrite}`
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

module.exports = { interceptAssignments, findReactiveMutations };
