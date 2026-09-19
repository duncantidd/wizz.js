// Stable diagnostic codes for the compiler's author-facing failures.
//
// Every SyntaxError a compile can throw is assigned one code from this
// catalog at its throw site via compilerDiagnostic(). The codes are the
// machine-readable contract for downstream tooling (the VS Code extension,
// the JSON diagnostics surface, the future MCP server): the prose message
// may be reworded freely, but a code's meaning never changes, and a code is
// never reused for a different condition. The same author-facing condition
// detected at several throw sites — or by several generation targets —
// shares one code.
//
// Formats: `WIZZ-P###` (parse), `WIZZ-A###` (analyze), `WIZZ-G###`
// (generate). Codes are assigned in pipeline order, never renumbered. The
// analyze stage currently emits no author-facing diagnostics; its namespace
// is reserved. Programmatic TypeError guards (API misuse such as a
// non-string source) deliberately carry no code: they never surface as
// author diagnostics. version.test.js pins the shape of this catalog.
const CODES = Object.freeze({
  parser: Object.freeze({
    tokenizerError: 'WIZZ-P001',
    eachBlockSyntax: 'WIZZ-P002',
    unexpectedEachEnd: 'WIZZ-P003',
    unexpectedIfEnd: 'WIZZ-P004',
    unexpectedElse: 'WIZZ-P005',
    titleDisallowedChild: 'WIZZ-P006',
    headDisallowedChild: 'WIZZ-P007',
    styleDisallowedChild: 'WIZZ-P008',
    headBlockAttributes: 'WIZZ-P009',
    headBlockNested: 'WIZZ-P010',
    styleBlockAttributes: 'WIZZ-P011',
    styleBlockNested: 'WIZZ-P012',
    duplicateHeadBlock: 'WIZZ-P013',
    duplicateStyleBlock: 'WIZZ-P014',
    headBlockDirective: 'WIZZ-P015',
    headBlockExpression: 'WIZZ-P016',
    styleBlockExpression: 'WIZZ-P017',
    mismatchedClosingTag: 'WIZZ-P018',
    headOnlyHeadElements: 'WIZZ-P019',
    plainStyleBlock: 'WIZZ-P020',
    voidClosingTag: 'WIZZ-P021',
    unclosedTag: 'WIZZ-P022',
    unexpectedClosingTag: 'WIZZ-P023',
    unsupportedTokenType: 'WIZZ-P024',
    unclosedExpressionString: 'WIZZ-P025',
    unexpectedExpressionCharacter: 'WIZZ-P026',
    unparseableStartingToken: 'WIZZ-P027',
    expectedClosingParen: 'WIZZ-P028',
    expectedPropertyAfterDot: 'WIZZ-P029',
    unexpectedExpressionToken: 'WIZZ-P030',
    conditionalExpressionMissing: 'WIZZ-P031',
    dynamicAttributeMissingExpression: 'WIZZ-P032',
    templateExpressionError: 'WIZZ-P033',
    invalidPropName: 'WIZZ-P034',
    reservedPropPrefix: 'WIZZ-P035',
    exportLetMissingName: 'WIZZ-P036',
    exportNotTopLevel: 'WIZZ-P037',
    onePropPerExportLet: 'WIZZ-P038',
    invalidPropDeclaration: 'WIZZ-P039',
    duplicateProp: 'WIZZ-P040',
    propMissingValue: 'WIZZ-P041',
    propMissingSemicolon: 'WIZZ-P042',
    unsupportedExportSyntax: 'WIZZ-P043',
    persistOnProp: 'WIZZ-P044',
    persistOnConst: 'WIZZ-P045',
    persistNotTopLevel: 'WIZZ-P046',
    persistTrailingStatements: 'WIZZ-P047',
    persistMissingArguments: 'WIZZ-P048',
    persistExtraArguments: 'WIZZ-P049',
    persistKeyNotStringLiteral: 'WIZZ-P050',
    persistNested: 'WIZZ-P051',
    persistCallUnparseable: 'WIZZ-P052'
  }),
  // Reserved for the analyze stage; no author-facing analyze diagnostics
  // exist today (dependency analysis and ID assignment cannot fail on
  // valid parser output).
  analyzer: Object.freeze({}),
  generator: Object.freeze({
    missingRootElement: 'WIZZ-G001',
    eachOutsideElement: 'WIZZ-G002',
    eachRootCount: 'WIZZ-G003',
    componentInsideEach: 'WIZZ-G004',
    eachBodyUnsupported: 'WIZZ-G005',
    eventInsideEach: 'WIZZ-G006',
    propAttributeNameInvalid: 'WIZZ-G007',
    componentChildrenUnsupported: 'WIZZ-G008',
    missingComponentId: 'WIZZ-G009',
    componentOutsideElement: 'WIZZ-G010',
    eventOnComponent: 'WIZZ-G011',
    eventMissingHandler: 'WIZZ-G012',
    invalidEventDirective: 'WIZZ-G013',
    titleDisallowedChild: 'WIZZ-G014',
    propAssignment: 'WIZZ-G015',
    serverImportLines: 'WIZZ-G016',
    reactiveNameInServer: 'WIZZ-G017',
    serverUnsupportedNode: 'WIZZ-G018',
    serverUnsupportedHeadNode: 'WIZZ-G019',
    serverUnsupportedComponent: 'WIZZ-G020',
    voidWithChildren: 'WIZZ-G021',
    hydrationUnsupportedNode: 'WIZZ-G022',
    hydrationEachUnsupportedNode: 'WIZZ-G023',
    persistSpanDrift: 'WIZZ-G024'
  })
});

const DIAGNOSTIC_CODE_PATTERN = /^WIZZ-[PG]\d{3}$/;

/**
 * Creates a compiler diagnostic carrying its stable catalog code. The error
 * type is preserved (SyntaxError by default, matching every existing throw
 * site) and the message is passed through untouched — the code is additive.
 * @param {string} code - A code from the CODES catalog.
 * @param {string} message - The human-facing prose, unchanged.
 * @param {typeof Error} [ErrorConstructor] - Error type, SyntaxError default.
 * @returns {Error} The diagnostic to throw.
 */
function compilerDiagnostic(code, message, ErrorConstructor = SyntaxError) {
  const error = new ErrorConstructor(message);
  error.code = code;
  return error;
}

module.exports = { CODES, DIAGNOSTIC_CODE_PATTERN, compilerDiagnostic };
