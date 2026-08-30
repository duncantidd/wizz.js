const { tokenizeScript, matchTemplateTokens } = require('./scriptLexer');

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
function interceptAssignments(rawScript, reactiveVars) {
  if (!rawScript || !Array.isArray(reactiveVars) || reactiveVars.length === 0) return rawScript;

  const reactiveNames = new Set(reactiveVars);
  const tokens = tokenizeScript(rawScript);
  const templatePairs = matchTemplateTokens(tokens);
  const insertions = [];
  const contexts = [{ type: 'top' }];
  const shadowedDepths = new Map();
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

  const buildMutation = (extent, name) => {
    const notification = `queueUpdate({ ${name}: true });`;
    return {
      insertion: {
        at: extent.insertAt,
        text: extent.semicolonTerminated ? ` ${notification}` : `; ${notification}`
      },
      resumeAt: extent.semicolonTerminated ? -1 : extent.nextIndex
    };
  };

  const detectMutation = (index) => {
    const token = tokens[index];

    // Prefix update: ++count; --count;
    if (token.type === 'punctuator' && UPDATE_OPERATORS.has(token.value)) {
      const targetIndex = nextSignificantIndex(tokens, index + 1);
      const target = tokens[targetIndex];
      if (!target || target.type !== 'identifier' || !reactiveNames.has(target.value) || isShadowed(target.value)) return null;
      const extent = findStatementExtent(tokens, targetIndex, templatePairs);
      return extent ? buildMutation(extent, target.value) : null;
    }

    if (token.type !== 'identifier' || !reactiveNames.has(token.value) || isShadowed(token.value)) return null;

    const operatorIndex = nextSignificantIndex(tokens, index + 1);
    const operatorToken = tokens[operatorIndex];

    // Direct assignment: count = 1; count += 1;
    if (operatorToken && operatorToken.type === 'punctuator' && ASSIGNMENT_OPERATORS.has(operatorToken.value)) {
      const extent = findStatementExtent(tokens, operatorIndex + 1, templatePairs);
      return extent ? buildMutation(extent, token.value) : null;
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
      return extent ? buildMutation(extent, token.value) : null;
    }

    // Postfix update: count++; --total;
    if (operatorToken && operatorToken.type === 'punctuator' && UPDATE_OPERATORS.has(operatorToken.value)
      && !operatorToken.newlineBefore) {
      const extent = findStatementExtent(tokens, index, templatePairs);
      return extent ? buildMutation(extent, token.value) : null;
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
        insertions.push(mutation.insertion);
        if (mutation.resumeAt > index) resumeStatementStartAt = mutation.resumeAt;
      }
    }

    previousToken = token;

    if (token.type !== 'punctuator') {
      if (token.type === 'identifier') {
        if (token.value === 'switch') switchPending = true;
        if (token.value === 'class') classPending = true;
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
      atStatementStart = true;
      continue;
    }

    if (token.value === '}') {
      if (contexts.length > 1) {
        const closing = contexts.pop();
        if (closing.parameters) popShadowed(closing.parameters);
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
      continue;
    }

    atStatementStart = false;
  }

  if (insertions.length === 0) return rawScript;

  let output = rawScript;
  insertions.sort((left, right) => right.at - left.at);
  for (const insertion of insertions) {
    output = output.slice(0, insertion.at) + insertion.text + output.slice(insertion.at);
  }
  return output;
}

module.exports = { interceptAssignments };
