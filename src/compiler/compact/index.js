// Production compaction for `wizz build --compact` (milestone 23): hand-rolled,
// zero-dependency, and deliberately conservative. Each compactor removes only
// comments and insignificant whitespace — no mangling or semantic rewrites —
// and throws a located SyntaxError (`line`/`column` fields) on malformed
// input instead of emitting corrupted output. See each module's header for
// its exact rules.
const { compactJs, validateJs } = require('./jsCompactor');
const { compactCss } = require('./cssCompactor');
const { compactHtml } = require('./htmlCompactor');

module.exports = { compactJs, validateJs, compactCss, compactHtml };
